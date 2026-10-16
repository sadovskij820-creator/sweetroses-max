"use strict";
/**
 * MAX messenger: launch-data validation and a small Bot API client.
 * Docs: https://dev.max.ru/docs/webapps/validation, https://dev.max.ru/docs-api
 * The bot has the same shape as ./telegram.js createBot, so the server can use either.
 */
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const tls = require("tls");

const API_HOST = "platform-api2.max.ru";

/** Bridge may give the bare WebAppData string or the whole URL fragment — keep only the signed part. */
function extractWebAppData(raw) {
  let s = String(raw || "").trim();
  if (s.startsWith("#")) s = s.slice(1);
  const i = s.indexOf("WebAppData=");
  if (i === -1) return s;
  let v = s.slice(i + "WebAppData=".length);
  for (const tail of ["&WebAppPlatform=", "&WebAppVersion=", "&WebAppStartParam="]) {
    const j = v.indexOf(tail);
    if (j !== -1) v = v.slice(0, j);
  }
  // the whole value may be percent-encoded once (no raw "=" or "&" inside)
  if (!v.includes("=") && /%3D/i.test(v)) v = decodeURIComponent(v);
  return v;
}

/** Same algorithm as Telegram: secret = HMAC_SHA256("WebAppData", token); hash = HMAC_SHA256(secret, sorted pairs). */
function validateInitData(initData, botToken, maxAgeSec = 86400, now = Date.now()) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(extractWebAppData(initData));
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  const a = Buffer.from(calc, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let authDate = Number(params.get("auth_date") || 0);
  if (authDate > 1e12) authDate = Math.floor(authDate / 1000); // tolerate milliseconds
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;
  try {
    const u = JSON.parse(params.get("user") || "null");
    return u && u.id ? u : null;
  } catch (e) { return null; }
}

/** Builds a signed launch string — for tests and local development. */
function signInitData(user, botToken, authDate = Math.floor(Date.now() / 1000), extra = {}) {
  const params = new URLSearchParams(Object.assign({ auth_date: String(authDate), query_id: "TEST", user: JSON.stringify(user), chat: JSON.stringify({ id: user.id, type: "DIALOG" }) }, extra));
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}

/** platform-api2.max.ru may use a certificate of the Russian Trusted Root CA — add it if we have it. */
function trustedCA() {
  const files = [process.env.MAX_CA_FILE, path.join(__dirname, "..", "certs", "russian_trusted_root_ca.pem"), path.join(__dirname, "russian_trusted_root_ca.pem")].filter(Boolean);
  const extra = files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8"));
  return extra.length ? [...tls.rootCertificates, ...extra] : undefined;
}

