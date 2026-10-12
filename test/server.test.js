"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateInitData, signInitData } = require("../server/telegram");
const { computeTotals } = require("../public/pricing.js");
const { validateCustomer, todayISO } = require("../server/orders");
const { mergeProducts, mapProduct } = require("../server/tilda");
const { createApp } = require("../server/index");

const TOKEN = "123456:TEST-token";
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "catalog.seed.json"), "utf8"));
const P1 = seed.products.find((p) => p.title === "Бокс клубника в шоколаде S"); // 3200
const P2 = seed.products.find((p) => p.title === "12 клубничек в шоколаде"); // 2250

test("initData: valid signature accepted, tampered/expired rejected", () => {
  const user = { id: 42, first_name: "Аня" };
  const good = signInitData(user, TOKEN);
  assert.equal(validateInitData(good, TOKEN).id, 42);
  assert.equal(validateInitData(good.replace("%D0%90", "%D0%91"), TOKEN), null);
  assert.equal(validateInitData(good, "other:token"), null);
  const old = signInitData(user, TOKEN, Math.floor(Date.now() / 1000) - 2 * 86400);
  assert.equal(validateInitData(old, TOKEN), null);
  assert.equal(validateInitData("", TOKEN), null);
});

test("pricing: lines, addons, promo, first-order rule, hidden items", () => {
  const cart = { lines: [{ id: P1.id, qty: 2, choc: ["Руби", "Белый", "Лишний"] }], addons: { card: 1, bag: 1 } };
  const t = computeTotals(seed, cart, { promoCode: " клубника " });
  assert.equal(t.subtotal, 3200 * 2 + 50 + 200);
  assert.equal(t.discount, Math.round(t.subtotal * 0.05));
  assert.deepEqual(t.lines[0].choc, ["Руби", "Белый"]);
  assert.equal(computeTotals(seed, cart, { promoCode: "КЛУБНИКА", isFirstOrder: false }).discount, 0);
  assert.match(computeTotals(seed, cart, { promoCode: "НЕТ" }).promoError, /нет/);
  const hidden = JSON.parse(JSON.stringify(seed));
  hidden.products.find((p) => p.id === P1.id).hidden = true;
  assert.equal(computeTotals(hidden, cart).errors.length, 1);
});

test("customer validation", () => {
  const ok = { name: "Аня", phone: "+7 908 666-72-02", date: todayISO(new Date(Date.now() + 864e5)), time: "12:00", method: "pickup" };
  assert.deepEqual(validateCustomer(ok, seed.settings).errors, []);
  assert.ok(validateCustomer({ ...ok, phone: "123" }, seed.settings).errors.length);
  assert.ok(validateCustomer({ ...ok, time: "03:00" }, seed.settings).errors.length);
  assert.ok(validateCustomer({ ...ok, date: "2020-01-01" }, seed.settings).errors.length);
  assert.ok(validateCustomer({ ...ok, method: "delivery", address: "" }, seed.settings).errors.length);
});

test("tilda import keeps admin choices and adds new products", () => {
  const c = JSON.parse(JSON.stringify(seed));
  const cur = c.products.find((p) => p.id === P1.id);
  cur.hidden = true; cur.sort = 999;
  const site = [Object.assign(mapProduct({ uid: P1.id, title: "Бокс S", price: "3300.0000", priceold: "", text: "Текст * Можно выбрать 2 вида шоколада", gallery: "[]" }), { cats: ["chocolate"] }),
    Object.assign(mapProduct({ uid: "777", title: "Новинка", price: "100", gallery: '[{"img":"https://static.tildacdn.com/a/b.jpg"}]' }), { cats: ["top"] })];
  const r = mergeProducts(c, site);
  assert.equal(r.updated, 1); assert.equal(r.added, 1);
  assert.equal(cur.price, 3300); assert.equal(cur.hidden, true); assert.equal(cur.sort, 999);
  assert.ok(cur.images.length, "keeps old photos when site returns none");
  assert.equal(c.products.find((p) => p.id === "777").images[0], "https://static.tildacdn.com/a/b.jpg");
});

