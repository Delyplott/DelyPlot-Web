/**
 * Script Properties requeridas:
 * - FOLDER_ID: ID de carpeta en Drive
 * - WORKER_SECRET: secreto para acciones privadas
 * - (opcional) MAX_BYTES: ej. 20000000 (20MB)
 * - (opcional) RECAPTCHA_SECRET: para mitigación anti-abuso
 */

function doGet() {
  return ContentService
    .createTextOutput("Delyplot Drive Bridge OK")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    var payloadStr = extractPayload_(e);
    var req = JSON.parse(payloadStr || "{}");

    var action = req.action;
    if (!action) return json_({ ok: false, error: "Missing action" });

    if (action === "upload") return upload_(req);
    if (action === "download") return download_(req);
    if (action === "uploadPreview") return uploadPreview_(req);

    return json_({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
}

function upload_(req) {
  // Público (riesgo). Mitigación sugerida: reCAPTCHA v3 + límite tamaño.
  // if (req.recaptchaToken) verifyRecaptcha_(req.recaptchaToken);

  var folderId = getProp_("FOLDER_ID");
  var maxBytes = Number(PropertiesService.getScriptProperties().getProperty("MAX_BYTES") || "20000000"); // default 20MB

  if (!req.orderId || !req.filename || !req.base64) {
    return json_({ ok: false, error: "Missing fields (orderId, filename, base64)" });
  }

  var bytes = Utilities.base64Decode(req.base64);
  if (bytes.length > maxBytes) {
    return json_({ ok: false, error: "File too large for Apps Script bridge. bytes=" + bytes.length });
  }

  var root = DriveApp.getFolderById(folderId);
  var orderFolder = getOrCreateSubfolder_(root, String(req.orderId));

  var blob = Utilities.newBlob(bytes, req.contentType || "application/octet-stream", req.filename);
  var file = orderFolder.createFile(blob);

  return json_({
    ok: true,
    fileId: file.getId(),
    name: file.getName()
  });
}

function download_(req) {
  requireSecret_(req.secret);

  if (!req.fileId) return json_({ ok: false, error: "Missing fileId" });

  var file = DriveApp.getFileById(req.fileId);
  var blob = file.getBlob();
  var bytes = blob.getBytes();

  // Nota: base64 en respuesta también tiene límites (tamaño).
  return json_({
    ok: true,
    filename: file.getName(),
    contentType: blob.getContentType() || "application/octet-stream",
    base64: Utilities.base64Encode(bytes)
  });
}

function uploadPreview_(req) {
  requireSecret_(req.secret);

  var folderId = getProp_("FOLDER_ID");
  if (!req.orderId || !req.filename || !req.base64) {
    return json_({ ok: false, error: "Missing fields (orderId, filename, base64)" });
  }

  var bytes = Utilities.base64Decode(req.base64);
  var root = DriveApp.getFolderById(folderId);
  var orderFolder = getOrCreateSubfolder_(root, String(req.orderId));

  var blob = Utilities.newBlob(bytes, req.contentType || "application/pdf", req.filename);
  var file = orderFolder.createFile(blob);

  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return json_({
    ok: true,
    previewFileId: file.getId(),
    url: file.getUrl()
  });
}

/* ---------------- helpers ---------------- */

function extractPayload_(e) {
  // Esperado: application/x-www-form-urlencoded con payload=<json>
  if (e && e.parameter && e.parameter.payload) return e.parameter.payload;

  // fallback: raw post data
  if (e && e.postData && e.postData.contents) {
    var c = e.postData.contents;
    // si viene "payload=...."
    if (c.indexOf("payload=") === 0) {
      return decodeURIComponent(c.substring("payload=".length));
    }
    return c;
  }
  return "";
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getProp_(k) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error("Missing Script Property: " + k);
  return v;
}

function requireSecret_(s) {
  var secret = getProp_("WORKER_SECRET");
  if (!s || s !== secret) throw new Error("Unauthorized");
}

function getOrCreateSubfolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

/**
 * (Opcional) Verificación reCAPTCHA v3 (recomendado si upload es público)
 * Guardar RECAPTCHA_SECRET en Script Properties.
 */
function verifyRecaptcha_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty("RECAPTCHA_SECRET");
  if (!secret) return; // si no hay secret, no se verifica

  var url = "https://www.google.com/recaptcha/api/siteverify";
  var res = UrlFetchApp.fetch(url, {
    method: "post",
    payload: { secret: secret, response: token },
    muteHttpExceptions: true
  });
  var data = JSON.parse(res.getContentText() || "{}");
  if (!data.success) throw new Error("reCAPTCHA failed");
  // Umbral sugerido
  if (typeof data.score === "number" && data.score < 0.5) throw new Error("reCAPTCHA low score");
}
