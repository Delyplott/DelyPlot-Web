from __future__ import annotations
import os
import time
import json
import base64
import tempfile
import traceback
from typing import Any, Dict

import requests
from dotenv import load_dotenv

import firebase_admin
from firebase_admin import credentials, firestore

from delyplot.coverage import analyze_file
from delyplot.quote import calculate_quote
from delyplot.preview import generate_preview_pdf

load_dotenv()

GOOGLE_APPLICATION_CREDENTIALS = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL", "")
WORKER_SECRET = os.environ.get("WORKER_SECRET", "")
WORKER_ID = os.environ.get("WORKER_ID", "worker-local-1")

if not GOOGLE_APPLICATION_CREDENTIALS or not os.path.exists(GOOGLE_APPLICATION_CREDENTIALS):
  raise RuntimeError("Falta GOOGLE_APPLICATION_CREDENTIALS o no existe el archivo.")
if not APPS_SCRIPT_URL:
  raise RuntimeError("Falta APPS_SCRIPT_URL.")
if not WORKER_SECRET:
  raise RuntimeError("Falta WORKER_SECRET.")

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

def process_order(order_id: str, order: Dict[str, Any]) -> None:
  doc_ref = db.collection("orders").document(order_id)

  file_info = (order.get("file") or {})
  drive_file_id = file_info.get("driveFileId")
  if not drive_file_id:
    raise RuntimeError("Order sin file.driveFileId (aún no subido o incompleto).")

  # 1) Download original
  down = bridge_post({
    "action": "download",
    "secret": WORKER_SECRET,
    "fileId": drive_file_id
  })

  filename = down.get("filename", "input.pdf")
  content_type = down.get("contentType", "application/octet-stream")
  raw = base64.b64decode(down.get("base64") or "")

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

    # 4) Official quote
    quote = calculate_quote(order, analysis)

    # 5) Write back
    doc_ref.update({
      "analysis": analysis,
      "preview": preview,
      "quote": quote,
      "status": "quoted",
      "updatedAt": firestore.SERVER_TIMESTAMP
    })

def main_loop():
  print("Worker started. Listening for orders with status=uploaded")
  while True:
    try:
      q = (
        db.collection("orders")
        .where("status", "==", "uploaded")
        .order_by("createdAt")
        .limit(5)
      )
      docs = list(q.stream())
      if not docs:
        time.sleep(2.5)
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

    except Exception as e:
      print("Loop error:", e)
      time.sleep(3.0)

if __name__ == "__main__":
  main_loop()
