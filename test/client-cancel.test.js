"use strict";
// 29.10.2026: the customer cancels an unpaid order himself (transfer without a receipt, or online payment not finished).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tg = require("../server/telegram");
const { todayISO } = require("../server/orders");
const { createApp } = require("../server/index");

const TOKEN = "123:gag";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const SHOP = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "gagulya.shop.json"), "utf8"));
const P1 = JSON.parse(fs.readFileSync(SEED, "utf8")).products[0];
const user = (id) => tg.signInitData({ id, first_name: "Ильдар", username: "u" + id }, TOKEN);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
async function start() {
  const sent = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); }, sendPhotos: async () => {}, openButton: () => null, getUsername: () => "gagulya_flowers_bot", setWebAppUrl() {} };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccl-"));
  const app = createApp({ messenger: "telegram", botToken: TOKEN, bot, adminIds: "100", dataDir, seedFile: SEED, shop: SHOP, log: { error() {}, log() {} }, noBackup: true });
  const S = app.store.getCatalog().settings;
  S.transfer = { enabled: true, mode: "now", card: "2200 0000 0000 0000", phone: "+79000000000", bank: "Т-Банк", holder: "Илькин А." };
  S.webAppUrl = "https://shop.example";
  app.store.setCatalog(app.store.getCatalog());
  await new Promise((r) => app.server.listen(0, r));
  return { app, sent, url: `http://127.0.0.1:${app.server.address().port}` };
}
const req = async (url, method, body, init) => { const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
const order = () => ({ cart: { lines: [{ id: P1.id, qty: 1 }], addons: {} }, customer: { name: "Ильдар", phone: "+7 900 111-22-33", date: todayISO(), time: "через полчаса", method: "pickup" } });
const find = (app, id) => app.store.getOrders().list.find((o) => String(o.id) === String(id));

test("an order waiting for the transfer and the receipt can be cancelled by the customer; the florist is told", async (t) => {
  const { app, sent, url } = await start(); t.after(() => app.server.close());
  const r = await req(url + "/api/orders", "POST", order(), user(601));
  assert.equal(r.status, 200);
  assert.ok(find(app, r.data.id).awaitReceipt);
  const prof = (await req(url + "/api/profile", "GET", null, user(601))).data;
  assert.equal(prof.orders.find((o) => o.id === r.data.id).cancelable, true);
  assert.equal((await req(url + `/api/orders/${r.data.id}/transfer`, "GET", null, user(601))).data.cancelable, true);
  // someone else can't cancel it
  assert.equal((await req(url + `/api/orders/${r.data.id}/cancel`, "POST", {}, user(602))).status, 404);
  const c = await req(url + `/api/orders/${r.data.id}/cancel`, "POST", {}, user(601));
  assert.equal(c.status, 200); assert.equal(c.data.status, "cancel");
  const o = find(app, r.data.id);
  assert.equal(o.status, "cancel"); assert.equal(o.cancelReason, "Отменён клиентом"); assert.ok(!o.awaitReceipt);
  assert.ok(sent.some((m) => /отменена клиентом/.test(m.text)));
  const prof2 = (await req(url + "/api/profile", "GET", null, user(601))).data;
  const po = prof2.orders.find((x) => x.id === r.data.id);
  assert.equal(po.status, "cancel"); assert.equal(po.cancelable, false);
  // twice is fine
  assert.equal((await req(url + `/api/orders/${r.data.id}/cancel`, "POST", {}, user(601))).status, 200);
  // a cancelled order no longer takes a receipt
  const rc = await fetch(url + `/api/orders/${r.data.id}/receipt`, { method: "POST", headers: { "Content-Type": "image/png", "X-Init-Data": user(601) }, body: PNG });
  assert.equal(rc.status, 400);
});

test("after the receipt is attached the customer can't cancel — only by phone", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const r = await req(url + "/api/orders", "POST", order(), user(611));
  const rc = await fetch(url + `/api/orders/${r.data.id}/receipt`, { method: "POST", headers: { "Content-Type": "image/png", "X-Init-Data": user(611) }, body: PNG });
  assert.equal(rc.status, 200);
  assert.equal((await req(url + `/api/orders/${r.data.id}/transfer`, "GET", null, user(611))).data.cancelable, false);
  const c = await req(url + `/api/orders/${r.data.id}/cancel`, "POST", {}, user(611));
  assert.equal(c.status, 400); assert.match(c.data.error, /позвоните/);
  assert.notEqual(find(app, r.data.id).status, "cancel");
});

test("a paid order or an order in work can't be cancelled by the customer", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const r = await req(url + "/api/orders", "POST", order(), user(621));
  const o = find(app, r.data.id);
  o.paid = true; app.store.saveOrders();
  assert.equal((await req(url + `/api/orders/${r.data.id}/cancel`, "POST", {}, user(621))).status, 400);
  o.paid = false; delete o.awaitReceipt; o.status = "work"; app.store.saveOrders();
  assert.equal((await req(url + `/api/orders/${r.data.id}/cancel`, "POST", {}, user(621))).status, 400);
  assert.equal(find(app, r.data.id).status, "work");
});
