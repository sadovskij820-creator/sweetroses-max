"use strict";
// Delivery zones, payment by transfer to the shop's card, order photos to managers (made for Flowers Gagulya, 15.10.2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const max = require("../server/max");
const { todayISO, minutesNow } = require("../server/orders");
const { computeTotals, zoneTime } = require("../public/pricing.js");
const { createApp } = require("../server/index");

const TOKEN = "max-token-gagulya";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
const P1 = seed.products[0]; // 3 900 ₽
const P3 = seed.products[2]; // 5 500 ₽

function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gag-"));
  const sent = [], photos = [];
  const bot = {
    sendMessage: async (chat, text, ex) => { sent.push({ chat: String(chat), text, ex }); },
    sendPhotos: async (chat, urls, caption) => { photos.push({ chat: String(chat), urls, caption }); },
  };
  const app = createApp({ messenger: "max", botToken: TOKEN, adminIds: "100", dataDir, bot, seedFile: SEED, log: { error() {}, log() {} }, ...extra });
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, sent, photos, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const asUser = (id) => max.signInitData({ id, first_name: "U" + id, username: "user" + id }, TOKEN);
const ADMIN = asUser(100);
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const tomorrow = () => todayISO(new Date(Date.now() + 864e5));
const order = (customer = {}, lines = [{ id: P1.id, qty: 1 }]) => ({
  cart: { lines, addons: {} },
  customer: Object.assign({ name: "Анна", phone: "+7 900 111-22-33", date: tomorrow(), time: "14:00", method: "pickup" }, customer),
});
const wait = () => new Promise((r) => setTimeout(r, 30));
const TRANSFER = { enabled: true, mode: "now", card: "2200700012345678", phone: "+7 900 000-11-22", bank: "Т-Банк", holder: "Иван Г.", note: "" };

test("pricing: zone price is added, free from a sum, zone is required for delivery", () => {
  const cat = { products: seed.products, addons: [], chocolates: [], promos: [], settings: seed.settings };
  const a = computeTotals(cat, { lines: [{ id: P1.id, qty: 1 }] }, { method: "delivery", zoneId: "zokt" });
  assert.equal(a.delivery.price, 300);
  assert.equal(a.total, 3900 + 300);
  const b = computeTotals(cat, { lines: [{ id: P3.id, qty: 1 }] }, { method: "delivery", zoneId: "zokt" }); // 5 500 ≥ 5 000
  assert.equal(b.delivery.free, true);
  assert.equal(b.total, 5500);
  assert.match(computeTotals(cat, { lines: [{ id: P1.id, qty: 1 }] }, { method: "delivery" }).deliveryError, /район/);
  assert.equal(computeTotals(cat, { lines: [{ id: P1.id, qty: 1 }] }, { method: "pickup" }).delivery, null);
  // no zones → the old way: delivery is priced by the manager
  const noZones = computeTotals(Object.assign({}, cat, { settings: {} }), { lines: [{ id: P1.id, qty: 1 }] }, { method: "delivery" });
  assert.equal(noZones.deliveryError, null);
  assert.equal(noZones.total, 3900);
  assert.equal(zoneTime({ from: 40, to: 60 }), "40–60 мин");
  assert.equal(zoneTime({ from: 90, to: 120 }), "1,5–2 ч");
});

test("order: delivery to a zone is priced by the server; zone and message text", async () => {
  const { app, url, sent } = await startApp();
  const r = await req(url + "/api/orders", "POST", order({ method: "delivery", zoneId: "zlen", address: "ул. Ленина, 1, кв. 5" }), asUser(7));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const o = app.store.getOrders().list.find((x) => x.id === r.data.id);
  assert.equal(o.totals.delivery.title, "Ленинский");
  assert.equal(o.totals.total, 3900 + 500);
  await wait();
  const m = sent.find((s) => s.chat === "100" && /Новая заявка/.test(s.text));
  assert.match(m.text, /💐/);
  assert.match(m.text, /Доставка: Ленинский — ул\. Ленина/);
  assert.match(m.text, /Доставка \(Ленинский, 60–90 мин\): 500\s₽/);
  assert.match(m.text, /Итого: 4\s400\s₽/);
  assert.doesNotMatch(m.text, /\+ доставка/);
  // no zone chosen → error; unknown zone → error
  assert.equal((await req(url + "/api/orders", "POST", order({ method: "delivery", address: "ул. Ленина, 1" }), asUser(8))).status, 400);
  assert.equal((await req(url + "/api/orders", "POST", order({ method: "delivery", zoneId: "zxxx", address: "ул. Ленина, 1" }), asUser(8))).status, 400);
  app.server.close();
});

