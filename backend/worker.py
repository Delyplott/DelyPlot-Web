from __future__ import annotations

import os
import time
import json
import base64
import tempfile
import traceback
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore

from delyplot.coverage import analyze_file
from delyplot.quote import calculate_quote
from delyplot.preview import generate_preview_pdf

load_dotenv()

# =========================
# ENV (blindado)
# =========================
GOOGLE_APPLICATION_CREDENTIALS = (os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "") or "").strip()
APPS_SCRIPT_URL = (os.environ.get("APPS_SCRIPT_URL", "") or "").strip()
WORKER_SECRET = (os.environ.get("WORKER_SECRET", "") or "").strip()
WORKER_ID = (os.environ.get("WORKER_ID", "worker-local-1") or "").strip()

# Modo GitHub Actions (run and exit)
RUN_ONCE = os.getenv("RUN_ONCE", "0") == "1"

# Opcional: forzar un pedido específico (NO requerido para automático)
ORDER_ID = (os.getenv("ORDER_ID", "") or "").strip() or None
ORDER_WAIT_SECS = float(os.getenv("ORDER_WAIT_SECS", "25"))

# Ventana de ejecución en RUN_ONCE (segundos): durante este tiempo hace polling de la cola
# Recomendado: 210-260 para no chocar con timeout del job.
RUN_WINDOW_SECS = float(os.getenv("RUN_WINDOW_SECS", "240"))

# Polling rápido de la cola (segundos)
POLL_SECS = float(os.getenv("POLL_SECS", "5"))

# Máximo de pedidos a tomar por iteración
BATCH_LIMIT = int(os.getenv("BATCH_LIMIT", "5"))

# Timeout requests al Apps Script
BRIDGE_TIMEOUT_SECS = float(os.getenv("BRIDGE_TIMEOUT_SECS", "120"))

# =========================
# Validaciones
# =========================
if not GOOGLE_APPLICATION_CREDENTIALS or not os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
  raise RuntimeError("Falta GOOGLE_APPLICATION_CREDENTIALS o no existe el archivo.")
if not APPS_SCRIPT_URL:
  raise RuntimeError("Falta APPS_SCRIPT_URL.")
if not WORKER_SECRET:
  raise RuntimeError("Falta WORKER_SECRET.")

# Evitar %0A / whitespace oculto en URL
if any(ch.isspace() for ch in APPS_SCRIPT_URL):
  raise RuntimeError(f"APPS_SCRIPT_URL contiene whitespace invisible. repr={APPS_SCRIPT_URL!r}")

cred = credentials.Certificate(GOOGLE_APPLICATION_CREDENTIALS)
firebase_admin.initialize_app(cred)
db = firestore.client()


# =========================
# Bridge Apps Script
# =========================
def bridge_post(payload: Dict[str, Any]) -> Dict[str, Any]:
  """
  Llama al Apps Script bridge via doPost.
  body: form-encoded { payload: "<json>" }
  Retorna dict JSON y valida ok=true.
  """
  body = {"payload": json.dumps(payload)}
  r = requests.post(APPS_SCRIPT_URL, data=body, timeout=BRIDGE_TIMEOUT_SECS)
  r.raise_for_status()
  data = r.json()
  if not data.get("ok"):
    raise RuntimeError(data.get("error") or "Bridge error")
  return data


# =========================
# Claim atómico
# =========================
@firestore.transactional
def claim_order(tx: firestore.Transaction, doc_ref: firestore.DocumentReference) -> bool:
  """
  Claim atómico: uploaded -> in_progress.
  Evita doble procesamiento.
  """
  snap = doc_ref.get(transaction=tx)
  if not snap.exists:
    return False
  data = snap.to_dict() or {}
  if data.get("status") != "uploaded":
    return False

  tx.update(doc_ref, {
    "status": "in_progress",
    "worker": {"claimedAt": firestore.SERVER_TIMESTAMP, "claimedBy": WORKER_ID},
    "updatedAt": firestore.SERVER_TIMESTAMP
  })
  return True


def _pick_filename_from_download(down: Dict[str, Any]) -> str:
  return (down.get("filename") or down.get("name") or "input.pdf")


def _safe_update_status(doc_ref: firestore.DocumentReference, status: str, extra: Optional[Dict[str, Any]] = None) -> None:
  payload: Dict[str, Any] = {
    "status": status,
    "updatedAt": firestore.SERVER_TIMESTAMP
  }
  if extra:
    payload.update(extra)
  doc_ref.update(payload)


