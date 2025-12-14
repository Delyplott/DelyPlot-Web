from __future__ import annotations
from typing import Any, Dict

# Ajusta precios a tu realidad (CLP)
BASE_RATE_CLP_PER_M2 = {
  "Blanco y negro": 4500,
  "Color": 9500
}

DELIVERY_FEE_CLP = 3000

def _area_m2(page_mm: Dict[str, float]) -> float:
  w = float(page_mm.get("w") or 0)
  h = float(page_mm.get("h") or 0)
  return max(0.0, (w / 1000.0) * (h / 1000.0))

def calculate_quote(order: Dict[str, Any], analysis: Dict[str, Any]) -> Dict[str, Any]:
  opts = (order or {}).get("options") or {}
  color = opts.get("color", "Blanco y negro")
  delivery = opts.get("delivery", "Retiro en local")

  page_mm = analysis.get("page_mm") or {"w": 0, "h": 0}
  pages = int(analysis.get("pages") or 1)
  coverage_pct = float(analysis.get("coverage_pct") or 0.0)

  area_m2 = _area_m2(page_mm)
  base_rate = float(BASE_RATE_CLP_PER_M2.get(color, BASE_RATE_CLP_PER_M2["Blanco y negro"]))

  # Factor por cobertura: 0% => 1.00; 100% => 1.60 (ajustable)
  coverage_factor = 1.0 + 0.60 * (coverage_pct / 100.0)

  subtotal = area_m2 * pages * base_rate * coverage_factor
  fee_delivery = float(DELIVERY_FEE_CLP if delivery == "Delivery" else 0)

  total = round(subtotal + fee_delivery)

  steps = [
    {"label": "Área (m²)", "value": f"{area_m2:.4f}"},
    {"label": "Páginas", "value": str(pages)},
    {"label": "Tarifa base (CLP/m²)", "value": f"{int(base_rate)}"},
    {"label": "Cobertura tinta (%)", "value": f"{coverage_pct:.2f}%"},
    {"label": "Factor cobertura", "value": f"{coverage_factor:.4f}"},
    {"label": "Subtotal", "value": f"{int(round(subtotal))} CLP"},
    {"label": "Delivery", "value": f"{int(fee_delivery)} CLP"},
  ]

  formula = (
    "total = area_m2 * pages * base_rate_clp_m2 * (1 + 0.60*(coverage_pct/100)) + delivery_fee"
  )

  return {
    "currency": "CLP",
    "inputs": {
      "page_mm": page_mm,
      "pages": pages,
      "color": color,
      "delivery": delivery,
      "coverage_pct": coverage_pct
    },
    "coefficients": {
      "base_rate_clp_per_m2": base_rate,
      "coverage_weight": 0.60,
      "delivery_fee_clp": fee_delivery
    },
    "steps": steps,
    "formula": formula,
    "total_clp": int(total),
    "algorithm_version": "v1"
  }
