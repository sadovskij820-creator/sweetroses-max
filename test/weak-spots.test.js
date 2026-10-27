"use strict";
// 27.10.2026: bad network and slips — one order per tap, no 0 ₽ orders, a limit on receipts, notifications repeated.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tg = require("../server/telegram");
const { createApp } = require("../server/index");

const TOKEN = "123:weak";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const SHOP = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "gagulya.shop.json"), "utf8"));
const user = (id) => tg.signInitData({ id, first_name: "Ильдар", username: "u" + id }, TOKEN);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
async function start(extra = {}) {
  const sent = [];
  let failNext = 0;
  const bot = { sendMessage: async (chat, text) => { if (failNext > 0) { failNext--; throw new Error("fetch failed"); } sent.push({ chat: String(chat), text }); }, sendPhotos: async (chat) => { sent.push({ chat: String(chat), text: "PHOTOS" }); }, openButton: () => null, getUsername: () => "gagulya_flowers_bot", setWebAppUrl() {} };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const app = createApp(Object.assign({ messenger: "telegram", botToken: TOKEN, bot, adminIds: "100", dataDir, seedFile: SEED, shop: SHOP, log: { error() {}, log() {} }, noBackup: true, notifyRetry: [30, 60] }, extra));
  const S = app.store.getCatalog().settings;
  S.transfer = { enabled: true, mode: "now", card: "2200 0000 0000 0000", phone: "+79000000000" };
  app.store.setCatalog(app.store.getCatalog());
  await new Promise((r) => app.server.listen(0, r));
  return { app, sent, url: `http://127.0.0.1:${app.server.address().port}`, fail: (n) => (failNext = n) };
}
const tomorrow = () => new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const order = (pid, extra = {}) => Object.assign({ cart: { lines: [{ id: pid, qty: 1 }], addons: {} }, customer: { name: "Ильдар", phone: "+7 900 111-22-33", date: tomorrow(), time: "к 18:00", method: "pickup" } }, extra);
const post = (url, body, id) => fetch(url + "/api/orders", { method: "POST", headers: { "Content-Type": "application/json", "X-Init-Data": user(id) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

test("one tap = one order: the same key twice (lost answer, second tap) gives the same order", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const p = app.store.getCatalog().products.find((x) => !x.hidden && x.price > 0);
  const [a, b] = await Promise.all([post(url, order(p.id, { orderKey: "abcdefgh123" }), 501), post(url, order(p.id, { orderKey: "abcdefgh123" }), 501)]);
  const c = await post(url, order(p.id, { orderKey: "abcdefgh123" }), 501);
  assert.equal(a.status, 200); assert.equal(a.data.id, b.data.id); assert.equal(a.data.id, c.data.id);
  assert.equal(app.store.getOrders().list.length, 1);
  const d = await post(url, order(p.id, { orderKey: "other-key-99" }), 501);
  assert.notEqual(d.data.id, a.data.id);
  // a refused order (bad date) does not block the key
  const bad = await post(url, order(p.id, { orderKey: "retrykey-01", customer: { name: "И", phone: "1", date: "2020-01-01", time: "x", method: "pickup" } }), 502);
  assert.equal(bad.status, 400);
  assert.equal((await post(url, order(p.id, { orderKey: "retrykey-01" }), 502)).status, 200);
});

test("a bouquet switched on without a price can't be ordered for 0 ₽", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const c = app.store.getCatalog(); const p = c.products.find((x) => !x.hidden); p.price = 0; app.store.setCatalog(c);
  const r = await post(url, order(p.id), 503);
  assert.equal(r.status, 400); assert.match(r.data.error, /цена уточняется/);
  assert.equal(app.store.getOrders().list.length, 0);
});

test("receipts: at most 5 for one order", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const p = app.store.getCatalog().products.find((x) => !x.hidden && x.price > 0);
  const o = await post(url, order(p.id), 504);
  const send = () => fetch(url + `/api/orders/${o.data.id}/receipt`, { method: "POST", headers: { "X-Init-Data": user(504) }, body: PNG }).then((r) => r.status);
  for (let i = 0; i < 5; i++) assert.equal(await send(), 200);
  assert.equal(await send(), 429);
});

test("a notification that failed on a network blip is sent again by itself (with the photos)", async (t) => {
  const { app, sent, url, fail } = await start(); t.after(() => app.server.close());
  app.onBotStart({ id: 100, first_name: "Гагуля" }, "");
  const p = app.store.getCatalog().products.find((x) => !x.hidden && x.price > 0 && x.images && x.images.length);
  fail(1);
  const o = await post(url, order(p.id), 505);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!sent.some((m) => m.chat === "100" && m.text.includes(`№${o.data.id}`)), "the first try failed");
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(sent.some((m) => m.chat === "100" && m.text.includes(`№${o.data.id}`)), "sent again");
});
