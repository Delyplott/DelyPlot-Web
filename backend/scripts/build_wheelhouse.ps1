
$ErrorActionPreference = "Stop"

Set-Location (Split-Path $PSScriptRoot -Parent)

python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip wheel

# Descarga wheels (si existe wheel disponible). Para entornos offline:
# - Ejecuta esto en una máquina con internet.
# - Copia backend\wheelhouse al equipo offline.
New-Item -ItemType Directory -Force -Path wheelhouse | Out-Null
.\.venv\Scripts\python -m pip download -r requirements.txt -d wheelhouse
Write-Host "wheelhouse listo en backend\wheelhouse"
