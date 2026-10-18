"use strict";
// Gagulya 18.10.2026: wished time as text, customer + recipient, the order reaches the florist only with a receipt,
// no levels and no review bonus (fixed options of the shop, catalog.shop.json).
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
async function start(shop = SHOP) {
  const sent = [], photos = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); }, sendPhotos: async (chat, urls, cap) => { photos.push({ chat: String(chat), urls, cap }); }, openButton: () => null, getUsername: () => "gagulya_flowers_bot", setWebAppUrl() {} };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gco-"));
  const app = createApp({ messenger: "telegram", botToken: TOKEN, bot, adminIds: "100", dataDir, seedFile: SEED, shop, log: { error() {}, log() {} }, noBackup: true });
  const S = app.store.getCatalog().settings;
  S.transfer = { enabled: true, mode: "now", card: "2200 0000 0000 0000", phone: "+79000000000", bank: "Т-Банк", holder: "Илькин А." };
  S.webAppUrl = "https://shop.example";
  app.store.setCatalog(app.store.getCatalog());
  await new Promise((r) => app.server.listen(0, r));
  return { app, sent, photos, url: `http://127.0.0.1:${app.server.address().port}` };
}
const req = async (url, method, body, init) => { const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
const customer = (extra = {}) => Object.assign({ name: "Ильдар", phone: "+7 900 111-22-33", date: todayISO(), time: "через полчаса", method: "pickup" }, extra);
const order = (c) => ({ cart: { lines: [{ id: P1.id, qty: 1 }], addons: {} }, customer: c });
const find = (app, id) => app.store.getOrders().list.find((o) => String(o.id) === String(id));

test("the shop's options reach the app; levels and the review bonus are gone, even from the settings", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const c = (await req(url + "/api/catalog", "GET")).data;
  assert.deepEqual(c.shop, { noLevels: true, noReviewBonus: true, timeText: true, recipient: true, receipt: true, commentHint: SHOP.commentHint });
  assert.equal(c.loyalty.features.levels, false);
  assert.equal(c.loyalty.levels[0].percent, 0);
  assert.equal(c.reviews.bonus, 0);
  assert.equal(c.loyalty.welcomeBonus, 200);
  assert.equal(c.loyalty.referral.friendBonus, 300);
  const a = (await req(url + "/api/admin/catalog", "GET", null, user(100))).data;
  assert.equal(a.shop.noLevels, true);
  // the owner saves the bonus settings — levels can't come back
  await req(url + "/api/admin/settings", "PUT", { loyalty: { features: { levels: true }, reviewBonus: 500 } }, user(100));
  const c2 = (await req(url + "/api/catalog", "GET")).data;
  assert.equal(c2.loyalty.features.levels, false); assert.equal(c2.reviews.bonus, 0);
});

test("wished time is free text; «another person» needs the recipient's name and phone", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const bad = await req(url + "/api/orders", "POST", order(customer({ time: "" })), user(501));
  assert.equal(bad.status, 400); assert.match(bad.data.error, /желаемое время/);
  const noRcp = await req(url + "/api/orders", "POST", order(customer({ forOther: true })), user(501));
  assert.equal(noRcp.status, 400); assert.match(noRcp.data.error, /получателя/);
  const ok = await req(url + "/api/orders", "POST", order(customer({ forOther: true, recipientName: "Анна", recipientPhone: "+7 999 222-33-44", method: "delivery", zoneId: "zokt", address: "Ленина 1, кв 5" })), user(501));
  assert.equal(ok.status, 200);
  const o = find(app, ok.data.id);
  assert.deepEqual(o.recipient, { name: "Анна", phone: "+7 999 222-33-44" });
  assert.equal(o.time, "через полчаса");
  const self = await req(url + "/api/orders", "POST", order(customer({ time: "20:45" })), user(502));
  assert.equal(find(app, self.data.id).recipient, null);
  const list = (await req(url + "/api/admin/orders", "GET", null, user(100))).data.orders;
  const s1 = list.find((x) => x.id === ok.data.id).summary;
  assert.match(s1, /Заказчик: Ильдар, \+7 900 111-22-33/);
  assert.match(s1, /Получатель: Анна, \+7 999 222-33-44/);
  assert.match(s1, /время: через полчаса/);
  assert.match(list.find((x) => x.id === self.data.id).summary, /Получатель: сам заказчик/);
});