test("order: today, a slot the courier can't make for the zone is refused", async () => {
  const { app, url } = await startApp();
  const now = minutesNow();
  const slots = app.store.getCatalog().settings.timeSlots;
  const tooSoon = slots.find((t) => { const [h, m] = t.split(":").map(Number); const v = h * 60 + m; return v > now && v < now + 90 - 15; });
  if (tooSoon) {
    const r = await req(url + "/api/orders", "POST", order({ method: "delivery", zoneId: "zsvr", address: "ул. Ленина, 1", date: todayISO(), time: tooSoon }), asUser(9));
    assert.equal(r.status, 400);
    assert.match(r.data.error, /не успеет/);
  }
  app.server.close();
});

test("admin: zones are saved and cleaned; transfer details are validated", async () => {
  const { app, url } = await startApp();
  let r = await req(url + "/api/admin/settings", "PUT", { zones: [{ id: "zokt", name: "Октябрьский", price: 350, freeFrom: 0, from: 90, to: 40 }, { name: "  " }, { id: "bad id", name: "Солнечный", price: -5 }] }, ADMIN);
  assert.equal(r.status, 200);
  const z = app.store.getCatalog().settings.zones;
  assert.equal(z.length, 2);
  assert.deepEqual([z[0].id, z[0].price, z[0].from, z[0].to], ["zokt", 350, 40, 90]); // from/to swapped
  assert.match(z[1].id, /^z[a-f0-9]{8}$/);
  assert.equal(z[1].price, 0);
  // customers can't change settings
  assert.equal((await req(url + "/api/admin/settings", "PUT", { zones: [] }, asUser(7))).status, 403);
  // transfer: card must be 16–19 digits, at least card or phone when enabled
  assert.equal((await req(url + "/api/admin/settings", "PUT", { transfer: { enabled: true, card: "1234" } }, ADMIN)).status, 400);
  assert.equal((await req(url + "/api/admin/settings", "PUT", { transfer: { enabled: true } }, ADMIN)).status, 400);
  r = await req(url + "/api/admin/settings", "PUT", { transfer: TRANSFER }, ADMIN);
  assert.equal(r.status, 200);
  assert.equal(app.store.getCatalog().settings.transfer.card, "2200 7000 1234 5678");
  // the public catalog says transfer is on, but never carries the card itself
  const cat = (await req(url + "/api/catalog", "GET")).data;
  assert.deepEqual(cat.transfer, { enabled: true, mode: "now" });
  assert.doesNotMatch(JSON.stringify(cat), /2200 7000/);
  app.server.close();
});

test("transfer «now»: details right after the order, «Я оплатил» notifies managers, «Оплата получена» notifies the customer", async () => {
  const { app, url, sent } = await startApp();
  await req(url + "/api/admin/settings", "PUT", { transfer: TRANSFER }, ADMIN);
  const r = await req(url + "/api/orders", "POST", order({ method: "delivery", zoneId: "zokt", address: "ул. Ленина, 1" }), asUser(7));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.transfer.amount, 4200);
  assert.equal(r.data.transfer.card, "2200 7000 1234 5678");
  assert.equal(r.data.transfer.payable, true);
  const id = r.data.id;
  await wait();
  assert.match(sent.find((s) => s.chat === "100" && /Новая заявка/.test(s.text)).text, /клиент ещё не сообщил об оплате/);
  assert.match(sent.find((s) => s.chat === "7").text, /К оплате 4\s200\s₽/);
  // somebody else can't see or claim this order
  assert.equal((await req(url + `/api/orders/${id}/transfer`, "GET", null, asUser(8))).status, 404);
  assert.equal((await req(url + `/api/orders/${id}/transfer`, "POST", null, asUser(8))).status, 404);
  // the customer says "paid" (twice — managers are told once)
  assert.equal((await req(url + `/api/orders/${id}/transfer`, "POST", null, asUser(7))).data.claimed, true);
  await req(url + `/api/orders/${id}/transfer`, "POST", null, asUser(7));
  await wait();
  assert.equal(sent.filter((s) => s.chat === "100" && /сообщил об оплате 4\s200\s₽/.test(s.text)).length, 1);
  const prof = (await req(url + "/api/profile", "GET", null, asUser(7))).data;
  assert.equal(prof.orders[0].transferClaimed, true);
  // the order stays "new" — night orders are not cancelled while waiting
  await app.runJobs(new Date(Date.now() + 5 * 3600e3));
  assert.equal(app.store.getOrders().list.find((x) => x.id === id).status, "new");
  // manager confirms receipt
  assert.equal((await req(url + `/api/admin/orders/${id}`, "PATCH", { paid: true }, asUser(7))).status, 403);
  assert.equal((await req(url + `/api/admin/orders/${id}`, "PATCH", { paid: true }, ADMIN)).status, 200);
  await wait();
  assert.equal(app.store.getOrders().list.find((x) => x.id === id).paid, true);
  assert.ok(sent.find((s) => s.chat === "7" && /Оплата заказа №\d+ получена/.test(s.text)));
  assert.equal((await req(url + `/api/orders/${id}/transfer`, "GET", null, asUser(7))).data.paid, true);
  app.server.close();
});

