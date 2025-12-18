// =========================================================
// DelyPlott — script.js (completo)
// Cambios incluidos:
// 1) Nueva paleta "neutral" (oscuro moderno sobrio)
// 2) Paleta por defecto: "neutral" (en vez de "neon")
// 3) ✅ Elimina dependencia de opener/postMessage (COOP)
// 4) ✅ Polling al WebApp (ui=result) para obtener IDs subidos
//    uploader.html guarda el resultado vía saveUploadResult(orderId, files)
// =========================================================

// ——— Utilidades ———
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return "0 B";
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
//  Tema (claro / oscuro) + Paletas
// ————————————————————————————————————————————————
const root = document.documentElement;
const THEME_KEY = "dely_theme";
const PALETTE_KEY = "dely_palette";

const themeBtn = $("#theme-toggle");
const paletteBtn = $("#palette-toggle");

const palettes = [
  "neutral",
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
  applyTheme("dark"); // default
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
  const p = palettes.includes(saved) ? saved : "neutral";
  applyPalette(p);
}

function nextPalette() {
  const current = root.dataset.palette || "neutral";
  const idx = palettes.indexOf(current);
  const next = palettes[(idx + 1) % palettes.length];
  localStorage.setItem(PALETTE_KEY, next);
  applyPalette(next);
}

initTheme();
initPalette();

