"use strict";
// «Как вам букет?» — the day after the order is «Выполнен» the customer gets a message with the review button.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tg = require("../server/telegram");
const { todayISO } = require("../server/orders");
const { createApp } = require("../server/index");

const TOKEN = "123:ask";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const P1 = JSON.parse(fs.readFileSync(SEED, "utf8")).products[0];
const user = (id) => tg.signInitData({ id, first_name: "Анна", username: "u" + id }, TOKEN);
async function start() {
  const sent = [];
  const bot = { sendMessage: async (chat, text, extra) => { sent.push({ chat: String(chat), text, extra }); }, sendPhotos: async () => {}, openButton: (t, p) => ({ t, p }), getUsername: () => "gagulya_flowers_bot", setWebAppUrl() {} };
  const app = createApp({ messenger: "telegram", botToken: TOKEN, bot, adminIds: "100", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ask-")), seedFile: SEED, log: { error() {}, log() {} }, noBackup: true });
  await new Promise((r) => app.server.listen(0, r));
  return { app, sent, url: `http://127.0.0.1:${app.server.address().port}` };
}
const req = async (url, method, body, init) => { const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };
const order = (method) => ({ cart: { lines: [{ id: P1.id, qty: 1 }], addons: {} }, customer: { name: "Анна", phone: "+7 900 111-22-33", date: todayISO(new Date(Date.now() + 864e5)), time: "14:00", method, address: method === "delivery" ? "Ленина 1" : "", zoneId: method === "delivery" ? "zokt" : "" } });
// a moment in Irkutsk time (UTC+8)
const irk = (iso) => new Date(iso + "+08:00");

test("the day after «Выполнен» — one message with the review button; not at night, not twice", async (t) => {
  const { app, sent, url } = await start(); t.after(() => app.server.close());
  const o = await req(url + "/api/orders", "POST", order("delivery"), user(501));
  await req(url + `/api/admin/orders/${o.data.id}`, "PATCH", { status: "done" }, user(100));
  const ord = app.store.getOrders().list.find((x) => String(x.id) === String(o.data.id));
  ord.doneAt = irk("2030-05-10T15:00:00").toISOString(); // delivered 10.05 at 15:00
  const asks = () => sent.filter((m) => m.chat === "501" && /Оценить|как вам цветы/.test(m.text));
  await app.runJobs(irk("2030-05-10T19:00:00")); assert.equal(asks().length, 0, "not the same day");
  await app.runJobs(irk("2030-05-11T08:00:00")); assert.equal(asks().length, 0, "not in the morning before 11");
  await app.runJobs(irk("2030-05-11T11:05:00")); assert.equal(asks().length, 1, "next day at 11");
  const m = asks()[0];
  assert.match(m.text, /^Анна, здравствуйте!/);
  assert.match(m.text, /уже доставлен/);
  assert.match(m.text, /200 бонусов/);
  assert.deepEqual(m.extra.reply_markup, { t: "⭐ Оценить букет", p: "rv_1" });
  await app.runJobs(irk("2030-05-11T15:00:00")); assert.equal(asks().length, 1, "only once");
});

test("no message if the review is already there, for pickup the text differs, the feature can be off", async (t) => {
  const { app, sent, url } = await start(); t.after(() => app.server.close());
  const a = await req(url + "/api/orders", "POST", order("pickup"), user(601));
  const b = await req(url + "/api/orders", "POST", order("pickup"), user(602));
  for (const x of [a, b]) await req(url + `/api/admin/orders/${x.data.id}`, "PATCH", { status: "done" }, user(100));
  assert.equal((await req(url + "/api/reviews", "POST", { rating: 5, text: "Очень красиво" }, user(602))).status, 200);
  for (const o of app.store.getOrders().list) o.doneAt = irk("2030-06-01T12:00:00").toISOString();
  await app.runJobs(irk("2030-06-02T12:00:00"));
  assert.equal(sent.filter((m) => m.chat === "602" && /Оценить/.test(JSON.stringify(m.extra))).length, 0, "already reviewed");
  const m = sent.find((m) => m.chat === "601" && /Надеемся, букет/.test(m.text));
  assert.ok(m); assert.doesNotMatch(m.text, /доставлен/);
  // the switch in «Бонусы»
  const c = await req(url + "/api/orders", "POST", order("pickup"), user(603));
  await req(url + `/api/admin/orders/${c.data.id}`, "PATCH", { status: "done" }, user(100));
  app.store.getOrders().list.find((x) => String(x.id) === String(c.data.id)).doneAt = irk("2030-06-01T12:00:00").toISOString();
  const L = app.store.getCatalog().settings.loyalty || (app.store.getCatalog().settings.loyalty = {});
  L.features = Object.assign({}, L.features, { reviewAsk: false });
  await app.runJobs(irk("2030-06-02T13:00:00"));
  assert.equal(sent.filter((m) => m.chat === "603").filter((m) => /Надеемся/.test(m.text)).length, 0);
});

test("orders closed long ago (before the update) get nothing", async (t) => {
  const { app, sent, url } = await start(); t.after(() => app.server.close());
  const o = await req(url + "/api/orders", "POST", order("delivery"), user(701));
  await req(url + `/api/admin/orders/${o.data.id}`, "PATCH", { status: "done" }, user(100));
  const ord = app.store.getOrders().list.find((x) => String(x.id) === String(o.data.id));
  delete ord.doneAt;
  await app.runJobs(new Date(Date.now() + 864e5));
  ord.doneAt = irk("2030-01-01T12:00:00").toISOString();
  await app.runJobs(irk("2030-01-20T12:00:00"));
  assert.equal(sent.filter((m) => m.chat === "701" && /доставлен —/.test(m.text)).length, 0);
});