test("transfer «after»: no details until the manager confirms, then the details go to the chat", async () => {
  const { app, url, sent } = await startApp();
  await req(url + "/api/admin/settings", "PUT", { transfer: Object.assign({}, TRANSFER, { mode: "after" }) }, ADMIN);
  const r = await req(url + "/api/orders", "POST", order(), asUser(7));
  assert.equal(r.status, 200);
  assert.equal(r.data.transfer, undefined);
  assert.equal(r.data.transferAfter, true);
  const id = r.data.id;
  assert.equal((await req(url + `/api/orders/${id}/transfer`, "GET", null, asUser(7))).data.payable, false);
  assert.equal((await req(url + `/api/orders/${id}/transfer`, "POST", null, asUser(7))).status, 400);
  await req(url + `/api/admin/orders/${id}`, "PATCH", { status: "work" }, ADMIN);
  await wait();
  const msg = sent.find((s) => s.chat === "7" && /подтверждён/.test(s.text));
  assert.match(msg.text, /К оплате: <b>3\s900\s₽<\/b>/);
  assert.match(msg.text, /Карта: <b>2200 7000 1234 5678<\/b>/);
  assert.match(msg.text, /СБП по номеру/);
  assert.equal((await req(url + `/api/orders/${id}/transfer`, "GET", null, asUser(7))).data.payable, true);
  app.server.close();
});

test("transfer is off when online payment is on; no transfer without details", async () => {
  const { app, url } = await startApp();
  app.store.getCatalog().settings.transfer = Object.assign({}, TRANSFER, { card: "", phone: "" });
  let r = await req(url + "/api/orders", "POST", order(), asUser(7));
  assert.equal(r.data.transfer, undefined);
  app.store.getCatalog().settings.transfer = TRANSFER;
  app.store.getCatalog().settings.payments = { enabled: true, provider: "demo" };
  r = await req(url + "/api/orders", "POST", order(), asUser(7));
  assert.ok(r.data.pay, "online payment wins");
  assert.equal(r.data.transfer, undefined);
  app.server.close();
});

test("order photos: the bot sends the photos of what was ordered, with absolute links", async () => {
  const { app, url, photos } = await startApp();
  const c = app.store.getCatalog();
  c.settings.webAppUrl = "https://shop.example.amvera.tech";
  c.products[0].images = ["/u/" + "a".repeat(24) + ".jpg"];
  c.products[2].images = ["https://cdn.example.ru/rose.jpg"];
  const r = await req(url + "/api/orders", "POST", order({}, [{ id: P1.id, qty: 2 }, { id: P3.id, qty: 1 }]), asUser(7));
  assert.equal(r.status, 200);
  await wait();
  assert.equal(photos.length, 1);
  assert.deepEqual(photos[0].urls, ["https://shop.example.amvera.tech/u/" + "a".repeat(24) + ".jpg", "https://cdn.example.ru/rose.jpg"]);
  assert.match(photos[0].caption, /Фото к заявке №\d+: Букет «Нежность» × 2, Монобукет из 25 роз/);
  app.server.close();
});

test("gagulya seed: brand settings reach the app, demo pictures are allowed in products", async () => {
  const { app, url } = await startApp();
  const cat = (await req(url + "/api/catalog", "GET")).data;
  assert.equal(cat.settings.brand, "Gagulya Flowers");
  assert.equal(cat.settings.theme, "mono");
  assert.equal(cat.settings.zones.length, 4);
  const p = cat.products[0];
  const r = await req(url + `/api/admin/item/products/${p.id}`, "PUT", { images: ["/demo/gagulya-2.jpg", "/demo/../../etc.jpg"] }, ADMIN);
  assert.deepEqual(r.data.images, ["/demo/gagulya-2.jpg"]);
  const img = await fetch(url + "/demo/gagulya-1.jpg");
  assert.equal(img.status, 200);
  app.server.close();
});
