"use strict";
// Reviews: a card with a QR code in every bouquet → «Как вам букет?» (made 16.10.2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const max = require("../server/max");
const { createApp } = require("../server/index");

const TOKEN = "max-token-reviews";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const quiet = { error() {}, log() {} };

function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-"));
  const sent = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); }, getUsername: () => "gagulya_bot" };
  const app = createApp({ messenger: "max", botToken: TOKEN, adminIds: "100", dataDir, bot, seedFile: SEED, log: quiet });
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, sent, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const asUser = (id, startParam) => max.signInitData({ id, first_name: "Анна" + id, username: "u" + id }, TOKEN, undefined, startParam ? { start_param: startParam } : {});
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const wait = () => new Promise((r) => setTimeout(r, 30));
const ADMIN = asUser(100);

test("a 5-star review: bonus, consent, waits for approval, then shows in the app with a 2GIS suggestion", async (t) => {
  const { app, sent, url } = await startApp(); t.after(() => app.server.close());
  await req(url + "/api/admin/settings", "PUT", { review2gis: "https://2gis.ru/irkutsk/firm/70000001097370571/tab/reviews" }, ADMIN);
  const U = asUser(201);
  const r = await req(url + "/api/reviews", "POST", { rating: 5, text: "Очень свежие розы!", consent: true }, U);
  assert.equal(r.status, 200);
  assert.equal(r.data.bonus, 200);
  assert.equal(r.data.status, "pending");
  assert.equal(r.data.link2gis, "https://2gis.ru/irkutsk/firm/70000001097370571/tab/reviews");
  await wait();
  assert.ok(sent.some((m) => m.text.includes("Новый отзыв") && m.text.includes("Очень свежие розы")));
  const c = app.customers.get(201);
  assert.equal(c.consent, true);
  assert.ok(c.history.some((h) => h.delta === 200));
  // not public before approval
  assert.equal((await req(url + "/api/reviews", "GET")).data.count, 0);
  const adm = await req(url + "/api/admin/reviews", "GET", null, ADMIN);
  assert.equal(adm.status, 200);
  assert.equal(adm.data.link, "https://max.ru/gagulya_bot?start=rv_1-s_otzyv");
  assert.ok(app.store.getCatalog().settings.sources.some((x) => x.slug === "otzyv"), "the card QR is counted as an ad source");
  assert.equal((await req(url + `/api/admin/reviews/${r.data.id}`, "PATCH", { status: "approved", reply: "Спасибо!" }, ADMIN)).status, 200);
  const pub = await req(url + "/api/reviews", "GET");
  assert.equal(pub.data.count, 1);
  assert.equal(pub.data.avg, 5);
  assert.equal(pub.data.list[0].reply, "Спасибо!");
  assert.equal(pub.data.list[0].phone, undefined, "no contacts in public reviews");
  const cat = await req(url + "/api/catalog", "GET");
  assert.equal(cat.data.reviews.count, 1);
  assert.equal(cat.data.reviews.bonus, 200);
  // the customer cannot moderate
  assert.equal((await req(url + `/api/admin/reviews/${r.data.id}`, "PATCH", { status: "hidden" }, U)).status, 403);
});

test("a bad review is never published, goes to the managers, and still gets the bonus once in 30 days", async (t) => {
  const { app, sent, url } = await startApp(); t.after(() => app.server.close());
  const U = asUser(301);
  assert.equal((await req(url + "/api/reviews", "POST", { rating: 2 }, U)).status, 400, "1–3 stars need a few words");
  const r = await req(url + "/api/reviews", "POST", { rating: 2, text: "Привезли на час позже" }, U);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "private");
  assert.equal(r.data.bonus, 200);
  assert.equal(r.data.link2gis, "", "unhappy customers are not sent to 2GIS");
  await wait();
  assert.ok(sent.some((m) => m.text.includes("Клиент недоволен") && m.text.includes("Привезли на час позже")));
  assert.equal((await req(url + "/api/reviews", "GET")).data.count, 0);
  // the next review a minute later: no second bonus
  app.store.getReviews().list[0].at = new Date(Date.now() - 5 * 60e3).toISOString();
  const again = await req(url + "/api/reviews", "POST", { rating: 5, text: "Позвонили, всё решили" }, U);
  assert.equal(again.data.bonus, 0);
  // too fast in a row
  assert.equal((await req(url + "/api/reviews", "POST", { rating: 5 }, U)).status, 429);
  assert.equal((await req(url + "/api/reviews", "POST", { rating: 7 }, asUser(302))).status, 400);
  assert.equal((await req(url + "/api/reviews", "POST", { rating: 5 })).status, 401, "only inside the messenger");
});

test("the QR link opens the review form; customers upload photos only as pictures", async (t) => {
  const { app, url } = await startApp(); t.after(() => app.server.close());
  const me = await req(url + "/api/me", "GET", null, asUser(401, "rv_1-s_otzyv"));
  assert.equal(me.data.start.review, true);
  assert.equal(app.customers.get(401).source, "otzyv");
  const res = app.onBotStart({ id: 402, first_name: "Оля" }, "rv_1-s_otzyv");
  assert.equal(res.button, "⭐ Оставить отзыв");
  assert.match(res.greeting, /200 бонусов/);
  assert.equal(res.appPayload, "rv_1-s_otzyv");
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const up = await fetch(url + "/api/reviews/photo", { method: "POST", headers: { "X-Init-Data": asUser(401) }, body: jpg });
  const u = await up.json();
  assert.equal(up.status, 200);
  assert.match(u.url, /^\/u\/[a-f0-9]{24}\.jpg$/);
  const bad = await fetch(url + "/api/reviews/photo", { method: "POST", headers: { "X-Init-Data": asUser(401) }, body: Buffer.from("<script>") });
  assert.equal(bad.status, 400);
  const r = await req(url + "/api/reviews", "POST", { rating: 4, photos: [u.url, "https://evil.example/x.jpg"] }, asUser(401));
  assert.deepEqual(app.store.getReviews().list.find((x) => x.id === r.data.id).photos, [u.url]);
  // the owner can switch reviews off
  await req(url + "/api/admin/settings", "PUT", { loyalty: { features: { reviews: false } } }, ADMIN);
  assert.equal((await req(url + "/api/catalog", "GET")).data.reviews, null);
  assert.equal((await req(url + "/api/reviews", "POST", { rating: 5 }, asUser(403))).status, 400);
});

test("Telegram: the QR opens the bot chat, its button opens the review form (buttons have no start_param)", async (t) => {
  const tgm = require("../server/telegram");
  const bot = tgm.createBot({ token: "1:x", webAppUrl: "https://shop.example" });
  assert.equal(bot.openButton("Оценить букет", "rv_1-s_otzyv").inline_keyboard[0][0].web_app.url, "https://shop.example?start=rv_1-s_otzyv");
  assert.equal(bot.openButton("Открыть").inline_keyboard[0][0].web_app.url, "https://shop.example");
  assert.equal(bot.openButton("x", "bad param!").inline_keyboard[0][0].web_app.url, "https://shop.example");
  const { app, url } = await startApp(); t.after(() => app.server.close());
  const r = await fetch(url + "/api/me", { headers: { "X-Init-Data": asUser(501), "X-Start-Param": "rv_1-s_otzyv" } });
  const me = await r.json();
  assert.equal(me.start.review, true);
  assert.equal(app.customers.get(501).source, "otzyv");
});
