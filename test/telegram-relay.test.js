"use strict";
// 18.10.2026: the shop's server in Russia talks to Telegram through our relay abroad (relay/index.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createRelay } = require("../relay/index.js");
const tg = require("../server/telegram");

const TOKEN = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ012345";
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));

test("bot → relay → Telegram: messages, files, photos by upload; a wrong key is refused", async (t) => {
  const seen = [];
  // fake Telegram: refuses photos by link (as if it can't reach a server in Russia), accepts uploads
  const fake = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("latin1");
    seen.push({ url: req.url, type: req.headers["content-type"] || "", body, relayKey: req.headers["x-relay-key"] });
    res.setHeader("Content-Type", "application/json");
    if (/sendPhoto$/.test(req.url) && /json/.test(req.headers["content-type"] || "")) return res.end(JSON.stringify({ ok: false, description: "Bad Request: wrong file identifier/HTTP URL specified" }));
    if (req.url === "/") return res.end("{}");
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  const pic = http.createServer((req, res) => { res.setHeader("Content-Type", "image/png"); res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])); });
  const tgUrl = await listen(fake), picUrl = await listen(pic);
  const relay = createRelay({ key: "secret-word-for-test", target: tgUrl });
  const relayUrl = await listen(relay);
  t.after(() => { fake.close(); pic.close(); relay.close(); });

  const bot = tg.createBot({ token: TOKEN, webAppUrl: "https://shop.example", apiUrl: relayUrl, relayKey: "secret-word-for-test", log: { error() {} } });
  await bot.sendMessage(100, "Заявка №1001");
  const m = seen.find((x) => x.url === `/bot${TOKEN}/sendMessage`);
  assert.ok(m && m.body.includes("1001"));
  assert.equal(m.relayKey, undefined, "the key is not passed on to Telegram");
  await bot.sendDocument(100, Buffer.from("zip"), "backup.zip", "копия");
  assert.ok(seen.some((x) => x.url.endsWith("/sendDocument") && /multipart/.test(x.type)));
  // photo by link refused → sent as an upload
  await bot.sendPhotos(100, [picUrl + "/u/a.png"], "Чек об оплате");
  assert.ok(seen.some((x) => x.url.endsWith("/sendPhoto") && /multipart/.test(x.type) && x.body.includes("PNG")));
  // a wrong key / no key / a foreign path
  const bad = tg.createBot({ token: TOKEN, apiUrl: relayUrl, relayKey: "wrong", log: { error() {} } });
  await assert.rejects(bad.sendMessage(1, "x"), /Неверный ключ|403/);
  assert.equal((await fetch(relayUrl + "/evil.com/x", { headers: { "X-Relay-Key": "secret-word-for-test" } })).status, 404);
  // health check
  const h = await (await fetch(relayUrl + "/")).json();
  assert.equal(h.relay, "работает"); assert.equal(h.keySet, true); assert.equal(h.telegram, "доступен");
  // without a key the relay passes nothing
  const open = createRelay({ key: "", target: tgUrl }); const openUrl = await listen(open); t.after(() => open.close());
  assert.equal((await fetch(openUrl + `/bot${TOKEN}/sendMessage`, { method: "POST" })).status, 503);
});

test("without TELEGRAM_API_URL the bot talks to Telegram directly, as before", () => {
  const src = require("fs").readFileSync(require.resolve("../server/telegram.js"), "utf8");
  assert.match(src, /https:\/\/api\.telegram\.org/);
});

test("shop front door abroad: pages, API with the customer's signature, uploads and redirects go to the shop in Russia", async (t) => {
  const seen = [];
  const shop = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({ method: req.method, url: req.url, init: req.headers["x-init-data"], ip: req.headers["x-forwarded-for"], size: Buffer.concat(chunks).length, type: req.headers["content-type"] });
    if (req.url === "/old") { res.writeHead(302, { Location: "/new" }); return res.end(); }
    if (req.url.startsWith("/api/")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true })); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); res.end("<title>Gagulya</title>");
  });
  const shopUrl = await listen(shop);
  const front = createRelay({ key: "", shop: shopUrl, target: shopUrl }); const frontUrl = await listen(front);
  t.after(() => { shop.close(); front.close(); });
  const page = await fetch(frontUrl + "/?start=rv_1#x");
  assert.equal(page.status, 200); assert.match(await page.text(), /Gagulya/);
  assert.equal(seen[0].url, "/?start=rv_1");
  const api = await fetch(frontUrl + "/api/orders", { method: "POST", headers: { "Content-Type": "application/json", "X-Init-Data": "sig", "X-Forwarded-For": "1.2.3.4" }, body: JSON.stringify({ a: 1 }) });
  assert.deepEqual(await api.json(), { ok: true });
  const s = seen.find((x) => x.url === "/api/orders");
  assert.equal(s.init, "sig"); assert.equal(s.ip, "1.2.3.4"); assert.equal(s.size, 7);
  const up = await fetch(frontUrl + "/api/admin/upload", { method: "POST", headers: { "Content-Type": "image/png" }, body: Buffer.alloc(300000, 1) });
  assert.equal(up.status, 200); assert.equal(seen.at(-1).size, 300000);
  const r = await fetch(frontUrl + "/old", { redirect: "manual" }); assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/new");
  const h = await (await fetch(frontUrl + "/__relay")).json();
  assert.equal(h.shop, "магазин в России доступен");
  // the shop is down → a clear page, not a grey screen
  shop.close(); await new Promise((r) => setTimeout(r, 50));
  const down = await fetch(frontUrl + "/"); assert.equal(down.status, 502); assert.match(await down.text(), /временно недоступен/);
});
