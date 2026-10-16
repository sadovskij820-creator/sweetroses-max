"use strict";
// ONLINE_PAYMENTS=off: a shop on a tariff without online payment (Gagulya, Бизнес) — no «Демо»/«ЮKassa», transfer works (16.10.2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const max = require("../server/max");
const { createApp } = require("../server/index");

const TOKEN = "max-token-payoff";
const OWNER = max.signInitData({ id: 100, first_name: "Владелец" }, TOKEN);
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function start(onlinePayments) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "payoff-"));
  const app = createApp({ messenger: "max", botToken: TOKEN, adminIds: "100", dataDir, bot: null, seedFile: path.join(__dirname, "..", "seed", "gagulya.seed.json"), log: { error() {}, log() {} }, noBackup: true, onlinePayments });
  await new Promise((r) => app.server.listen(0, r));
  return { app, url: `http://127.0.0.1:${app.server.address().port}` };
}

test("online payment switched off: hidden in the admin, cannot be turned on, card transfer is used", async (t) => {
  const { app, url } = await start(false); t.after(() => app.server.close());
  // even if it was on before
  const S = app.store.getCatalog().settings;
  S.payments = { enabled: true, provider: "demo" }; S.transfer = { enabled: true, mode: "now", card: "2200 0000 0000 0000" };
  app.store.setCatalog(app.store.getCatalog());
  const adm = await req(url + "/api/admin/catalog", "GET", null, OWNER);
  assert.equal(adm.data.onlinePayAllowed, false);
  assert.equal(adm.data.paymentsResolved.enabled, false);
  const cat = await req(url + "/api/catalog", "GET");
  assert.equal(cat.data.payments.enabled, false);
  assert.equal(cat.data.transfer.enabled, true, "transfer to the card is shown");
  await req(url + "/api/admin/settings", "PUT", { payments: { enabled: true, provider: "yookassa" } }, OWNER);
  assert.equal(app.store.getCatalog().settings.payments.provider, "demo", "the owner cannot switch it on");
});

test("by default (Sweet Roses demo) online payment is available", async (t) => {
  const { app, url } = await start(undefined); t.after(() => app.server.close());
  const adm = await req(url + "/api/admin/catalog", "GET", null, OWNER);
  assert.equal(adm.data.onlinePayAllowed, true);
});
