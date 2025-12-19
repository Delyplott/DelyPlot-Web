from __future__ import annotations

import os
import time
import json
import base64
import tempfile
import traceback
from typing import Any, Dict, List, Optional

import requests
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore

from delyplot.coverage import analyze_file
from delyplot.quote import calculate_quote
from delyplot.preview import generate_preview_pdf

load_dotenv()

# ✅ Blindaje: strip() para evitar %0A / espacios invisibles en secrets
GOOGLE_APPLICATION_CREDENTIALS = (os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "") or "").strip()
APPS_SCRIPT_URL = (os.environ.get("APPS_SCRIPT_URL", "") or "").strip()
WORKER_SECRET = (os.environ.get("WORKER_SECRET", "") or "").strip()
WORKER_ID = (os.environ.get("WORKER_ID", "worker-gha-1") or "").strip()

# Modes
RUN_ONCE = os.getenv("RUN_ONCE", "0") == "1"
ORDER_ID = (os.getenv("ORDER_ID", "") or "").strip() or None

# ✅ Fluidez
RUN_WINDOW_SECS = float(os.getenv("RUN_WINDOW_SECS", "240"))  # ventana del job en Actions
POLL_SECS = float(os.getenv("POLL_SECS", "4"))                # polling rápido
BATCH_LIMIT = int(os.getenv("BATCH_LIMIT", "5"))

# Si se usa ORDER_ID, espera breve a que aparezca / pase a uploaded
ORDER_WAIT_SECS = float(os.getenv("ORDER_WAIT_SECS", "10"))

# ✅ Validaciones duras
if not GOOGLE_APPLICATION_CREDENTIALS or not os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
  raise RuntimeError("Falta GOOGLE_APPLICATION_CREDENTIALS o no existe el archivo.")
if not APPS_SCRIPT_URL:
  raise RuntimeError("Falta APPS_SCRIPT_URL.")
if not WORKER_SECRET:
  raise RuntimeError("Falta WORKER_SECRET.")
if any(ch.isspace() for ch in APPS_SCRIPT_URL):
  raise RuntimeError(f"APPS_SCRIPT_URL contiene whitespace invisible. repr={APPS_SCRIPT_URL!r}")

cred = credentials.Certificate(GOOGLE_APPLICATION_CREDENTIALS)
firebase_admin.initialize_app(cred)
db = firestore.client()

def bridge_post(payload: Dict[str, Any]) -> Dict[str, Any]:
  body = {"payload": json.dumps(payload)}
  r = requests.post(APPS_SCRIPT_URL, data=body, timeout=120)
  r.raise_for_status()
  data = r.json()
  if not data.get("ok"):
    raise RuntimeError(data.get("error") or "Bridge error")
  return data

@firestore.transactional
def claim_order(tx: firestore.Transaction, doc_ref: firestore.DocumentReference) -> bool:
  snap = doc_ref.get(transaction=tx)
  if not snap.exists:
    return False
  data = snap.to_dict() or {}
  if data.get("status") != "uploaded":
    return False

  tx.update(doc_ref, {
    "status": "in_progress",
    "worker": {
      "claimedAt": firestore.SERVER_TIMESTAMP,
      "claimedBy": WORKER_ID
    },
    "updatedAt": firestore.SERVER_TIMESTAMP
  })
  return True

def _pick_filename_from_download(down: Dict[str, Any]) -> str:
  return (down.get("filename") or down.get("name") or "input.pdf")

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

def _fetch_by_order_id(order_id: str) -> List[firestore.DocumentSnapshot]:
  ref = db.collection("orders").document(order_id)
  deadline = time.time() + ORDER_WAIT_SECS
  while True:
    snap = ref.get()
    if snap.exists:
      return [snap]
    if time.time() >= deadline:
      print(f"ORDER_ID={order_id} no existe tras {ORDER_WAIT_SECS}s.")
      return []
    time.sleep(1.0)

def _fetch_queue() -> List[firestore.DocumentSnapshot]:
  # Intento con order_by (más “justo” por createdAt)
  try:
    q = (
      db.collection("orders")
      .where("status", "==", "uploaded")
      .order_by("createdAt")
      .limit(BATCH_LIMIT)
    )
    return list(q.stream())
  except Exception as e:
    # Fallback sin order_by (evita caída por índices)
    print(f"[WARN] Query/index error, fallback sin order_by: {e}")
    q2 = (
      db.collection("orders")
      .where("status", "==", "uploaded")
      .limit(BATCH_LIMIT)
    )
    return list(q2.stream())

def _fetch_target_docs() -> List[firestore.DocumentSnapshot]:
  if ORDER_ID:
    return _fetch_by_order_id(ORDER_ID)
  return _fetch_queue()

def main_loop():
  mode = "RUN_ONCE" if RUN_ONCE else "DAEMON"
  tgt = f"ORDER_ID={ORDER_ID}" if ORDER_ID else "QUEUE"
  print(f"Worker started. mode={mode} target={tgt}")
  print(f"APPS_SCRIPT_URL={APPS_SCRIPT_URL!r}")

  run_deadline: Optional[float] = None
  if RUN_ONCE:
    run_deadline = time.time() + RUN_WINDOW_SECS

  while True:
    try:
      docs = _fetch_target_docs()

      if not docs:
        if RUN_ONCE:
          if run_deadline is not None and time.time() >= run_deadline:
            print("RUN_ONCE window ended. Exiting.")
            return
          time.sleep(POLL_SECS)
          continue
        time.sleep(POLL_SECS)
        continue

      for d in docs:
        doc_ref = d.reference
        tx = db.transaction()

        claimed = claim_order(tx, doc_ref)
        if not claimed:
          continue

        order = d.to_dict() or {}
        print(f"Processing order {d.id}...")
        try:
          process_order(d.id, order)
          print(f"Order {d.id} -> quoted")
        except Exception as ex:
          print(f"Order {d.id} error: {ex}")
          doc_ref.update({
            "status": "error",
            "error": {"message": str(ex), "trace": traceback.format_exc()},
            "updatedAt": firestore.SERVER_TIMESTAMP
          })

      if RUN_ONCE:
        # seguimos dentro de la ventana para tomar más pedidos si alcanzan a llegar
        if run_deadline is not None and time.time() >= run_deadline:
          print("RUN_ONCE window ended after processing. Exiting.")
          return
        time.sleep(1.0)

    except Exception as e:
      print("Loop error:", e)
      if RUN_ONCE:
        raise
      time.sleep(POLL_SECS)

if __name__ == "__main__":
  main_loop()
