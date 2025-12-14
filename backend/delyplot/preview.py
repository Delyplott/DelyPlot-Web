from __future__ import annotations
from typing import Any, Dict, Tuple
import datetime

import fitz
import numpy as np
import cv2

from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

def _render_pdf_first_page(pdf_path: str, dpi: int = 150) -> Tuple[np.ndarray, Tuple[float, float]]:
  doc = fitz.open(pdf_path)
  page = doc.load_page(0)
  w_pt, h_pt = page.rect.width, page.rect.height

  mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
  pix = page.get_pixmap(matrix=mat, alpha=False)
  img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
  bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

  # page size in points for reportlab
  return bgr, (w_pt, h_pt)

def generate_preview_pdf(input_pdf: str, output_pdf: str, order_id: str, analysis: Dict[str, Any]) -> None:
  bgr, (w_pt, h_pt) = _render_pdf_first_page(input_pdf, dpi=150)

  # Convert to RGB for reportlab image
  rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

  c = canvas.Canvas(output_pdf, pagesize=(w_pt, h_pt))

  # Dibujar imagen ocupando toda la página
  # (convertimos array a imagen temporal en memoria)
  from PIL import Image
  import io
  img = Image.fromarray(rgb)
  buff = io.BytesIO()
  img.save(buff, format="PNG")
  buff.seek(0)

  c.drawImage(buff, 0, 0, width=w_pt, height=h_pt, mask='auto')

  # Marcas de corte simples
  m = 6 * mm
  c.setLineWidth(0.5)
  # Esquinas
  c.line(0, h_pt - m, m, h_pt - m)
  c.line(m, h_pt, m, h_pt - m)

  c.line(w_pt - m, h_pt, w_pt - m, h_pt - m)
  c.line(w_pt - m, h_pt - m, w_pt, h_pt - m)

  c.line(0, m, m, m)
  c.line(m, 0, m, m)

  c.line(w_pt - m, 0, w_pt - m, m)
  c.line(w_pt - m, m, w_pt, m)

  # Texto / watermark
  c.setFont("Helvetica-Bold", 10)
  now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
  cov = analysis.get("coverage_pct", "—")
  c.drawString(10 * mm, 10 * mm, f"Delyplot Preview | orderId={order_id} | coverage={cov}% | {now}")

  c.showPage()
  c.save()

