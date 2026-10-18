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
// Shop front door (19.10.2026): customers open the mini app here (abroad, reachable with any VPN); every request goes on
// to the shop's server in Russia, where all data is stored. Nothing is stored or logged here.
const SHOP = (process.env.SHOP_ORIGIN || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT) || 3000;
const TG = "https://api.telegram.org";
const MAX_BODY = 55 * 1024 * 1024; // bots may send files up to 50 MB
const PATH_RE = /^\/(file\/)?bot\d+:[A-Za-z0-9_-]{20,}\/[A-Za-z0-9_./-]{1,200}$/;

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const PASS_REQ = ["content-type", "x-init-data", "x-platform", "x-start-param", "user-agent", "accept", "accept-language", "if-none-match", "if-modified-since", "range"];
const PASS_RES = ["content-type", "cache-control", "etag", "last-modified", "location", "content-range", "accept-ranges", "content-disposition"];

async function proxyShop(req, res, shop, fetchImpl) {
  const headers = {};
  for (const h of PASS_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  if (fwd) headers["x-forwarded-for"] = fwd;
  let body;
  if (!["GET", "HEAD"].includes(req.method)) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413); return res.end(); } chunks.push(c); }
    body = Buffer.concat(chunks);
  }
  try {
    const r = await fetchImpl(shop + req.url, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(60000) });
    const out = {};
    for (const h of PASS_RES) { const v = r.headers.get(h); if (v) out[h] = v; }
    const buf = req.method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, out); res.end(buf);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<meta name=viewport content='width=device-width'><p style='font:16px sans-serif;padding:24px'>Магазин временно недоступен. Попробуйте через минуту.</p>");
  }
}

function createRelay({ key = KEY, target = TG, shop = SHOP, fetchImpl = fetch } = {}) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
    const url = (req.url || "/").split("?")[0];
    // a check from the browser: is the relay alive, does it reach Telegram and the shop in Russia?
    if (url === "/__relay" || (!shop && (url === "/" || url === "/health"))) {
      let telegram = false, shopOk = null;
      try { const r = await fetchImpl(target + "/", { method: "GET", signal: AbortSignal.timeout(8000) }); telegram = r.status > 0; } catch (e) { telegram = false; }
      if (shop) { try { const r = await fetchImpl(shop + "/api/catalog", { signal: AbortSignal.timeout(10000) }); shopOk = r.ok; } catch (e) { shopOk = false; } }
      return send(200, Object.assign({ ok: true, relay: "работает", keySet: !!key, telegram: telegram ? "доступен" : "НЕ доступен" }, shop ? { shop: shopOk ? "магазин в России доступен" : "магазин в России НЕ доступен" } : {}));
    }
    // everything that is not a bot call goes to the shop
    if (shop && !PATH_RE.test(url)) return proxyShop(req, res, shop, fetchImpl);
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
  createRelay().listen(PORT, () => console.log(`Пересылка запущена на порту ${PORT}${SHOP ? " · магазин: " + SHOP : ""}${KEY ? "" : " · RELAY_KEY не задан (пересылка Telegram выключена)"}`));
}
module.exports = { createRelay };
