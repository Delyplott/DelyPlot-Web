// ——— Utilidades ———
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

const formatBytes = (bytes) => {
    if (bytes === 0) return "0 B";
    const k = 1024, sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

// Datos bancarios (EDITA A TU GUSTO)
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

// Paletas disponibles (deben existir en CSS como: html[data-theme="dark"][data-palette="..."])
const palettes = [
    "neon", "arasaka", "mox", "netwatch", "sandevistan",
    "kusanagi", "nightcity", "afterlife", "trauma", "delamain",
    "monowire", "chromatic", "tokyo", "acidrain", "ghostnet"
];

function applyTheme(theme) {
    root.dataset.theme = theme; // "light" | "dark"
    const isDark = theme === "dark";
    if (themeBtn) {
        themeBtn.textContent = isDark ? "☀️" : "🌙";
        themeBtn.setAttribute("aria-label", isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
        themeBtn.setAttribute("title", isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro");
    }
}

function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
        applyTheme(saved);
        return;
    }

    // Por defecto: oscuro (para no “quemar” los ojos).
    // Si prefieres respetar el sistema, reemplaza por:
    // const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    // applyTheme(prefersDark ? "dark" : "light");
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

// Inicializar
initTheme();
initPalette();

// Listeners
if (themeBtn) {
    themeBtn.addEventListener("click", () => {
        const current = root.dataset.theme === "dark" ? "dark" : "light";
        const next = current === "dark" ? "light" : "dark";
        localStorage.setItem(THEME_KEY, next);
        applyTheme(next);
    });
}

if (paletteBtn) {
    paletteBtn.addEventListener("click", nextPalette);
}

// Atajo: Shift + P para ciclar paletas
window.addEventListener("keydown", (e) => {
    if (e.shiftKey && (e.key === "P" || e.key === "p")) nextPalette();
});

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
    const MAX = 500 * 1024 * 1024; // 500 MB
    const tooBig = [];

    for (const f of list) {
        if (f.size > MAX) {
            tooBig.push(f.name);
            continue;
        }
        filesState.push(f);
    }

    renderFiles();

    if (tooBig.length) {
        alert("Se omitieron archivos por superar 500 MB:\n• " + tooBig.join("\n• "));
    }
}

if (input && dropzone) {
    input.addEventListener("change", (e) => addFiles(e.target.files));

    // Click en dropzone abre selector
    dropzone.addEventListener("click", () => input.click());

    // Drag & drop handlers
    ["dragenter", "dragover", "dragleave", "drop"].forEach((evt) => {
        dropzone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    ["dragenter", "dragover"].forEach((evt) => {
        dropzone.addEventListener(evt, () => dropzone.classList.add("dragover"));
    });

    ["dragleave", "drop"].forEach((evt) => {
        dropzone.addEventListener(evt, () => dropzone.classList.remove("dragover"));
    });

    dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

    // Eliminar archivo de la lista
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
//  Envío del formulario (simulado)
// ————————————————————————————————————————————————
const form = $("#order-form");
const status = $("#form-status");
const orderCard = $("#order-card");
const paymentCard = $("#payment-card");
const summary = $("#summary");
const bankData = $("#bank-data");

if (form) {
    form.addEventListener("submit", (e) => {
        e.preventDefault();

        // Validación básica
        if (!form.reportValidity()) return;

        if (!filesState.length) {
            alert("Adjunta al menos un archivo.");
            return;
        }

        const tyc = $("#tyc");
        if (tyc && !tyc.checked) {
            alert("Acepta la casilla para continuar.");
            return;
        }

        if (status) status.textContent = "Procesando pedido…";

        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;

        setTimeout(() => {
            if (status) status.textContent = "";
            if (btn) btn.disabled = false;

            // Renderizar datos de pago
            if (bankData) {
                bankData.innerHTML = "";
                Object.entries(paymentInfo).forEach(([k, v]) => {
                    const dt = document.createElement("dt");
                    dt.textContent = k.toUpperCase();
                    const dd = document.createElement("dd");
                    dd.textContent = v;
                    bankData.append(dt, dd);
                });
            }

            // Resumen
            if (summary) {
                summary.innerHTML = "";
                const data = new FormData(form);

                const items = [
                    ["Nombre", data.get("nombre")],
                    ["Teléfono", data.get("telefono")],
                    ["Email", data.get("email")],
                    ["Tamaño", data.get("tamano")],
                    ["Color", data.get("color")],
                    ["Entrega", data.get("entrega")],
                    ["Notas", (data.get("notas") || "—")]
                ];

                for (const [k, v] of items) {
                    const li = document.createElement("li");
                    li.innerHTML = `<span><b>${k}:</b></span><span>${v}</span>`;
                    summary.appendChild(li);
                }

                const filesLi = document.createElement("li");
                filesLi.innerHTML = `
                    <span><b>Archivos (${filesState.length})</b></span>
                    <span>${filesState.map(f => f.name).join(", ")}</span>
                `;
                summary.appendChild(filesLi);
            }

            // Mostrar pantalla de pago
            if (orderCard) orderCard.classList.add("hidden");
            if (paymentCard) {
                paymentCard.classList.remove("hidden");
                paymentCard.setAttribute("aria-hidden", "false");
            }

            window.scrollTo({ top: 0, behavior: "smooth" });
        }, 800);
    });
}

// ————————————————————————————————————————————————
//  Copiar datos bancarios
// ————————————————————————————————————————————————
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

// ————————————————————————————————————————————————
//  Nuevo pedido
// ————————————————————————————————————————————————
const newOrderBtn = $("#new-order");
if (newOrderBtn) {
    newOrderBtn.addEventListener("click", () => {
        if (paymentCard) {
            paymentCard.classList.add("hidden");
            paymentCard.setAttribute("aria-hidden", "true");
        }
        if (orderCard) orderCard.classList.remove("hidden");
        if (form) form.reset();

        filesState = [];
        renderFiles();
    });
}

// ————————————————————————————————————————————————
//  Navegación activa por ancla
// ————————————————————————————————————————————————
const links = $$(".nav .link").filter(a => {
    const href = a.getAttribute("href");
    return href && href.startsWith("#");
});

const sections = ["#order-card", "#como-funciona", "#sobre-nosotros", "#contacto"]
    .map(id => $(id))
    .filter(Boolean);

function onScroll() {
    const top = window.scrollY + 110; // compensa header
    let activeIndex = 0;

    sections.forEach((sec, i) => {
        if (sec.offsetTop <= top) activeIndex = i;
    });

    links.forEach((a, i) => a.classList.toggle("active", i === activeIndex));
}

window.addEventListener("scroll", onScroll);
onScroll();
