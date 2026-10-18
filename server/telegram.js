"use strict";
const crypto = require("crypto");

/**
 * Validates Telegram Mini App initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns the parsed user object or null.
 */
function validateInitData(initData, botToken, maxAgeSec = 86400, now = Date.now()) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const a = Buffer.from(calc, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || now / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}

/** Builds a signed initData string — used by tests and local dev. */
function signInitData(user, botToken, authDate = Math.floor(Date.now() / 1000), extra = {}) {
  const params = new URLSearchParams(Object.assign({ auth_date: String(authDate), query_id: "TEST", user: JSON.stringify(user) }, extra));
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}

/**
 * apiUrl / relayKey (env TELEGRAM_API_URL, TELEGRAM_RELAY_KEY): when the shop runs on a server in Russia that can't reach
 * api.telegram.org, every call goes through our small relay abroad (relay/index.js) — it stores nothing.
 */
function createBot({ token, webAppUrl, log = console, apiUrl = process.env.TELEGRAM_API_URL || "", relayKey = process.env.TELEGRAM_RELAY_KEY || "" }) {
  const api = String(apiUrl || "https://api.telegram.org").replace(/\/+$/, "");
  const viaRelay = api !== "https://api.telegram.org";
  const base = `${api}/bot${token}`;
  const H = (h) => Object.assign(h || {}, viaRelay && relayKey ? { "X-Relay-Key": relayKey } : {});
  async function call(method, body) {
    const res = await fetch(`${base}/${method}`, { method: "POST", headers: H({ "Content-Type": "application/json" }), body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
    return data.result;
  }
  let currentUrl = webAppUrl || "";
  let username = "";
  /** The «open» button. payload (e.g. rv_1-s_otzyv) goes to the app as ?start=… — buttons don't carry Telegram's start_param. */
  const openButton = (text, payload = "") => ({ inline_keyboard: [[{ text, web_app: { url: currentUrl + (payload && /^[A-Za-z0-9_-]{1,64}$/.test(payload) ? (currentUrl.includes("?") ? "&" : "?") + "start=" + payload : "") } }]] });
  const setMenu = () => currentUrl ? call("setChatMenuButton", { menu_button: { type: "web_app", text: "Каталог", web_app: { url: currentUrl } } }) : Promise.resolve();
  /** Changes the mini app address (e.g. detected from the hosting domain) and updates the bot's menu button. */
  function setWebAppUrl(url) {
    if (!url || url === currentUrl) return;
    currentUrl = url;
    setMenu().catch((e) => log.error("Menu button: " + e.message));
  }

  async function sendMessage(chatId, text, extra) {
    return call("sendMessage", Object.assign({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }, extra || {}));
  }

  /** Photos of an order (public https links). One photo — sendPhoto, several — an album with the caption on the first. */
  async function sendPhotos(chatId, urls, caption) {
    urls = (urls || []).slice(0, 10);
    if (!urls.length) return null;
    try {
      if (urls.length === 1) return await call("sendPhoto", { chat_id: chatId, photo: urls[0], caption: String(caption || "").slice(0, 1000) });
      return await call("sendMediaGroup", { chat_id: chatId, media: urls.map((u, i) => Object.assign({ type: "photo", media: u }, i ? {} : { caption: String(caption || "").slice(0, 1000) })) });
    } catch (e) {
      // Telegram could not fetch the pictures by link (e.g. the shop's server is in Russia) — upload them as files instead
      const fd = new FormData();
      fd.append("chat_id", String(chatId));
      const media = [];
      for (const [i, u] of urls.entries()) {
        const r = await fetch(u).catch(() => null);
        if (!r || !r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        fd.append("f" + i, new Blob([buf], { type: r.headers.get("content-type") || "image/jpeg" }), "photo" + i + ".jpg");
        media.push(Object.assign({ type: "photo", media: "attach://f" + i }, media.length ? {} : { caption: String(caption || "").slice(0, 1000) }));
      }
      if (!media.length) throw e;
      let method = "sendMediaGroup";
      if (media.length === 1) {
        // one picture: sendPhoto (an album needs at least two)
        method = "sendPhoto";
        const f = fd.get(media[0].media.replace("attach://", ""));
        fd.delete(media[0].media.replace("attach://", ""));
        fd.append("photo", f, "photo.jpg");
        fd.append("caption", String(caption || "").slice(0, 1000));
      } else fd.append("media", JSON.stringify(media));
      const res = await fetch(`${base}/${method}`, { method: "POST", headers: H(), body: fd });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
      return data.result;
    }
  }

  /** A file in the chat (night backup). Telegram bots may send files up to 50 MB. */
  async function sendDocument(chatId, buf, filename, caption = "") {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    fd.append("caption", String(caption || "").slice(0, 1000));
    fd.append("parse_mode", "HTML");
    fd.append("document", new Blob([buf], { type: "application/zip" }), filename);
    const res = await fetch(`${base}/sendDocument`, { method: "POST", headers: H(), body: fd });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram sendDocument: ${data.description || res.status}`);
    return data.result;
  }

  let running = false;
  async function startPolling(hooks) {
    hooks = hooks || {};
    if (running) return;
    running = true;
    try {
      try { username = (await call("getMe")).username || ""; } catch (e) { /* not critical */ }
      await call("deleteWebhook", { drop_pending_updates: false });
      await setMenu();
      await call("setMyCommands", { commands: [{ command: "start", description: "Открыть каталог" }, { command: "id", description: "Мой Telegram ID" }] });
    } catch (e) { log.error("Bot setup:", e.message); }
    let offset = 0;
    while (running) {
      try {
        const updates = await call("getUpdates", { offset, timeout: viaRelay ? 25 : 50, allowed_updates: ["message"] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text) continue;
          const chatId = m.chat.id;
          if (m.text.startsWith("/start")) {
            const res = (hooks.onStart && hooks.onStart(m.from || {}, m.text.slice(6).trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64))) || "";
            const extra = typeof res === "string" ? res : res.text || "";
            // the shop's own greeting from its settings (botGreeting), like in MAX
            const greet = (typeof res === "object" && res.greeting) || (hooks.greeting && hooks.greeting()) ||
              "Здравствуйте! Это <b>Sweet Roses</b> — мастерская клубники в шоколаде в Иркутске 🍓\n\nНажмите кнопку ниже, чтобы выбрать подарок и оставить заявку. Менеджер перезвонит в течение 10 минут (ежедневно 10:00–20:00).";
            const btn = (typeof res === "object" && res.button) || "Открыть каталог";
            const appPayload = typeof res === "object" && res.appPayload != null ? res.appPayload : m.text.slice(6).trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
            await sendMessage(chatId, greet + extra, currentUrl ? { reply_markup: openButton(btn, appPayload) } : {}).catch((e) => log.error(e.message));
          } else if (m.text.startsWith("/id")) {
            const admin = hooks.isAdmin && hooks.isAdmin(m.from && m.from.id);
            await sendMessage(chatId, `ID этого чата: <code>${chatId}</code>${admin ? "\n\nВставьте его в «Управление → Настройки → Куда присылать заявки»." : ""}`).catch((e) => log.error(e.message));
          }
        }
      } catch (e) {
        if (/Conflict/i.test(e.message)) log.error("Этот бот уже запущен в другом месте (например, на компьютере). Остановите второй запуск — работать должен только один.");
        else log.error("Нет связи с Telegram (" + e.message + "). Бот переподключится сам.");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  function stop() { running = false; }

  return { call, sendMessage, sendPhotos, sendDocument, startPolling, stop, openButton, setWebAppUrl, getWebAppUrl: () => currentUrl, getUsername: () => username };
}

module.exports = { validateInitData, signInitData, createBot };