function httpsRequest(token, timeoutMs) {
  const ca = trustedCA();
  return (method, pathq, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: API_HOST, path: pathq, method, ca,
      headers: Object.assign({ Authorization: token, Accept: "application/json" }, data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      timeout: timeoutMs,
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = {};
        try { json = buf ? JSON.parse(buf) : {}; } catch (e) { /* keep empty */ }
        if (res.statusCode >= 400) return reject(new Error(`MAX ${method} ${pathq.split("?")[0]}: ${res.statusCode} ${json.code || ""} ${json.message || ""}`.trim()));
        resolve(json);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function createBot({ token, request, log = console, buttonText = "Открыть каталог" }) {
  const call = request || httpsRequest(token, 100e3);
  let username = "";
  let currentUrl = "";
  let running = false;

  async function me() {
    const r = await call("GET", "/me");
    username = r.username || username;
    return r;
  }
  /** payload goes to the mini app as start_param (initData). */
  const openButton = (text = buttonText, payload = "") => (username ? [[Object.assign({ type: "open_app", text, web_app: username }, payload ? { payload } : {})]] : null);

  /** id > 0 — a user (dialog), id < 0 — a group chat. Text uses simple HTML (<b>, <i>, <a>). */
  async function sendMessage(id, text, extra = {}) {
    const n = String(id).trim();
    const q = Number(n) < 0 ? `chat_id=${encodeURIComponent(n)}` : `user_id=${encodeURIComponent(n)}`;
    const body = { text: String(text).slice(0, 4000), format: "html" };
    if (extra.buttons) body.attachments = [{ type: "inline_keyboard", payload: { buttons: extra.buttons } }];
    return call("POST", `/messages?${q}&disable_link_preview=true`, body);
  }

  /** Photos of an order: one message with image attachments taken by public URL. */
  async function sendPhotos(id, urls, caption) {
    urls = (urls || []).slice(0, 10);
    if (!urls.length) return null;
    const n = String(id).trim();
    const q = Number(n) < 0 ? `chat_id=${encodeURIComponent(n)}` : `user_id=${encodeURIComponent(n)}`;
    return call("POST", `/messages?${q}`, { text: String(caption || "").slice(0, 4000), attachments: urls.map((url) => ({ type: "image", payload: { url } })) });
  }

  async function handle(u, hooks) {
    let from = null, text = "", payload = "";
    if (u.update_type === "bot_started") { from = u.user; text = "/start"; payload = u.payload || ""; }
    else if (u.update_type === "message_created" && u.message && u.message.body) {
      from = u.message.sender; text = (u.message.body.text || "").trim();
    }
    if (!from || !from.user_id || !text) return;
    const uid = from.user_id;
    if (text.startsWith("/start")) {
      // payload from https://max.ru/<bot>?start=<payload> (bot_started) or "/start <payload>" typed/sent
      if (!payload) payload = text.slice(6).trim();
      payload = String(payload).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
      const res = (hooks.onStart && hooks.onStart({ id: uid, first_name: from.first_name, last_name: from.last_name, username: from.username }, payload)) || "";
      const extra = typeof res === "string" ? res : res.text || "";
      const appPayload = typeof res === "string" ? payload : res.appPayload ?? payload;
      const greet = (typeof res === "object" && res.greeting) || (hooks.greeting && hooks.greeting()) || "Здравствуйте! Нажмите кнопку ниже, чтобы открыть каталог.";
      const buttons = openButton(typeof res === "object" && res.button ? res.button : buttonText, appPayload);
      await sendMessage(uid, greet + extra, buttons ? { buttons } : {}).catch((e) => log.error(e.message));
    } else if (text.startsWith("/id")) {
      const admin = hooks.isAdmin && hooks.isAdmin(uid);
      await sendMessage(uid, `Ваш ID в MAX: <b>${uid}</b>${admin ? "\n\nВставьте его в «Управление → Настройки → Куда присылать заявки»." : ""}`).catch((e) => log.error(e.message));
    }
  }

  async function startPolling(hooks = {}) {
    if (running) return;
    running = true;
    try { await me(); } catch (e) { log.error("MAX: не удалось получить данные бота (" + e.message + "). Проверьте MAX_BOT_TOKEN."); }
    let marker = null;
    while (running) {
      try {
        const q = new URLSearchParams({ timeout: "30", limit: "100", types: "message_created,bot_started" });
        if (marker !== null) q.set("marker", String(marker));
        const r = await call("GET", "/updates?" + q.toString());
        if (r && r.marker !== undefined && r.marker !== null) marker = r.marker;
        for (const u of (r && r.updates) || []) await handle(u, hooks);
      } catch (e) {
        log.error("Нет связи с MAX (" + e.message + "). Бот переподключится сам.");
        if (running) await new Promise((res) => setTimeout(res, 5000));
      }
    }
  }
  function stop() { running = false; }

  /**
   * A file in the chat (night backup): get an upload URL → POST the file (field «data») → send a message with the token.
   * Right after the upload MAX may answer attachment.not.ready — then wait and try again.
   */
  async function sendDocument(id, buf, filename, caption = "", { upload = multipartUpload, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const slot = await call("POST", "/uploads?type=file");
    if (!slot || !slot.url) throw new Error("MAX не дал адрес для загрузки файла");
    const up = await upload(slot.url, buf, filename);
    const token = (up && up.token) || slot.token;
    if (!token) throw new Error("MAX не вернул токен загруженного файла");
    const n = String(id).trim();
    const q = Number(n) < 0 ? `chat_id=${encodeURIComponent(n)}` : `user_id=${encodeURIComponent(n)}`;
    let delay = 1500;
    for (let i = 0; ; i++) {
      await wait(delay);
      try { return await call("POST", `/messages?${q}`, { text: String(caption || "").slice(0, 4000), format: "html", attachments: [{ type: "file", payload: { token } }] }); }
      catch (e) { if (i >= 5 || !/not.ready|not\.processed/i.test(e.message)) throw e; delay *= 2; }
    }
  }
  function multipartUpload(url, buf, filename) {
    const ca = trustedCA();
    const boundary = "----digitap" + crypto.randomBytes(8).toString("hex");
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${filename.replace(/[^\w.-]/g, "_")}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const body = Buffer.concat([head, buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "POST", ca, timeout: 120e3,
        headers: { Authorization: token, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } }, (res) => {
        let t = ""; res.setEncoding("utf8"); res.on("data", (c) => (t += c));
        res.on("end", () => { if (res.statusCode >= 400) return reject(new Error(`MAX upload: ${res.statusCode} ${t.slice(0, 200)}`)); let j = {}; try { j = JSON.parse(t); } catch (e) { /* the token may come with the slot */ } resolve(j); });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end(body);
    });
  }

  return {
    call, me, sendMessage, sendPhotos, sendDocument, startPolling, stop, openButton,
    // In MAX the mini app address is set in the partner cabinet (bot settings), not via API.
    setWebAppUrl(url) { currentUrl = url || currentUrl; },
    getWebAppUrl: () => currentUrl,
    getUsername: () => username,
  };
}

module.exports = { validateInitData, signInitData, createBot, extractWebAppData };