# =========================
# Procesamiento
# =========================
def process_order(order_id: str, order: Dict[str, Any]) -> None:
  doc_ref = db.collection("orders").document(order_id)

  file_info = (order.get("file") or {})
  drive_file_id = file_info.get("driveFileId")
  if not drive_file_id:
    raise RuntimeError("Order sin file.driveFileId (aún no subido o incompleto).")

  # 1) Download original (base64)
  down = bridge_post({
    "action": "download",
    "secret": WORKER_SECRET,
    "fileId": drive_file_id
  })

  filename = _pick_filename_from_download(down)
  raw_b64 = down.get("base64") or ""
  if not raw_b64:
    raise RuntimeError("Download sin base64 (respuesta inválida del bridge).")

  raw = base64.b64decode(raw_b64)

  with tempfile.TemporaryDirectory() as td:
    in_path = os.path.join(td, filename)
    with open(in_path, "wb") as f:
      f.write(raw)

    # 2) Analyze
    analysis = analyze_file(in_path)

    # 3) Preview PDF
    preview_path = os.path.join(td, "preview.pdf")
    generate_preview_pdf(in_path, preview_path, order_id=order_id, analysis=analysis)

    with open(preview_path, "rb") as f:
      preview_b64 = base64.b64encode(f.read()).decode("ascii")

    up = bridge_post({
      "action": "uploadPreview",
      "secret": WORKER_SECRET,
      "orderId": order_id,
      "filename": f"preview_{order_id}.pdf",
      "contentType": "application/pdf",
      "base64": preview_b64
    })

    preview = {
      "provider": "drive",
      "driveFileId": up.get("previewFileId"),
      "url": up.get("url"),
      "contentType": "application/pdf"
    }

    # 4) Quote
    quote = calculate_quote(order, analysis)

    # 5) Write back
    doc_ref.update({
      "analysis": analysis,
      "preview": preview,
      "quote": quote,
      "status": "quoted",
      "updatedAt": firestore.SERVER_TIMESTAMP
    })


# =========================
# Fetch de cola
# =========================
def _fetch_order_by_id(order_id: str) -> Optional[firestore.DocumentSnapshot]:
  ref = db.collection("orders").document(order_id)
  deadline = time.time() + ORDER_WAIT_SECS
  while True:
    snap = ref.get()
    if snap.exists:
      return snap
    if time.time() >= deadline:
      return None
    time.sleep(1.0)


def _fetch_uploaded_batch(limit: int) -> List[firestore.DocumentSnapshot]:
  q = (
    db.collection("orders")
      .where("status", "==", "uploaded")
      .order_by("createdAt")
      .limit(limit)
  )
  return list(q.stream())


# =========================
# Loop principal
# =========================
def main_loop() -> None:
  start = time.time()
  mode = "RUN_ONCE" if RUN_ONCE else "DAEMON"
  tgt = f"ORDER_ID={ORDER_ID}" if ORDER_ID else "QUEUE(auto)"
  print(f"Worker started. mode={mode} target={tgt}")
  print(f"APPS_SCRIPT_URL={APPS_SCRIPT_URL!r}")
  print(f"RUN_WINDOW_SECS={RUN_WINDOW_SECS} POLL_SECS={POLL_SECS} BATCH_LIMIT={BATCH_LIMIT}")

  consecutive_empty = 0

  while True:
    # En RUN_ONCE, nos auto-cerramos pasado RUN_WINDOW_SECS
    if RUN_ONCE and (time.time() - start) >= RUN_WINDOW_SECS:
      print("RUN_ONCE window elapsed. Exiting.")
      return

    try:
      docs: List[firestore.DocumentSnapshot] = []

      if ORDER_ID:
        snap = _fetch_order_by_id(ORDER_ID)
        if not snap:
          print(f"ORDER_ID={ORDER_ID} no existe tras {ORDER_WAIT_SECS}s. Saliendo.")
          return
        docs = [snap]
      else:
        docs = _fetch_uploaded_batch(BATCH_LIMIT)

      if not docs:
        consecutive_empty += 1
        # backoff muy suave, pero manteniendo fluidez
        sleep_s = min(POLL_SECS + (consecutive_empty * 0.2), 8.0) if RUN_ONCE else min(POLL_SECS + (consecutive_empty * 0.5), 15.0)
        time.sleep(sleep_s)
        continue

      consecutive_empty = 0

      for d in docs:
        doc_ref = d.reference

        # Claim
        tx = db.transaction()
        claimed = claim_order(tx, doc_ref)

        # Si veníamos por ORDER_ID y aún no está uploaded, esperamos un poco (RUN_ONCE)
        if ORDER_ID and not claimed:
          if RUN_ONCE:
            deadline = time.time() + ORDER_WAIT_SECS
            while time.time() < deadline:
              snap2 = doc_ref.get()
              if snap2.exists and (snap2.to_dict() or {}).get("status") == "uploaded":
                tx2 = db.transaction()
                if claim_order(tx2, doc_ref):
                  d = snap2
                  break
              time.sleep(1.0)
            else:
              print(f"ORDER_ID={ORDER_ID} no llegó a status=uploaded en {ORDER_WAIT_SECS}s. Saliendo.")
              return
          else:
            continue

        order = d.to_dict() or {}
        print(f"Processing order {d.id}...")
        try:
          # (opcional) marcar actividad
          _safe_update_status(doc_ref, "in_progress")

          process_order(d.id, order)
          print(f"Order {d.id} -> quoted")
        except Exception as ex:
          print(f"Order {d.id} error: {ex}")
          doc_ref.update({
            "status": "error",
            "error": {"message": str(ex), "trace": traceback.format_exc()},
            "updatedAt": firestore.SERVER_TIMESTAMP
          })

      # En RUN_ONCE queremos seguir procesando más pedidos dentro de la ventana,
      # así que NO salimos inmediatamente.
      if ORDER_ID and RUN_ONCE:
        # si fue un pedido específico, ya está
        return

    except Exception as e:
      print("Loop error:", e)
      if RUN_ONCE:
        raise
      time.sleep(3.0)


if __name__ == "__main__":
  main_loop()
