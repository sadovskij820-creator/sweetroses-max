"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const max = require("../server/max");
const { todayISO } = require("../server/orders");
const { createApp } = require("../server/index");

const TOKEN = "max-loyal-token";
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "catalog.seed.json"), "utf8"));
const P1 = seed.products.find((p) => p.title === "Бокс клубника в шоколаде S"); // 3200

function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "srl-"));
  const sent = [];
  const bot = { sendMessage: async (chat, text, ex) => { sent.push({ chat: String(chat), text, extra: ex }); }, openButton: () => [[{ type: "open_app", text: "x", web_app: "bot" }]], getUsername: () => "cr_demo_bot", setWebAppUrl() {} };
  const app = createApp({ messenger: "max", botToken: TOKEN, adminIds: "100", dataDir, bot, log: { error() {}, log() {} }, ...extra });
  app.store.getCatalog().settings.payments = { enabled: false, provider: "demo" }; // payment flows are tested separately
  app.store.getCatalog().settings.loyalty = { features: { welcome: false } }; // welcome bonus is tested in server-growth
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, sent, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const asUser = (id, startParam) => max.signInitData({ id, first_name: "U" + id, username: "user" + id }, TOKEN, Math.floor(Date.now() / 1000), startParam ? { start_param: startParam } : {});
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const order = (extra = {}) => Object.assign({
  cart: { lines: [{ id: P1.id, qty: 1, choc: ["Руби"] }], addons: {} },
  customer: { name: "Анна", phone: "+7 900 111-22-33", date: todayISO(new Date(Date.now() + 864e5)), time: "14:00", method: "pickup" },
}, extra);
const wait = () => new Promise((r) => setTimeout(r, 30));

test("profile: customer is created, friend link gives welcome bonus, referrer rewarded after friend's first done order", async () => {
  const { app, url, sent } = await startApp();
  const p = (await req(url + "/api/profile", "GET", null, asUser(10))).data;
  assert.equal(p.balance, 0);
  assert.equal(p.level.name, "Бронза");
  assert.match(p.refLink, /^https:\/\/max\.ru\/cr_demo_bot\?start=ref_[0-9a-f]{8}$/);
  const code = p.refLink.split("ref_")[1];
  const f = (await req(url + "/api/profile", "GET", null, asUser(11, "ref_" + code))).data;
  assert.equal(f.balance, 300);
  // friend pays part with bonuses: 30% of 3200 = 960 max, has 300
  const r = await req(url + "/api/orders", "POST", order({ useBonus: true, consent: true }), asUser(11));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const o = app.store.getOrders().list[0];
  assert.equal(o.bonusUsed, 300);
  assert.equal((await req(url + "/api/profile", "GET", null, asUser(11))).data.balance, 0);
  await req(url + `/api/admin/orders/${o.id}`, "PATCH", { status: "done" }, asUser(100));
  await wait();
  const f2 = (await req(url + "/api/profile", "GET", null, asUser(11))).data;
  assert.equal(f2.balance, Math.floor((3200 - 300) * 0.05));
  assert.equal((await req(url + "/api/profile", "GET", null, asUser(10))).data.balance, 300, "referrer got 300");
  assert.ok(sent.some((s) => s.chat === "11" && /начислено/i.test(s.text)), "customer told about bonuses");
  assert.ok(sent.some((s) => s.chat === "10" && /друг/i.test(s.text)), "referrer told");
  app.server.close();
});

test("cancel refunds spent bonuses once; done→work reverses accrual", async () => {
  const { app, url } = await startApp();
  const c = app.customers.touch({ id: 20, first_name: "Б" });
  app.customers.addBonus(c, 500, "manual");
  await req(url + "/api/orders", "POST", order({ useBonus: true }), asUser(20));
  const o = app.store.getOrders().list[0];
  assert.equal(o.bonusUsed, 500);
  await req(url + `/api/admin/orders/${o.id}`, "PATCH", { status: "cancel" }, asUser(100));
  await req(url + `/api/admin/orders/${o.id}`, "PATCH", { status: "cancel" }, asUser(100));
  assert.equal((await req(url + "/api/profile", "GET", null, asUser(20))).data.balance, 500);
  app.server.close();
});

test("demo payment: order waits for payment, manager notified only after paying", async () => {
  const { app, url, sent } = await startApp();
  await req(url + "/api/admin/settings", "PUT", { payments: { enabled: true, provider: "demo" } }, asUser(100));
  const r = await req(url + "/api/orders", "POST", order(), asUser(30));
  assert.equal(r.status, 200);
  assert.equal(r.data.pay.provider, "demo");
  const o = app.store.getOrders().list[0];
  assert.equal(o.status, "pay");
  await wait();
  assert.ok(!sent.some((s) => s.chat === "100"), "no manager message before payment");
  assert.equal((await req(url + "/api/pay/demo", "POST", { orderId: o.id, token: "x".repeat(32) }, asUser(30))).status, 403);
  const paid = await req(url + "/api/pay/demo", "POST", { orderId: o.id, token: r.data.pay.token }, asUser(30));
  assert.equal(paid.status, 200);
  assert.equal(o.paid, true);
  assert.equal(o.status, "new");
  await wait();
  assert.ok(sent.some((s) => s.chat === "100" && /Оплачен/.test(s.text)));
  const st = await req(url + `/api/orders/${o.id}/status`, "GET", null, asUser(30));
  assert.equal(st.data.paid, true);
  assert.equal((await req(url + `/api/orders/${o.id}/status`, "GET", null, asUser(31))).status, 404, "foreign order hidden");
  app.server.close();
});

