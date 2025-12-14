// ——— Utilidades ———
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const formatBytes = (bytes) => {
  if (bytes === 0) return "0 B";
  const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const formatCLP = (n) => {
  try {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" }).format(n);
  } catch {
    return `$${n}`;
  }
};

// Datos bancarios (EDITA)
const paymentInfo = {
  banco: "Banco Nación",
  titular: "Delyplott Express",
  cbu: "00000000 00000000000000",
  alias: "DELYPLOTT.EXPRESS",
  cuit: "20-12345678-9",
  concepto: "Ploteo y/o Doblado"
};

// ——— Año en footer ———
const yearEl = $("#year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

// ————————————————————————————————————————————————
//  Tema (claro / oscuro) + Paletas (igual que tu base)
// ————————————————————————————————————————————————
const root = document.documentElement;
const THEME_KEY = "dely_theme";
const PALETTE_KEY = "dely_palette";

const themeBtn = $("#theme-toggle");
const paletteBtn = $("#palette-toggle");

const palettes = [
  "neon", "arasaka", "mox", "netwatch", "sandevistan",
  "kusanagi", "nightcity", "afterlife", "trauma", "delamain",
  "monowire", "chromatic", "tokyo", "acidrain", "ghostnet"
];

function applyTheme(theme) {
  root.dataset.theme = theme;
  const isDark = theme === "dark";
  if (themeBtn) {
    themeBtn.textContent = isDark ? "☀️" : "🌙";
    themeBtn.setAttribute("aria-label", isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
    themeBtn.setAttribute("title", isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
  }
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return applyTheme(saved);
  applyTheme("dark");
}
function applyPalette(palette) {
  root.dataset.palette = palette;
  if (paletteBtn) {
    paletteBtn.title = `Paleta: ${palette}`;
    paletteBtn.setAttribute("aria-label", `Cambiar paleta (actual: ${palette})`);
  }
}
function initPalette() {
  const saved = localStorage.getItem(PALETTE_KEY);
  const p = palettes.includes(saved) ? saved : "neon";
  applyPalette(p);
}
function nextPalette() {
  const current = root.dataset.palette || "neon";
  const idx = palettes.indexOf(current);
  const next = palettes[(idx + 1) % palettes.length];
  localStorage.setItem(PALETTE_KEY, next);
  applyPalette(next);
}
initTheme(); initPalette();
if (themeBtn) themeBtn.addEventListener("click", () => {
  const current = root.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});
if (paletteBtn) paletteBtn.addEventListener("click", nextPalette);
window.addEventListener("keydown", (e) => { if (e.shiftKey && (e.key === "P" || e.key === "p")) nextPalette(); });

// ————————————————————————————————————————————————
//  Firebase init (Compat)
// ————————————————————————————————————————————————
if (!window.FIREBASE_CONFIG) {
  alert("Falta firebase-config.js. Copia firebase-config.example.js y completa datos.");
}

firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

async function ensureAnonAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await auth.signInAnonymously();
  return cred.user;
}

// ————————————————————————————————————————————————
//  Drive Uploader (Apps Script UI - SIN CORS)
// ————————————————————————————————————————————————
const APPS_SCRIPT_URL = window.APPS_SCRIPT_URL;             // Debe ser la URL .../exec del Web App
const SETTINGS = window.DELY_SETTINGS || { MAX_FILE_MB: 20 };

function buildUploaderUrl(orderId) {
  if (!APPS_SCRIPT_URL) throw new Error("Falta APPS_SCRIPT_URL en firebase-config.js");
  let u;
  try {
    u = new URL(APPS_SCRIPT_URL);
  } catch {
    throw new Error("APPS_SCRIPT_URL inválida (debe ser URL absoluta del Web App /exec).");
  }
  u.searchParams.set("ui", "uploader");
  u.searchParams.set("orderId", String(orderId || ""));
  return u.toString();
}

function openUploader(orderId) {
  const url = buildUploaderUrl(orderId);
  const w = window.open(url, "dely_uploader", "width=560,height=760");
  if (!w) throw new Error("Popup bloqueado. Habilite ventanas emergentes para continuar.");
  return w;
}

/**
 * Espera el postMessage desde Apps Script:
 * { type:"drive_upload_done", orderId, files:[{filename,fileId,contentType,size}] }
 */
function waitUploaderResult(orderId, popupWindow) {
  return new Promise((resolve, reject) => {
    const TIMEOUT_MS = 10 * 60 * 1000; // 10 min
    let done = false;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Tiempo de espera agotado. No llegó respuesta del uploader."));
    }, TIMEOUT_MS);

    const poll = setInterval(() => {
      if (done) return;
      if (popupWindow && popupWindow.closed) {
        cleanup();
        reject(new Error("El uploader se cerró antes de terminar la subida."));
      }
    }, 500);

    function onMsg(ev) {
      // Apps Script HTML suele venir desde:
      // https://script.google.com o https://script.googleusercontent.com
      const okOrigin =
        ev.origin === "https://script.google.com" ||
        ev.origin === "https://script.googleusercontent.com";

      if (!okOrigin) return;

      const msg = ev.data || {};
      if (msg.type !== "drive_upload_done") return;
      if (String(msg.orderId || "") !== String(orderId || "")) return;

      done = true;
      cleanup();
      resolve(Array.isArray(msg.files) ? msg.files : []);
    }

    function cleanup() {
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener("message", onMsg);
    }

    window.addEventListener("message", onMsg);
  });
}

// ————————————————————————————————————————————————
//  Manejo de archivos (dropzone + lista)  [solo UI/summary]
// ————————————————————————————————————————————————
const input = $("#file-input");
const dropzone = $("#dropzone");
const fileList = $("#file-list");
let filesState = [];

function renderFiles() {
  if (!fileList) return;
  fileList.innerHTML = "";
  if (!filesState.length) return;

  filesState.forEach((f, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="meta">
        <span class="badge">${f.type || "archivo"}</span>
        <strong>${f.name}</strong>
      </div>
      <div>
        <small>${formatBytes(f.size)}</small>
        <button class="btn ghost" data-remove="${idx}" aria-label="Quitar ${f.name}" type="button">✕</button>
      </div>
    `;
    fileList.appendChild(li);
  });
}

function addFiles(list) {
  const MAX = (SETTINGS.MAX_FILE_MB || 20) * 1024 * 1024;
  const tooBig = [];

  for (const f of list) {
    if (f.size > MAX) { tooBig.push(f.name); continue; }
    filesState.push(f);
  }
  renderFiles();
  if (tooBig.length) {
    alert(`Se omitieron por exceder ${SETTINGS.MAX_FILE_MB} MB:\n• ` + tooBig.join("\n• "));
  }
}

if (input && dropzone) {
  input.addEventListener("change", (e) => addFiles(e.target.files));
  dropzone.addEventListener("click", () => input.click());

  ["dragenter", "dragover", "dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
  });
  ["dragenter", "dragover"].forEach((evt) => dropzone.addEventListener(evt, () => dropzone.classList.add("dragover")));
  ["dragleave", "drop"].forEach((evt) => dropzone.addEventListener(evt, () => dropzone.classList.remove("dragover")));
  dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  if (fileList) {
    fileList.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-remove]");
      if (!btn) return;
      const idx = btn.getAttribute("data-remove");
      if (idx !== null) {
        filesState.splice(Number(idx), 1);
        renderFiles();
      }
    });
  }
}

// ————————————————————————————————————————————————
//  UI refs (estado/cotización)
// ————————————————————————————————————————————————
const form = $("#order-form");
const statusEl = $("#form-status");

const orderCard = $("#order-card");
const quoteCard = $("#quote-card");

const orderIdEl = $("#order-id");
const orderStatusEl = $("#order-status");
const orderHintEl = $("#order-hint");

const previewLink = $("#preview-link");

const quoteContainer = $("#quote-container");
const quoteWait = $("#quote-wait");
const quoteBreakdown = $("#quote-breakdown");
const quoteTotal = $("#quote-total");
const quoteFormula = $("#quote-formula");

const summary = $("#summary");
const bankData = $("#bank-data");

// Renderizar datos de pago
function renderBankData() {
  if (!bankData) return;
  bankData.innerHTML = "";
  Object.entries(paymentInfo).forEach(([k, v]) => {
    const dt = document.createElement("dt");
    dt.textContent = k.toUpperCase();
    const dd = document.createElement("dd");
    dd.textContent = v;
    bankData.append(dt, dd);
  });
}

function renderSummary(formData) {
  if (!summary) return;
  summary.innerHTML = "";

  const items = [
    ["Nombre", formData.get("nombre")],
    ["Teléfono", formData.get("telefono")],
    ["Email", formData.get("email")],
    ["Tamaño", formData.get("tamano")],
    ["Color", formData.get("color")],
    ["Entrega", formData.get("entrega")],
    ["Notas", (formData.get("notas") || "—")]
  ];

  for (const [k, v] of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span><b>${k}:</b></span><span>${v}</span>`;
    summary.appendChild(li);
  }

  const filesLi = document.createElement("li");
  filesLi.innerHTML = `<span><b>Archivos (${filesState.length})</b></span><span>${filesState.map(f => f.name).join(", ")}</span>`;
  summary.appendChild(filesLi);
}

function setUIOrderStatus(orderId, status, hint = "") {
  if (orderIdEl) orderIdEl.textContent = orderId || "—";
  if (orderStatusEl) orderStatusEl.textContent = status || "—";
  if (orderHintEl) orderHintEl.textContent = hint || "";
}

function
