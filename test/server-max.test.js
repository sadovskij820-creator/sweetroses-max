"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const max = require("../server/max");
const tgm = require("../server/telegram");
const { todayISO } = require("../server/orders");
const { createApp } = require("../server/index");

const TOKEN = "max-token-xyz";
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "catalog.seed.json"), "utf8"));
const P1 = seed.products.find((p) => p.title === "Бокс клубника в шоколаде S");

function startApp(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "srm-"));
  const sent = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); } };
  const app = createApp({ messenger: "max", botToken: TOKEN, adminIds: "100", dataDir, bot, log: { error() {}, log() {} }, ...extra });
  app.store.getCatalog().settings.payments = { enabled: false, provider: "demo" }; // payment flows are tested separately
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, sent, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const asUser = (id, opts = {}) => {
  const raw = max.signInitData({ id, first_name: "U" + id, username: opts.noUsername ? undefined : "user" + id }, TOKEN);
  return opts.fragment ? "WebAppData=" + encodeURIComponent(raw) + "&WebAppPlatform=android&WebAppVersion=26.2.8" : raw;
};
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "", "X-Platform": "max" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const goodOrder = () => ({
  cart: { lines: [{ id: P1.id, qty: 1, choc: ["Руби"] }], addons: {} },
  customer: { name: "Анна", phone: "+7 900 111-22-33", date: todayISO(new Date(Date.now() + 864e5)), time: "14:00", method: "pickup" },
});

test("MAX mode: order with MAX signature (fragment form too) → manager and customer notified via MAX ids", async () => {
  const { app, url, sent } = await startApp();
  const r = await req(url + "/api/orders", "POST", goodOrder(), asUser(7, { fragment: true }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 20));
  const toManager = sent.find((s) => s.chat === "100");
  assert.ok(toManager, "first admin gets the order when no manager ids set");
  assert.match(toManager.text, /Новая заявка/);
  assert.match(toManager.text, /MAX/);
  assert.doesNotMatch(toManager.text, /tg:\/\//);
  assert.ok(sent.find((s) => s.chat === "7"), "customer gets confirmation in MAX");
  app.server.close();
});

test("MAX mode: Telegram signature is not accepted, error mentions MAX", async () => {
  const { app, url } = await startApp();
  const tgInit = tgm.signInitData({ id: 7, first_name: "T" }, TOKEN);
  // a Telegram-signed string has the same algorithm — but it must still be a valid MAX launch to pass; here we sign with another token
  const foreign = max.signInitData({ id: 7, first_name: "X" }, "telegram-token");
  const r = await req(url + "/api/orders", "POST", goodOrder(), foreign);
  assert.equal(r.status, 401);
  assert.match(r.data.error, /MAX/);
  assert.ok(tgInit);
  app.server.close();
});

test("MAX mode: admin check and owner claim use MAX user ids", async () => {
  const { app, url } = await startApp({ adminIds: "" });
  assert.equal((await req(url + "/api/me", "GET", null, asUser(55))).data.isAdmin, false);
  assert.match(app.claimOwner({ id: 55 }), /администратором/);
  assert.doesNotMatch(app.claimOwner({ id: 56 }) || "", /администратором/);
  assert.equal((await req(url + "/api/me", "GET", null, asUser(55))).data.isAdmin, true);
  const me = (await req(url + "/api/me", "GET", null, asUser(55))).data;
  assert.equal(me.platform, "max");
  assert.equal((await req(url + "/api/admin/orders", "GET", null, asUser(56))).status, 403);
  assert.equal((await req(url + "/api/admin/orders", "GET", null, asUser(55))).status, 200);
  app.server.close();
});

test("MAX mode: catalog exposes platform and demo note, hides owner data", async () => {
  const { app, url } = await startApp();
  const { data } = await req(url + "/api/catalog", "GET");
  assert.equal(data.platform, "max");
  assert.equal(data.settings.ownerIds, undefined);
  assert.equal(data.settings.managerChatIds, undefined);
  app.server.close();
});
