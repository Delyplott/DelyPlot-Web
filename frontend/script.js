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
//  Drive Bridge helpers
// ————————————————————————————————————————————————
const APPS_SCRIPT_URL = window.APPS_SCRIPT_URL;
const SETTINGS = window.DELY_SETTINGS || { MAX_FILE_MB: 20 };

async function bridgePost(obj) {
  if (!APPS_SCRIPT_URL) throw new Error("Falta APPS_SCRIPT_URL en firebase-config.js");

  const payload = encodeURIComponent(JSON.stringify(obj));
  const body = `payload=${payload}`;

  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: "Respuesta no JSON", raw: text }; }

  if (!data.ok) throw new Error(data.error || "Bridge error");
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("No se pudo leer el archivo"));
    fr.onload = () => {
      // data:*/*;base64,XXXX
      const s = String(fr.result || "");
      const idx = s.indexOf("base64,");
      resolve(idx >= 0 ? s.substring(idx + 7) : s);
    };
    fr.readAsDataURL(file);
  });
}

// ————————————————————————————————————————————————
//  Manejo de archivos (dropzone + lista)
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
//  Envío: crear pedido + subir a Drive + escuchar Firestore
// ————————————————————————————————————————————————
let unsubscribeOrder = null;

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;

    if (!filesState.length) { alert("Adjunta al menos un archivo."); return; }
    const tyc = $("#tyc");
    if (tyc && !tyc.checked) { alert("Acepta la casilla para continuar."); return; }

    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;

    try {
      if (statusEl) statusEl.textContent = "Autenticando…";
      const user = await ensureAnonAuth();

      const fd = new FormData(form);
      renderBankData();
      renderSummary(fd);

      // 1) Crear pedido en Firestore
      if (statusEl) statusEl.textContent = "Creando pedido…";

      const primary = filesState[0];
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
          driveFileId: null,
          filename: primary.name,
          contentType: primary.type || "application/octet-stream",
          size: primary.size
        },
        files: filesState.map(f => ({
          provider: "drive",
          driveFileId: null,
          filename: f.name,
          contentType: f.type || "application/octet-stream",
          size: f.size
        }))
      };

      const docRef = await db.collection("orders").add(orderPayload);
      const orderId = docRef.id;

      // UI transición
      if (orderCard) orderCard.classList.add("hidden");
      if (quoteCard) {
        quoteCard.classList.remove("hidden");
        quoteCard.setAttribute("aria-hidden", "false");
      }
      setUIOrderStatus(orderId, "uploaded", "Subiendo archivo…");
      window.scrollTo({ top: 0, behavior: "smooth" });

      // 2) Subir archivos a Drive (bridge)
      for (let i = 0; i < filesState.length; i++) {
        const f = filesState[i];
        if (statusEl) statusEl.textContent = `Subiendo a Drive… (${i + 1}/${filesState.length})`;

        const base64 = await fileToBase64(f);
        const up = await bridgePost({
          action: "upload",
          orderId,
          filename: f.name,
          contentType: f.type || "application/octet-stream",
          base64
          // recaptchaToken: "..." (opcional)
        });

        // Actualizar Firestore con driveFileId
        const patch = {};
        patch[`files.${i}.driveFileId`] = up.fileId;

        // para compat con worker: usar el primer archivo como file.driveFileId
        if (i === 0) patch["file.driveFileId"] = up.fileId;

        patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
        await docRef.update(patch);
      }

      setUIOrderStatus(orderId, "uploaded", "Archivo subido. En espera de cotización…");

      // 3) Escuchar el pedido en tiempo real
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

        // Preview
        const pv = data.preview;
        if (pv && pv.url && previewLink) {
          previewLink.href = pv.url;
          previewLink.classList.remove("hidden");
        }

        // Quote oficial
        const q = data.quote;
        if (q && q.total_clp != null) {
          renderQuote(q);
        }

        // Error
        if (st === "error" && data.error && data.error.message) {
          alert("Error: " + data.error.message);
        }
      });

      if (statusEl) statusEl.textContent = "";
    } catch (err) {
      console.error(err);
      alert("No se pudo enviar el pedido: " + (err?.message || String(err)));
      if (orderCard) orderCard.classList.remove("hidden");
      if (quoteCard) quoteCard.classList.add("hidden");
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

    // limpiar UI quote
    if (previewLink) previewLink.classList.add("hidden");
    if (quoteContainer) quoteContainer.classList.add("hidden");
    if (quoteWait) quoteWait.classList.remove("hidden");
    if (quoteBreakdown) quoteBreakdown.innerHTML = "";
    if (quoteTotal) quoteTotal.textContent = "—";
    if (quoteFormula) quoteFormula.textContent = "";
  });
}

// Navegación activa por ancla (tu base)
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
