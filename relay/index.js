"use strict";
/**
 * Telegram relay (DigiTap, 18.10.2026).
 * The shop's server is in Russia (the law: customers' data is stored there) and can't reach api.telegram.org.
 * This tiny server runs abroad and only passes the bot's requests to Telegram and the answers back.
 * It stores NOTHING and logs no message contents. Only requests with the right X-Relay-Key are passed.
 * Settings (Amvera → Variables): RELAY_KEY — the same long random word as TELEGRAM_RELAY_KEY in the shop.
 */
const http = require("http");
const crypto = require("crypto");

const KEY = process.env.RELAY_KEY || "";
const PORT = Number(process.env.PORT) || 3000;
const TG = "https://api.telegram.org";
const MAX_BODY = 55 * 1024 * 1024; // bots may send files up to 50 MB
const PATH_RE = /^\/(file\/)?bot\d+:[A-Za-z0-9_-]{20,}\/[A-Za-z0-9_./-]{1,200}$/;

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function createRelay({ key = KEY, target = TG, fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
    const url = (req.url || "/").split("?")[0];
    // a check from the browser or the shop: is the relay alive and does it reach Telegram?
    if (url === "/" || url === "/health") {
      let telegram = false;
      try { const r = await fetchImpl(target + "/", { method: "GET", signal: AbortSignal.timeout(8000) }); telegram = r.status > 0; } catch (e) { telegram = false; }
      return send(200, { ok: true, relay: "работает", keySet: !!key, telegram: telegram ? "доступен" : "НЕ доступен" });
    }
    if (!key) return send(503, { ok: false, description: "RELAY_KEY не задан в переменных" });
    if (!same(req.headers["x-relay-key"] || "", key)) return send(403, { ok: false, description: "Неверный ключ пересылки" });
    if (!PATH_RE.test(url) || !["GET", "POST"].includes(req.method)) return send(404, { ok: false, description: "Не найдено" });
    const chunks = []; let size = 0;
    try {
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(413, { ok: false, description: "Слишком большой файл" }); chunks.push(c); }
      const headers = {};
      if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
      const r = await fetchImpl(target + req.url, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(90000) });
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
      res.end(body);
    } catch (e) {
      send(502, { ok: false, description: "Telegram не ответил: " + (e.name === "TimeoutError" ? "долго ждали" : "нет связи") });
    }
  });
}

if (require.main === module) {
  createRelay().listen(PORT, () => console.log(`Пересылка Telegram запущена на порту ${PORT}${KEY ? "" : " — ВНИМАНИЕ: RELAY_KEY не задан"}`));
}
module.exports = { createRelay };