if (themeBtn) themeBtn.addEventListener("click", () => {
  const current = root.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

if (paletteBtn) paletteBtn.addEventListener("click", nextPalette);

window.addEventListener("keydown", (e) => {
  if (e.shiftKey && (e.key === "P" || e.key === "p")) nextPalette();
});

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
const APPS_SCRIPT_URL = window.APPS_SCRIPT_URL; // URL .../exec del Web App

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

// ✅ Polling al WebApp: ?ui=result&orderId=...
function buildResultUrl(orderId) {
  if (!APPS_SCRIPT_URL) throw new Error("Falta APPS_SCRIPT_URL en firebase-config.js");
  const u = new URL(APPS_SCRIPT_URL);
  u.searchParams.set("ui", "result");
  u.searchParams.set("orderId", String(orderId || ""));
  return u.toString();
}

/**
 * Espera el resultado subido consultando al WebApp (sin postMessage).
 * Requiere que Apps Script doGet(ui=result) retorne JSON:
 * - { ok:true, ready:false } mientras no exista
 * - { ok:true, ready:true, files:[{filename,fileId,contentType,size}...] } cuando esté listo
 */
async function waitUploaderResultByPolling(orderId, popupWindow) {
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  const START = Date.now();
  const url = buildResultUrl(orderId);

  // Para evitar cache raro
  const withNoCache = (base) => {
    const u = new URL(base);
    u.searchParams.set("_ts", String(Date.now()));
    return u.toString();
  };

  // backoff suave
  let delay = 600;

  while (true) {
    // si cerró antes de tiempo, igual podemos seguir unos segundos, pero normalmente es error
    if (popupWindow && popupWindow.closed) {
      // si cerró, no abortamos de inmediato: quizás ya guardó resultado. Solo seguimos un poco.
    }

    if (Date.now() - START > TIMEOUT_MS) {
      throw new Error("Tiempo de espera agotado. No llegó resultado del uploader (polling).");
    }

    try {
      const res = await fetch(withNoCache(url), {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store",
        mode: "cors"
      });

      // Si el WebApp no permite CORS, esto fallará (TypeError). En ese caso hay que ajustar doGet headers.
      const data = await res.json();

      if (data && data.ok && data.ready && Array.isArray(data.files) && data.files.length) {
        return data.files;
      }
      // si no está listo, seguimos esperando
    } catch (e) {
      // Si hubo error de red/CORS, reintentamos con delay creciente
      // (igual te va a quedar el error en consola para diagnosticar)
      console.warn("Polling error:", e);
    }

    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(2000, Math.floor(delay * 1.15));
  }
}

// ————————————————————————————————————————————————
//  (Opcional) UI vieja de archivos local (si existiera)
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
  const arr = Array.from(list || []);
  for (const f of arr) filesState.push(f);
  renderFiles();
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

function renderSummary(formData, filesArr = null) {
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

  const list = Array.isArray(filesArr)
    ? filesArr
    : (Array.isArray(filesState) ? filesState.map(f => ({ filename: f?.name })) : []);

  const names = list.map(x => x?.filename).filter(Boolean);
  const filesLi = document.createElement("li");
  filesLi.innerHTML = `<span><b>Archivos (${names.length})</b></span><span>${names.length ? names.join(", ") : "—"}</span>`;
  summary.appendChild(filesLi);
}

function setUIOrderStatus(orderId, status, hint = "") {
  if (orderIdEl) orderIdEl.textContent = orderId || "—";
  if (orderStatusEl) orderStatusEl.textContent = status || "—";
  if (orderHintEl) orderHintEl.textContent = hint || "";
}

function renderQuote(quote) {
  if (!quote) return;

  if (quoteWait) quoteWait.classList.add("hidden");
  if (quoteContainer) quoteContainer.classList.remove("hidden");

  if (quoteBreakdown) {
    quoteBreakdown.innerHTML = "";
    const steps = Array.isArray(quote.steps) ? quote.steps : [];
    for (const s of steps) {
      const li = document.createElement("li");
      li.innerHTML = `<span>${s.label}</span><span>${s.value}</span>`;
      quoteBreakdown.appendChild(li);
    }
  }
  if (quoteTotal) quoteTotal.textContent = formatCLP(quote.total_clp || 0);
  if (quoteFormula) quoteFormula.textContent = quote.formula || "";
}

// ————————————————————————————————————————————————
//  Envío: crear pedido (DESPUÉS del upload) + escuchar Firestore
// ————————————————————————————————————————————————
let unsubscribeOrder = null;

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;

    const tyc = $("#tyc");
    if (tyc && !tyc.checked) { alert("Acepta la casilla para continuar."); return; }

    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;

    let popup = null;

    try {
      if (statusEl) statusEl.textContent = "Autenticando…";
      const user = await ensureAnonAuth();

      const fd = new FormData(form);
      renderBankData();
      renderSummary(fd, []);

      // 1) Reservar ID y abrir uploader
      const docRef = db.collection("orders").doc();
      const orderId = docRef.id;

      if (orderCard) orderCard.classList.add("hidden");
      if (quoteCard) {
        quoteCard.classList.remove("hidden");
        quoteCard.setAttribute("aria-hidden", "false");
      }
      setUIOrderStatus(orderId, "awaiting_upload", "Se abrirá una ventana para subir archivos a Drive…");
      window.scrollTo({ top: 0, behavior: "smooth" });

      if (statusEl) statusEl.textContent = "Abriendo uploader… (permite popups)";
      popup = openUploader(orderId);

      if (statusEl) statusEl.textContent = "Esperando subida en la ventana…";
      setUIOrderStatus(orderId, "awaiting_upload", "En la ventana emergente, seleccione sus archivos y presione “Subir”.");

      // ✅ 2) Esperar resultado vía polling (NO postMessage)
      const uploaded = await waitUploaderResultByPolling(orderId, popup);
      if (!uploaded.length) throw new Error("No se subió ningún archivo en el uploader.");

      // 3) Normalizar archivos
      const normalizedFiles = uploaded.map(u => ({
        provider: "drive",
        driveFileId: u.fileId,
        filename: u.filename,
        contentType: u.contentType || "application/octet-stream",
        size: (u.size ?? null)
      }));

      const first = normalizedFiles[0];

      // 4) Crear pedido en Firestore
      if (statusEl) statusEl.textContent = "Guardando pedido…";

      const orderPayload = {
        uid: user.uid,
        status: "uploaded",
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        customer: {
          name: String(fd.get("nombre") || ""),
          phone: String(fd.get("telefono") || ""),
          email: String(fd.get("email") || "")
        },
        options: {
          size: String(fd.get("tamano") || ""),
          color: String(fd.get("color") || ""),
          delivery: String(fd.get("entrega") || "")
        },
        notes: String(fd.get("notas") || ""),
        file: {
          provider: "drive",
          driveFileId: first.driveFileId,
          filename: first.filename,
          contentType: first.contentType,
          size: first.size
        },
        files: normalizedFiles
      };

      await docRef.set(orderPayload);

      renderSummary(fd, normalizedFiles);
      setUIOrderStatus(orderId, "uploaded", "Archivo subido. En espera de cotización…");
      if (statusEl) statusEl.textContent = "";

      // 5) Escuchar el pedido en tiempo real
      if (unsubscribeOrder) unsubscribeOrder();
      unsubscribeOrder = docRef.onSnapshot((snap) => {
        if (!snap.exists) return;
        const data = snap.data() || {};
        const st = data.status || "—";

        let hint = "";
        if (st === "uploaded") hint = "En cola para análisis…";
        if (st === "in_progress") hint = "Analizando y generando preview…";
        if (st === "quoted") hint = "Cotización lista.";
        if (st === "error") hint = "Ocurrió un error. Revisa el detalle.";

        setUIOrderStatus(orderId, st, hint);

        const pv = data.preview;
        if (pv && pv.url && previewLink) {
          previewLink.href = pv.url;
          previewLink.classList.remove("hidden");
        }

        const q = data.quote;
        if (q && q.total_clp != null) renderQuote(q);

        if (st === "error" && data.error && data.error.message) {
          alert("Error: " + data.error.message);
        }
      });

    } catch (err) {
      console.error(err);
      alert("No se pudo enviar el pedido: " + (err?.message || String(err)));

      if (orderCard) orderCard.classList.remove("hidden");
      if (quoteCard) quoteCard.classList.add("hidden");
      if (statusEl) statusEl.textContent = "";
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// Copiar datos bancarios
const copyBtn = $("#copy-btn");
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const bank = $("#bank-data");
    if (!bank) return;

    const nodes = Array.from(bank.querySelectorAll("dt,dd")).map(el => el.textContent);
    let text = "";
    for (let i = 0; i < nodes.length; i += 2) {
      const k = nodes[i] ?? "";
      const v = nodes[i + 1] ?? "";
      text += `${k}: ${v}\n`;
    }
    text = text.trim();

    try {
      await navigator.clipboard.writeText(text);
      alert("Datos de transferencia copiados 👍");
    } catch {
      alert("No se pudo copiar automáticamente. Selecciona y copia manualmente.");
    }
  });
}

