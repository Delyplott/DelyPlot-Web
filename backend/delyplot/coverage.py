from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple
import os

import numpy as np
import cv2
import fitz  # PyMuPDF
from PIL import Image

@dataclass
class CoverageResult:
  coverage_pct: float
  dpi_used: int
  page_count: int
  page_mm: Optional[Tuple[float, float]]
  method: Dict[str, Any]

def _pdf_page_to_bgr(pdf_path: str, page_index: int = 0, dpi: int = 200) -> np.ndarray:
  doc = fitz.open(pdf_path)
  page = doc.load_page(page_index)
  mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
  pix = page.get_pixmap(matrix=mat, alpha=False)
  img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
  # pix.n suele ser 3 (RGB)
  bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
  return bgr

def _estimate_coverage_from_bgr(bgr: np.ndarray) -> Tuple[float, Dict[str, Any]]:
  # Recorta márgenes (2%) para reducir falsos positivos (bordes/sombras)
  h, w = bgr.shape[:2]
  pad_h = int(h * 0.02)
  pad_w = int(w * 0.02)
  roi = bgr[pad_h:h - pad_h, pad_w:w - pad_w]

  gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

  # Umbral adaptativo (resistente a variaciones de fondo)
  thr = cv2.adaptiveThreshold(
    gray, 255,
    cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv2.THRESH_BINARY_INV,
    35, 10
  )

  # Limpieza morfológica
  kernel = np.ones((2, 2), np.uint8)
  mask = cv2.morphologyEx(thr, cv2.MORPH_OPEN, kernel, iterations=1)

  ink = int(np.count_nonzero(mask))
  total = int(mask.size)
  coverage = (ink / total) * 100.0 if total else 0.0

  meta = {
    "threshold": "adaptive_gaussian_inv",
    "blockSize": 35,
    "C": 10,
    "morph_open": True,
    "crop_pct": 2
  }
  return float(round(coverage, 2)), meta

def analyze_file(path: str, dpi: int = 200) -> Dict[str, Any]:
  ext = os.path.splitext(path)[1].lower()

  if ext == ".pdf":
    doc = fitz.open(path)
    page_count = doc.page_count
    page0 = doc.load_page(0)
    # puntos (1/72 in). Convertimos a mm
    w_pt, h_pt = page0.rect.width, page0.rect.height
    w_mm = (w_pt / 72.0) * 25.4
    h_mm = (h_pt / 72.0) * 25.4

    bgr = _pdf_page_to_bgr(path, 0, dpi=dpi)
    cov, method = _estimate_coverage_from_bgr(bgr)

    return {
      "type": "pdf",
      "pages": page_count,
      "page_mm": {"w": round(w_mm, 2), "h": round(h_mm, 2)},
      "dpi_used": dpi,
      "coverage_pct": cov,
      "coverage_method": method
    }

  # Imagen
  img = Image.open(path)
  dpi_info = img.info.get("dpi")
  dpi_used = int(dpi_info[0]) if isinstance(dpi_info, tuple) and dpi_info else 300

  bgr = cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2BGR)
  cov, method = _estimate_coverage_from_bgr(bgr)

  w_px, h_px = img.size
  page_mm = None
  if dpi_used > 0:
    w_in = w_px / dpi_used
    h_in = h_px / dpi_used
    page_mm = {"w": round(w_in * 25.4, 2), "h": round(h_in * 25.4, 2)}

  return {
    "type": "image",
    "pages": 1,
    "page_mm": page_mm,
    "dpi_used": dpi_used,
    "coverage_pct": cov,
    "coverage_method": method
  }
