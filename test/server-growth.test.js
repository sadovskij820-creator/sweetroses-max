"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const max = require("../server/max");
const { todayISO } = require("../server/orders");
const { createApp } = require("../server/index");

const TOKEN = "max-growth-token";
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "catalog.seed.json"), "utf8"));
const P1 = seed.products.find((p) => p.title === "Бокс клубника в шоколаде S");

function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "srg-"));
  const sent = [];
  const bot = { sendMessage: async (chat, text, ex) => { sent.push({ chat: String(chat), text, extra: ex }); }, openButton: () => [[{ type: "open_app", text: "x", web_app: "bot" }]], getUsername: () => "cr_demo_bot", setWebAppUrl() {} };
  const app = createApp({ messenger: "max", botToken: TOKEN, adminIds: "100", dataDir, bot, log: { error() {}, log() {} }, ...extra });
  app.store.getCatalog().settings.payments = { enabled: false, provider: "demo" };
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, sent, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const asUser = (id, sp, name) => max.signInitData({ id, first_name: name || "U" + id, username: "user" + id }, TOKEN, Math.floor(Date.now() / 1000), sp ? { start_param: sp } : {});
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null), text: r.headers.get("content-type") };
}
const order = (extra = {}) => Object.assign({
  cart: { lines: [{ id: P1.id, qty: 1, choc: ["Руби"] }], addons: {} },
  customer: { name: "Анна", phone: "+7 900 111-22-33", date: todayISO(new Date(Date.now() + 864e5)), time: "14:00", method: "delivery", address: "ул. Ленина, 1" },
}, extra);

test("welcome bonus is shown once; profile gives link base and ref code", async () => {
  const { app, url } = await startApp();
  const p = (await req(url + "/api/profile", "GET", null, asUser(1))).data;
  assert.equal(p.balance, 200);
  assert.deepEqual(p.welcome, { amount: 200, kind: "welcome" });
  assert.equal(p.linkBase, "https://max.ru/cr_demo_bot?start=");
  assert.match(p.refCode, /^[0-9a-f]{8}$/);
  const p2 = (await req(url + "/api/profile", "PUT", { welcomeSeen: true }, asUser(1))).data;
  assert.equal(p2.welcome, null);
  app.server.close();
});

test("hint link opens the product with the sender's name and credits the sender as referrer", async () => {
  const { app, url } = await startApp();
  const anna = (await req(url + "/api/profile", "GET", null, asUser(1, "", "Анна"))).data;
  const me = (await req(url + "/api/me", "GET", null, asUser(2, `h_${P1.id}-r_${anna.refCode}`, "Олег"))).data;
  assert.deepEqual(me.start, { productId: P1.id, hint: true, fromName: "Анна" });
  assert.equal(app.customers.get(2).referredBy, "1");
  assert.equal(app.customers.get(2).source, "hint");
  const me2 = (await req(url + "/api/me", "GET", null, asUser(3, "p_nope"))).data;
  assert.deepEqual(me2.start, {}, "unknown product ignored");
  app.server.close();
});

test("digital gift card: link after order, public card, recipient gets gift bonus", async () => {
  const { app, url } = await startApp();
  const r = await req(url + "/api/orders", "POST", order({ gift: { to: "Маша", text: "С днём рождения! <3" } }), asUser(1, "", "Анна"));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.giftLink, /^https:\/\/max\.ru\/cr_demo_bot\?start=g_[0-9a-f]{10}$/);
  const gid = r.data.giftLink.split("g_")[1];
  const card = (await req(url + "/api/gift/" + gid, "GET")).data;
  assert.deepEqual(card, { from: "Анна", to: "Маша", text: "С днём рождения! <3", bonus: 200 });
  assert.equal((await req(url + "/api/gift/0000000000", "GET")).status, 404);
  const me = (await req(url + "/api/me", "GET", null, asUser(5, "g_" + gid))).data;
  assert.equal(me.start.gift, gid);
  const p = (await req(url + "/api/profile", "GET", null, asUser(5))).data;
  assert.equal(p.balance, 200);
  assert.equal(p.welcome.kind, "gift");
  const mine = (await req(url + "/api/profile", "GET", null, asUser(1))).data;
  assert.equal(mine.orders[0].giftLink, r.data.giftLink);
  app.server.close();
});

test("sources: admin creates links, sees customers/orders per source, gets a QR code", async () => {
  const { app, url } = await startApp();
  const put = await req(url + "/api/admin/sources", "PUT", { sources: [{ title: "Наклейка на коробке", slug: "box" }, { title: "Авито", slug: "avito" }, { title: "плохой", slug: "Плохо!" }] }, asUser(100));
  assert.equal(put.status, 200);
  assert.equal(put.data.sources.length, 2);
  await req(url + "/api/me", "GET", null, asUser(7, "s_box"));
  await req(url + "/api/orders", "POST", order(), asUser(7));
  await req(url + "/api/me", "GET", null, asUser(8, "s_box"));
  const list = (await req(url + "/api/admin/sources", "GET", null, asUser(100))).data;
  const box = list.sources.find((x) => x.slug === "box");
  assert.equal(box.customers, 2);
  assert.equal(box.orders, 1);
  assert.equal(box.link, "https://max.ru/cr_demo_bot?start=s_box");
  const qr = await fetch(url + "/api/admin/qr?slug=box", { headers: { "X-Init-Data": asUser(100) } });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /svg/);
  assert.match(await qr.text(), /^<svg/);
  assert.equal((await fetch(url + "/api/admin/qr?slug=box", { headers: { "X-Init-Data": asUser(7) } })).status, 403);
  app.server.close();
});

test("bot start via ?start= link: customer saved with referrer, hint greeting, app payload; save-chat flag", async () => {
  const { app, url } = await startApp();
  const ref = (await req(url + "/api/profile", "GET", null, asUser(500))).data;
  assert.equal(ref.botStarted, false, "opened by link, chat not saved yet");
  assert.match(ref.chatLink, /\?start=save$/);
  const pid = app.store.getCatalog().products[0].id;
  const res = app.onBotStart({ id: 501, first_name: "Друг" }, `h_${pid}-r_${ref.refCode}`);
  assert.match(res.greeting, /намекают/);
  assert.equal(res.button, "Посмотреть подарок");
  assert.equal(res.appPayload, `h_${pid}-r_${ref.refCode}`);
  assert.equal(app.customers.get(501).referredBy, "500");
  assert.equal(app.customers.get(501).botStarted, true);
  assert.equal((await req(url + "/api/profile", "GET", null, asUser(501))).data.botStarted, true);
  // app opened with that payload lands on the product with the hint
  const me = (await req(url + "/api/me", "GET", null, asUser(501, `h_${pid}-r_${ref.refCode}`))).data;
  assert.equal(String(me.start.productId), String(pid));
  assert.equal(me.start.hint, true);
  // «В чат» from the banner
  const s = app.onBotStart({ id: 500 }, "save");
  assert.match(s.greeting, /сохранён/);
  assert.equal(s.appPayload, "");
  assert.equal((await req(url + "/api/profile", "GET", null, asUser(500))).data.botStarted, true);
  app.server.close();
});
