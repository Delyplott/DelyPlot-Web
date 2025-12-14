from __future__ import annotations
import os
import tempfile
from flask import Flask, jsonify, request, send_file

from delyplot.coverage import analyze_file
from delyplot.quote import calculate_quote
from delyplot.preview import generate_preview_pdf

app = Flask(__name__)

@app.get("/health")
def health():
  return jsonify({"ok": True})

@app.post("/analyze")
def analyze():
  f = request.files.get("file")
  if not f:
    return jsonify({"ok": False, "error": "Missing file"}), 400

  with tempfile.TemporaryDirectory() as td:
    path = os.path.join(td, f.filename or "input.bin")
    f.save(path)
    analysis = analyze_file(path)
    return jsonify({"ok": True, "analysis": analysis})

@app.post("/quote")
def quote():
  data = request.get_json(silent=True) or {}
  order = data.get("order") or {}
  analysis = data.get("analysis") or {}
  q = calculate_quote(order, analysis)
  return jsonify({"ok": True, "quote": q})

@app.post("/preview")
def preview():
  f = request.files.get("file")
  order_id = request.form.get("orderId", "LOCAL")
  if not f:
    return jsonify({"ok": False, "error": "Missing file"}), 400

  with tempfile.TemporaryDirectory() as td:
    in_path = os.path.join(td, f.filename or "input.pdf")
    out_path = os.path.join(td, "preview.pdf")
    f.save(in_path)

    analysis = analyze_file(in_path)
    generate_preview_pdf(in_path, out_path, order_id=order_id, analysis=analysis)

    return send_file(out_path, mimetype="application/pdf", as_attachment=False, download_name="preview.pdf")

if __name__ == "__main__":
  app.run(host="127.0.0.1", port=5000, debug=True)