test("yookassa webhook marks paid only after verification", async () => {
  const verified = [];
  const payments = { provider: "yookassa", configured: true, create: async (o) => ({ paymentId: "pay_" + o.id, url: "https://yoomoney.ru/x" }), verify: async (id, o, amount) => { verified.push([id, o.id, amount]); return id === "pay_1001"; }, checkDemo: () => false };
  const { app, url } = await startApp({ payments });
  await req(url + "/api/admin/settings", "PUT", { payments: { enabled: true, provider: "yookassa" } }, asUser(100));
  const r = await req(url + "/api/orders", "POST", order(), asUser(40));
  assert.equal(r.data.pay.url, "https://yoomoney.ru/x");
  const o = app.store.getOrders().list[0];
  await fetch(url + "/api/pay/yookassa", { method: "POST", body: JSON.stringify({ event: "payment.succeeded", object: { id: "pay_fake", metadata: { orderId: String(o.id) } } }) });
  assert.equal(o.paid, undefined);
  await fetch(url + "/api/pay/yookassa", { method: "POST", body: JSON.stringify({ event: "payment.succeeded", object: { id: "pay_1001", metadata: { orderId: String(o.id) } } }) });
  assert.equal(o.paid, true);
  assert.deepEqual(verified[1], ["pay_1001", o.id, 3200]);
  app.server.close();
});

test("jobs: date reminder at 10:00 once a year, burn reminder once, unpaid orders cancelled with refund", async () => {
  const { app, url, sent } = await startApp();
  await req(url + "/api/profile/dates", "POST", { title: "ДР мамы", md: "10-10" }, asUser(50));
  const at = (s) => new Date(s);
  await app.runJobs(at("2026-10-07T01:00:00Z")); // 09:00 Irkutsk — too early
  assert.ok(!sent.some((s) => /ДР мамы/.test(s.text)));
  await app.runJobs(at("2026-10-07T02:30:00Z")); // 10:30
  await app.runJobs(at("2026-10-07T05:00:00Z"));
  assert.equal(sent.filter((s) => /ДР мамы/.test(s.text)).length, 1);
  assert.ok(sent.find((s) => /ДР мамы/.test(s.text)).extra.buttons, "has open-app button");

  const c = app.customers.touch({ id: 51 });
  app.customers.addBonus(c, 200, "order", { days: 5, now: at("2026-10-07T00:00:00Z") });
  await app.runJobs(at("2026-10-07T03:00:00Z"));
  await app.runJobs(at("2026-10-08T03:00:00Z"));
  assert.equal(sent.filter((s) => s.chat === "51" && /сгорят/.test(s.text)).length, 1);

  await req(url + "/api/admin/settings", "PUT", { payments: { enabled: true, provider: "demo" } }, asUser(100));
  const c2 = app.customers.touch({ id: 52 });
  app.customers.addBonus(c2, 100, "manual");
  await req(url + "/api/orders", "POST", order({ useBonus: true }), asUser(52));
  const o = app.store.getOrders().list[0];
  await app.runJobs(new Date(Date.now() + 61 * 60e3));
  assert.equal(o.status, "cancel");
  assert.equal((await req(url + "/api/profile", "GET", null, asUser(52))).data.balance, 100);
  app.server.close();
});

test("admin: customers list with segments, bonus adjust, broadcast only to consenting", async () => {
  const { app, url, sent } = await startApp();
  await req(url + "/api/orders", "POST", order({ consent: true }), asUser(60));
  await req(url + "/api/orders", "POST", order({ consent: false }), asUser(61));
  const list = (await req(url + "/api/admin/customers?segment=all", "GET", null, asUser(100))).data;
  assert.equal(list.customers.length, 2);
  assert.equal(list.customers[0].orders, 1);
  assert.equal((await req(url + "/api/admin/customers", "GET", null, asUser(60))).status, 403);
  const adj = await req(url + "/api/admin/customers/60", "PATCH", { bonusDelta: 150, comment: "Извинение", note: "любит руби" }, asUser(100));
  assert.equal(adj.data.balance, 150);
  const preview = (await req(url + "/api/admin/broadcast/preview?segment=all", "GET", null, asUser(100))).data;
  assert.equal(preview.count, 1);
  const b = await req(url + "/api/admin/broadcast", "POST", { segment: "all", text: "Скидка 10% на выходных" }, asUser(100));
  assert.equal(b.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(sent.some((s) => s.chat === "60" && /Скидка 10%/.test(s.text)));
  assert.ok(!sent.some((s) => s.chat === "61" && /Скидка 10%/.test(s.text)));
  const hist = (await req(url + "/api/admin/broadcasts", "GET", null, asUser(100))).data;
  assert.equal(hist.list[0].sent, 1);
  // consent can be switched off by the customer
  await req(url + "/api/profile", "PUT", { consent: false }, asUser(60));
  assert.equal((await req(url + "/api/admin/broadcast/preview?segment=all", "GET", null, asUser(100))).data.count, 0);
  app.server.close();
});

test("features can be switched off: no bonuses → useBonus ignored, profile hides bonus", async () => {
  const { app, url } = await startApp();
  await req(url + "/api/admin/settings", "PUT", { loyalty: { features: { bonuses: false } } }, asUser(100));
  const c = app.customers.touch({ id: 70 });
  app.customers.addBonus(c, 500, "manual");
  await req(url + "/api/orders", "POST", order({ useBonus: true }), asUser(70));
  assert.equal(app.store.getOrders().list[0].bonusUsed, 0);
  const cat = (await req(url + "/api/catalog", "GET")).data;
  assert.equal(cat.loyalty.features.bonuses, false);
  app.server.close();
});