/* ---------------- HTTP end-to-end ---------------- */
function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-"));
  const sent = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); } };
  const app = createApp({ botToken: TOKEN, adminIds: "100", dataDir, bot, log: { error() {} }, ...extra });
  app.store.getCatalog().settings.payments = { enabled: false, provider: "demo" }; // payment flows are tested separately
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, sent, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const asUser = (id) => signInitData({ id, first_name: "U" + id, username: "user" + id }, TOKEN);
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const goodOrder = () => ({
  cart: { lines: [{ id: P1.id, qty: 1, choc: ["Руби"] }, { id: P2.id, qty: 2 }], addons: { card: 1 }, cardText: "С днём рождения!" },
  promoCode: "Клубника",
  customer: { name: "Анна", phone: "+7 900 111-22-33", date: todayISO(new Date(Date.now() + 864e5)), time: "14:00", method: "delivery", address: "ул. Ленина, 1, кв 2", comment: "<b>без орехов</b>" },
});

test("public catalog hides admin-only data", async () => {
  const { app, url } = await startApp();
  const { data } = await req(url + "/api/catalog", "GET");
  assert.equal(data.products.length, seed.products.length);
  assert.deepEqual(data.promos, []);
  assert.equal(data.settings.managerChatIds, undefined);
  assert.equal(data.settings.tildaParts, undefined);
  app.server.close();
});

test("order flow: server recomputes price, notifies manager, promo only once", async () => {
  const { app, url, sent } = await startApp();
  await req(url + "/api/admin/settings", "PUT", { managerChatIds: ["555000"] }, asUser(100));
  const body = goodOrder();
  body.cart.lines[0].price = 1; // client-side tampering must be ignored
  const r = await req(url + "/api/orders", "POST", body, asUser(7));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const o = app.store.getOrders().list[0];
  const subtotal = 3200 + 2250 * 2 + 50;
  assert.equal(o.totals.subtotal, subtotal);
  assert.equal(o.totals.total, subtotal - Math.round(subtotal * 0.05));
  await new Promise((res) => setTimeout(res, 20));
  const toManager = sent.find((s) => s.chat === "555000");
  assert.ok(toManager, "manager notified");
  assert.match(toManager.text, /Новая заявка №1001/);
  assert.match(toManager.text, /&lt;b&gt;без орехов/); // user input is escaped
  assert.ok(sent.find((s) => s.chat === "7"), "customer gets confirmation");
  const again = await req(url + "/api/orders", "POST", goodOrder(), asUser(7));
  assert.equal(again.status, 400);
  assert.match(again.data.error, /первый заказ/);
  const promoCheck = await req(url + "/api/promo", "POST", { code: "клубника" }, asUser(7));
  assert.equal(promoCheck.data.ok, false);
  app.server.close();
});

test("orders require Telegram signature and valid fields", async () => {
  const { app, url } = await startApp();
  assert.equal((await req(url + "/api/orders", "POST", goodOrder())).status, 401);
  const bad = goodOrder(); bad.customer.phone = "12";
  const r = await req(url + "/api/orders", "POST", bad, asUser(8));
  assert.equal(r.status, 400); assert.match(r.data.error, /телефон/i);
  app.server.close();
});