// Nuevo pedido
const newOrderBtn = $("#new-order");
if (newOrderBtn) {
  newOrderBtn.addEventListener("click", () => {
    if (unsubscribeOrder) { unsubscribeOrder(); unsubscribeOrder = null; }

    if (quoteCard) {
      quoteCard.classList.add("hidden");
      quoteCard.setAttribute("aria-hidden", "true");
    }
    if (orderCard) orderCard.classList.remove("hidden");
    if (form) form.reset();

    filesState = [];
    renderFiles();

    if (previewLink) previewLink.classList.add("hidden");
    if (quoteContainer) quoteContainer.classList.add("hidden");
    if (quoteWait) quoteWait.classList.remove("hidden");
    if (quoteBreakdown) quoteBreakdown.innerHTML = "";
    if (quoteTotal) quoteTotal.textContent = "—";
    if (quoteFormula) quoteFormula.textContent = "";
    if (statusEl) statusEl.textContent = "";
  });
}

// Navegación activa por ancla
const links = $$(".nav .link").filter(a => {
  const href = a.getAttribute("href");
  return href && href.startsWith("#");
});
const sections = ["#order-card", "#como-funciona", "#sobre-nosotros", "#contacto"]
  .map(id => $(id)).filter(Boolean);

function onScroll() {
  const top = window.scrollY + 110;
  let activeIndex = 0;
  sections.forEach((sec, i) => { if (sec.offsetTop <= top) activeIndex = i; });
  links.forEach((a, i) => a.classList.toggle("active", i === activeIndex));
}
window.addEventListener("scroll", onScroll);
onScroll();