test("pay by transfer: the florist sees the order at once, the receipt comes as a separate message", async (t) => {
  const { app, sent, photos, url } = await start(); t.after(() => app.server.close());
  app.onBotStart({ id: 100, first_name: "Гагуля" }, "");
  const r = await req(url + "/api/orders", "POST", order(customer()), user(501));
  assert.equal(r.status, 200);
  assert.equal(r.data.transfer.receiptNeeded, true);
  await new Promise((x) => setTimeout(x, 40));
  const first = sent.find((m) => m.chat === "100" && m.text.includes(`№${r.data.id}`));
  assert.ok(first, "the florist sees the order at once (to call if no payment)");
  assert.match(first.text, /Ждём оплату переводом и чек/);
  assert.ok(sent.some((m) => m.chat === "501" && /оформлен/.test(m.text) && /прикрепите чек/.test(m.text)));
  assert.equal((await req(url + `/api/orders/${r.data.id}/transfer`, "POST", {}, user(501))).status, 400);
  assert.equal((await fetch(url + `/api/orders/${r.data.id}/receipt`, { method: "POST", headers: { "X-Init-Data": user(501) }, body: "hello" })).status, 400);
  assert.equal((await fetch(url + `/api/orders/${r.data.id}/receipt`, { method: "POST", headers: { "X-Init-Data": user(777) }, body: PNG })).status, 404);
  const up = await fetch(url + `/api/orders/${r.data.id}/receipt`, { method: "POST", headers: { "X-Init-Data": user(501) }, body: PNG });
  assert.equal(up.status, 200);
  const info = await up.json();
  assert.equal(info.receipt, true); assert.equal(info.receiptNeeded, false);
  await new Promise((x) => setTimeout(x, 40));
  assert.ok(sent.some((x) => x.chat === "100" && /прикрепил чек/.test(x.text) && x.text.includes(`№${r.data.id}`)));
  assert.ok(photos.some((p) => p.chat === "100" && /Чек об оплате/.test(p.cap) && /^https:\/\/shop\.example\/u\//.test(p.urls[0])));
  assert.ok(sent.some((x) => x.chat === "501" && /Чек по заказу/.test(x.text)));
  const o = find(app, r.data.id);
  assert.ok(o.receipt && !o.awaitReceipt && o.transferClaimedAt);
  await req(url + `/api/admin/orders/${r.data.id}`, "PATCH", { paid: true }, user(100));
  assert.equal(find(app, r.data.id).paid, true);
});

test("no receipt: the customer is reminded after 15 minutes, the florist after 30; nothing is cancelled", async (t) => {
  const { app, sent, url } = await start(); t.after(() => app.server.close());
  app.onBotStart({ id: 100, first_name: "Гагуля" }, "");
  const r = await req(url + "/api/orders", "POST", order(customer()), user(601));
  const o = find(app, r.data.id);
  o.createdAt = new Date(Date.now() - 10 * 60e3).toISOString();
  await app.runJobs(new Date());
  assert.ok(!sent.some((m) => m.chat === "601" && /прикрепите, пожалуйста, чек/.test(m.text)));
  o.createdAt = new Date(Date.now() - 18 * 60e3).toISOString();
  await app.runJobs(new Date());
  assert.equal(sent.filter((m) => m.chat === "601" && /прикрепите, пожалуйста, чек/.test(m.text)).length, 1);
  assert.ok(!sent.some((m) => m.chat === "100" && /30 минут без чека/.test(m.text)));
  o.createdAt = new Date(Date.now() - 35 * 60e3).toISOString();
  await app.runJobs(new Date()); await app.runJobs(new Date());
  assert.equal(sent.filter((m) => m.chat === "100" && /30 минут без чека/.test(m.text)).length, 1, "once");
  assert.equal(sent.filter((m) => m.chat === "601" && /прикрепите, пожалуйста, чек/.test(m.text)).length, 1, "once");
  o.createdAt = new Date(Date.now() - 5 * 3600e3).toISOString();
  await app.runJobs(new Date());
  assert.equal(o.status, "new", "never cancelled automatically");
  // a finished order gives no bonus (no levels)
  const r2 = await req(url + "/api/orders", "POST", order(customer({ time: "21:00" })), user(602));
  await fetch(url + `/api/orders/${r2.data.id}/receipt`, { method: "POST", headers: { "X-Init-Data": user(602) }, body: PNG });
  await req(url + `/api/admin/orders/${r2.data.id}`, "PATCH", { status: "done" }, user(100));
  assert.ok(!find(app, r2.data.id).bonusAccrued);
});

test("a shop without these options works as before (slots, «Я оплатил», levels)", async (t) => {
  const { app, sent, url } = await start({}); t.after(() => app.server.close());
  app.onBotStart({ id: 100, first_name: "Илья" }, "");
  assert.equal((await req(url + "/api/orders", "POST", order(customer({ time: "через полчаса" })), user(701))).status, 400);
  const slot = app.store.getCatalog().settings.timeSlots.slice(-1)[0];
  const r = await req(url + "/api/orders", "POST", order(customer({ time: slot, date: todayISO(new Date(Date.now() + 864e5)) })), user(701));
  assert.equal(r.status, 200);
  assert.ok(!r.data.transfer.receiptNeeded);
  await new Promise((x) => setTimeout(x, 40));
  assert.ok(sent.some((m) => m.chat === "100" && m.text.includes(`№${r.data.id}`)), "the order comes at once, as before");
  assert.equal((await req(url + "/api/catalog", "GET")).data.loyalty.features.levels, true);
});

test("the «pay and attach the receipt» button opens the payment page of that very order", async (t) => {
  const LY = require("../server/loyalty");
  assert.deepEqual(LY.parseStart("pay_1010"), { pay: "1010" });
  assert.deepEqual(LY.parseStart("pay_abc"), {});
  const { app, url } = await start(); t.after(() => app.server.close());
  const r = await req(url + "/api/orders", "POST", order(customer()), user(501));
  assert.equal(r.status, 200);
  const sp = (id, v) => tg.signInitData({ id, first_name: "К" }, TOKEN, undefined, { start_param: v });
  assert.equal((await req(url + "/api/me", "GET", null, sp(501, "pay_" + r.data.id))).data.start.transfer, String(r.data.id));
  // someone else's order is not opened
  assert.equal((await req(url + "/api/me", "GET", null, sp(502, "pay_" + r.data.id))).data.start.transfer, undefined);
  // the order also shows up in the customer's profile as waiting (the banner on the home page and the cart)
  assert.ok((await req(url + "/api/profile", "GET", null, user(501))).data.orders.some((o) => o.id === r.data.id && o.awaitReceipt));
});