test("admin API is closed to non-admins and works for admins", async () => {
  const { app, url } = await startApp();
  assert.equal((await req(url + "/api/admin/orders", "GET", null, asUser(5))).status, 403);
  assert.equal((await req(url + "/api/admin/orders", "GET")).status, 403);
  assert.equal((await req(url + "/api/me", "GET", null, asUser(100))).data.isAdmin, true);
  const put = await req(url + `/api/admin/item/products/${P1.id}`, "PUT", { price: 3500, hidden: true, images: ["javascript:alert(1)", "https://x.ru/a.jpg"] }, asUser(100));
  assert.equal(put.status, 200);
  assert.equal(put.data.price, 3500);
  assert.deepEqual(put.data.images, ["https://x.ru/a.jpg"]);
  const pub = await req(url + "/api/catalog", "GET");
  assert.ok(!pub.data.products.some((p) => p.id === P1.id), "hidden product not public");
  const created = await req(url + "/api/admin/item/products", "POST", { title: "Тест", price: 100, cats: ["top"] }, asUser(100));
  assert.equal(created.status, 200);
  assert.equal((await req(url + `/api/admin/item/products/${created.data.id}`, "DELETE", null, asUser(100))).status, 200);
  const cats = app.store.getCatalog().categories.slice().sort((a, b) => a.sort - b.sort);
  await req(url + `/api/admin/move/categories/${cats[1].id}`, "POST", { dir: -1 }, asUser(100));
  const after = app.store.getCatalog().categories.slice().sort((a, b) => a.sort - b.sort);
  assert.equal(after[0].id, cats[1].id);
  await req(url + "/api/admin/promos", "PUT", { promos: [{ code: "ЛЕТО", percent: 10, active: true }] }, asUser(100));
  assert.equal((await req(url + "/api/promo", "POST", { code: "лето" }, asUser(9))).data.percent, 10);
  app.server.close();
});

test("stats count unique visitors, views and orders", async () => {
  const { app, url } = await startApp();
  for (const id of [1, 1, 2]) await req(url + "/api/track", "POST", { type: "visit" }, asUser(id));
  await req(url + "/api/track", "POST", { type: "view", productId: P1.id }, asUser(1));
  await req(url + "/api/track", "POST", { type: "view", productId: "fake" }, asUser(1));
  await req(url + "/api/orders", "POST", goodOrder(), asUser(1));
  const s = (await req(url + "/api/admin/stats", "GET", null, asUser(100))).data;
  assert.equal(s.today.visitors, 2);
  assert.equal(s.week.orders, 1);
  assert.equal(s.topProducts[0].id, P1.id);
  assert.equal(s.topProducts.length, 1);
  app.server.close();
});

test("static files served, path traversal blocked", async () => {
  const { app, url } = await startApp();
  const r = await fetch(url + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Sweet Roses/);
  assert.equal((await fetch(url + "/..%2fserver%2findex.js")).status, 404);
  app.server.close();
});

test("first /start becomes owner-admin only when no admins exist", async () => {
  const { app, url } = await startApp({ adminIds: "" });
  assert.equal((await req(url + "/api/me", "GET", null, asUser(55))).data.isAdmin, false);
  assert.match(app.claimOwner({ id: 55 }), /администратором/);
  assert.equal(app.claimOwner({ id: 66 }), "", "second person does not become admin");
  assert.equal((await req(url + "/api/me", "GET", null, asUser(55))).data.isAdmin, true);
  assert.equal((await req(url + "/api/me", "GET", null, asUser(66))).data.isAdmin, false);
  assert.equal((await req(url + "/api/catalog", "GET")).data.settings.ownerIds, undefined);
  app.server.close();
});

test("public address is learned once, only from the hosting domain", async () => {
  const urls = [];
  const bot = { sendMessage: async () => {}, setWebAppUrl: (u) => urls.push(u) };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-"));
  const app = createApp({ botToken: TOKEN, adminIds: "100", dataDir, bot, log: { error() {} } });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  const hit = (host) => new Promise((resolve) => require("http").get({ port, path: "/api/catalog", headers: { host } }, (res) => { res.resume(); res.on("end", resolve); }));
  await hit("evil.example.com");
  assert.equal(app.store.getCatalog().settings.webAppUrl, undefined);
  await hit("sweetroses-ilya.amvera.io");
  await hit("evil.amvera.io.example.com");
  await hit("other.amvera.io");
  assert.equal(app.store.getCatalog().settings.webAppUrl, "https://sweetroses-ilya.amvera.io");
  assert.ok(urls.every((u) => u === "https://sweetroses-ilya.amvera.io"));
  app.server.close();
});
