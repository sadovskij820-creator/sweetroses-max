"use strict";
// One shop in Telegram AND MAX at the same time (17.10.2026): one catalog, one base, orders in one place,
// every message goes through the bot of the person's own messenger.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tg = require("../server/telegram");
const max = require("../server/max");
const { todayISO } = require("../server/orders");
const { createApp } = require("../server/index");

const TG_TOKEN = "123:tg-token", MAX_TOKEN = "max-token-two";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
const P1 = seed.products[0];
const tgUser = (id, sp) => tg.signInitData({ id, first_name: "Тг" + id, username: "tg" + id }, TG_TOKEN, undefined, sp ? { start_param: sp } : {});
const maxUser = (id, sp) => max.signInitData({ id, first_name: "Макс" + id, username: "mx" + id }, MAX_TOKEN, undefined, sp ? { start_param: sp } : {});
function mockBot(name) {
  const sent = [], docs = [];
  return { sent, docs, sendMessage: async (chat, text, extra) => { sent.push({ chat: String(chat), text, extra }); }, sendPhotos: async () => {}, sendDocument: async (chat, buf, n) => { docs.push({ chat: String(chat), n }); }, openButton: (t) => (name === "max" ? [[{ type: "open_app", text: t }]] : { inline_keyboard: [[{ text: t }]] }), getUsername: () => "gagulya_" + name + "_bot", setWebAppUrl() {} };
}
async function start(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "two-"));
  const T = mockBot("tg"), X = mockBot("max");
  const app = createApp(Object.assign({ messengers: ["telegram", "max"], botTokens: { telegram: TG_TOKEN, max: MAX_TOKEN }, bots: { telegram: T, max: X }, adminIds: "", dataDir, seedFile: SEED, log: { error() {}, log() {} }, noBackup: true }, extra));
  await new Promise((r) => app.server.listen(0, r));
  return { app, T, X, url: `http://127.0.0.1:${app.server.address().port}` };
}
async function req(url, method, body, init, platform) {
  const r = await fetch(url, { method, headers: Object.assign({ "Content-Type": "application/json", "X-Init-Data": init || "" }, platform ? { "X-Platform": platform } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const tomorrow = () => todayISO(new Date(Date.now() + 864e5));
const order = (name) => ({ cart: { lines: [{ id: P1.id, qty: 1 }], addons: {} }, customer: { name, phone: "+7 900 111-22-33", date: tomorrow(), time: "14:00", method: "pickup" } });
const wait = () => new Promise((r) => setTimeout(r, 40));

test("both messengers open the same shop; each user is recognised by his own bot's signature", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  const a = await req(url + "/api/me", "GET", null, tgUser(501), "telegram");
  const b = await req(url + "/api/me", "GET", null, maxUser(777), "max");
  assert.equal(a.data.platform, "telegram");
  assert.equal(b.data.platform, "max");
  // a wrong platform hint does not matter — the signature decides
  assert.equal((await req(url + "/api/me", "GET", null, maxUser(778), "telegram")).data.platform, "max");
  assert.equal(app.customers.get(777).platform, "max");
  assert.equal(app.customers.get(501).platform, undefined, "the main messenger is not marked (old data stays as it is)");
  // a fake signature is nobody
  assert.equal((await req(url + "/api/profile", "GET", null, max.signInitData({ id: 9 }, "wrong"), "max")).status, 401);
  const c = await req(url + "/api/catalog", "GET");
  assert.deepEqual(c.data.platforms, ["telegram", "max"]);
});

test("orders from MAX and Telegram land in one place; managers and customers get messages through their own bots", async (t) => {
  const { app, T, X, url } = await start(); t.after(() => app.server.close());
  // the owner (Ilya) started the Telegram bot first; Gagulya joins as owner by an invite opened in MAX
  app.onBotStart({ id: 100, first_name: "Илья" }, "", "telegram");
  const inv = await req(url + "/api/admin/staff/invite", "POST", { role: "owner" }, tgUser(100), "telegram");
  assert.equal(inv.status, 200);
  assert.match(inv.data.links.telegram, /^https:\/\/t\.me\/gagulya_tg_bot\?start=staff_/);
  assert.match(inv.data.links.max, /^https:\/\/max\.ru\/gagulya_max_bot\?start=staff_/);
  const code = inv.data.links.max.split("staff_")[1];
  const res = app.onBotStart({ id: 300, first_name: "Гагуля" }, "staff_" + code, "max");
  assert.match(res.text, /владелец/);
  assert.equal(app.store.getCatalog().settings.staff[0].platform, "max");
  await wait();
  assert.ok(T.sent.some((m) => m.chat === "100" && /принял\(а\) приглашение \(MAX\)/.test(m.text)), "Ilya is told in Telegram");
  // Gagulya is an admin in MAX — but a Telegram person with the same number is not
  assert.equal((await req(url + "/api/admin/orders", "GET", null, maxUser(300), "max")).status, 200);
  assert.equal((await req(url + "/api/admin/orders", "GET", null, tgUser(300), "telegram")).status, 403);
  assert.equal((await req(url + "/api/admin/orders", "GET", null, maxUser(100), "max")).status, 403);

  const o1 = await req(url + "/api/orders", "POST", order("Анна"), maxUser(777), "max");
  const o2 = await req(url + "/api/orders", "POST", order("Олег"), tgUser(501), "telegram");
  assert.equal(o1.status, 200); assert.equal(o2.status, 200);
  await wait();
  const list = (await req(url + "/api/admin/orders", "GET", null, maxUser(300), "max")).data.orders;
  assert.equal(list.length, 2, "one list of orders for both messengers");
  assert.equal(app.store.getOrders().list.find((o) => o.id === o1.data.id).platform, "max");
  // both new orders reached Ilya (Telegram) and Gagulya (MAX), each through his own bot
  for (const id of [o1.data.id, o2.data.id]) {
    assert.ok(T.sent.some((m) => m.chat === "100" && m.text.includes(`№${id}`)));
    assert.ok(X.sent.some((m) => m.chat === "300" && m.text.includes(`№${id}`)));
  }
  assert.ok(X.sent.some((m) => m.text.includes(`№${o1.data.id}`) && /MAX: /.test(m.text)), "the manager sees that the customer is in MAX");
  // «Подтвердить» → the MAX customer gets the message in MAX, the Telegram one in Telegram
  T.sent.length = 0; X.sent.length = 0;
  await req(url + `/api/admin/orders/${o1.data.id}`, "PATCH", { status: "work" }, tgUser(100), "telegram");
  await req(url + `/api/admin/orders/${o2.data.id}`, "PATCH", { status: "work" }, tgUser(100), "telegram");
  await wait();
  assert.ok(X.sent.some((m) => m.chat === "777" && /подтверждён/.test(m.text)));
  assert.ok(T.sent.some((m) => m.chat === "501" && /подтверждён/.test(m.text)));
  assert.ok(!T.sent.some((m) => m.chat === "777"));
  // customers from both messengers in one base
  const cust = await req(url + "/api/admin/customers", "GET", null, tgUser(100), "telegram");
  const ids = cust.data.customers.map((c) => c.id);
  assert.ok(ids.includes("501") && ids.includes("777"));
});

test("links, QR and the review card exist for both messengers; profile links follow the person's messenger", async (t) => {
  const { app, url } = await start(); t.after(() => app.server.close());
  app.onBotStart({ id: 100, first_name: "Илья" }, "", "telegram");
  const p = await req(url + "/api/profile", "GET", null, maxUser(777), "max");
  assert.match(p.data.refLink, /^https:\/\/max\.ru\/gagulya_max_bot\?start=ref_/);
  assert.equal(p.data.botStarted, false, "MAX: «save the shop in chats» is offered");
  const q = await req(url + "/api/profile", "GET", null, tgUser(501), "telegram");
  assert.match(q.data.refLink, /^https:\/\/t\.me\/gagulya_tg_bot\?startapp=ref_/);
  const rv = await req(url + "/api/admin/reviews", "GET", null, tgUser(100), "telegram");
  assert.equal(rv.data.links.telegram, "https://t.me/gagulya_tg_bot?start=rv_1-s_otzyv");
  assert.equal(rv.data.links.max, "https://max.ru/gagulya_max_bot?start=rv_1-s_otzyv");
  await req(url + "/api/admin/sources", "PUT", { sources: [{ title: "Стойка", slug: "stoika" }] }, tgUser(100), "telegram");
  const src = await req(url + "/api/admin/sources", "GET", null, tgUser(100), "telegram");
  assert.equal(src.data.sources[0].links.max, "https://max.ru/gagulya_max_bot?start=s_stoika");
  const qr = await fetch(url + "/api/admin/qr?slug=stoika&pf=max", { headers: { "X-Init-Data": tgUser(100) } });
  assert.equal(qr.status, 200);
  // the bot of each messenger opens the review form
  const r = app.onBotStart({ id: 800, first_name: "Оля" }, "rv_1-s_otzyv", "max");
  assert.equal(r.button, "⭐ Оставить отзыв");
  assert.equal(app.customers.get(800).platform, "max");
  assert.equal(app.customers.get(800).source, "otzyv");
});

test("night copy goes to the owner through his messenger; BACKUP_CHAT_IDS understands max:<id>", async (t) => {
  const { app, T, X } = await start(); t.after(() => app.server.close());
  app.onBotStart({ id: 100, first_name: "Илья" }, "", "telegram");
  await app.runBackup({ full: true });
  assert.equal(T.docs.length, 1); assert.equal(X.docs.length, 0);
  process.env.BACKUP_CHAT_IDS = "max:300";
  try { await app.runBackup({ full: true }); } finally { delete process.env.BACKUP_CHAT_IDS; }
  assert.equal(X.docs.length, 1); assert.equal(X.docs[0].chat, "300");
});

test("only MAX (a shop without Telegram): works as before; the env value «telegram,max» is read", async (t) => {
  const prev = process.env.MESSENGER;
  process.env.MESSENGER = "telegram, max";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "two-env-"));
  try {
    const app = createApp({ botTokens: { telegram: "", max: "" }, bots: { telegram: null, max: null }, adminIds: "", dataDir, seedFile: SEED, log: { error() {}, log() {} }, noBackup: true });
    assert.deepEqual(app.config.platforms, ["telegram", "max"]);
  } finally { if (prev === undefined) delete process.env.MESSENGER; else process.env.MESSENGER = prev; }
  assert.throws(() => createApp({ messengers: ["vk"], dataDir, seedFile: SEED }), /MESSENGER/);
});
