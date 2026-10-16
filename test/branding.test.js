"use strict";
// The start page comes already in the shop's look — no flash of Sweet Roses before Gagulya (16.10.2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server/index");

async function page(seed) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "brand-"));
  const app = createApp({ messenger: "telegram", botToken: "", adminIds: "", dataDir, bot: null, seedFile: path.join(__dirname, "..", "seed", seed), log: { error() {}, log() {} }, noBackup: true });
  await new Promise((r) => app.server.listen(0, r));
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/`);
  const html = await res.text();
  app.server.close();
  return { res, html, app };
}

test("Gagulya: title, black-and-white theme, GF logo, phone and the flower icon are in the first HTML", async () => {
  const { res, html, app } = await page("gagulya.seed.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(html, /<title>Gagulya Flowers<\/title>/);
  assert.match(html, /<html lang="ru" data-brand="mono">/);
  assert.match(html, /class="monogram"[^>]*aria-label="Gagulya Flowers — на главную"><svg class="logo-mark"/);
  assert.ok(!/>S<i><\/i>R</.test(html), "no Sweet Roses monogram");
  assert.ok(!/Sweet Roses/.test(html.slice(0, html.indexOf("<script"))), "no Sweet Roses in the head");
  assert.match(html, /data-tab="catalog"[^>]*>\s*<svg viewBox="0 0 24 24"><path d="M7 4.5l2.5 2/);
  const tel = String(app.store.getCatalog().settings.phone || "").replace(/[^\d+]/g, "");
  if (tel) assert.ok(html.includes(`href="tel:${tel}"`));
});

test("Sweet Roses demo keeps its own look", async () => {
  const { html } = await page("catalog.seed.json");
  assert.match(html, /<title>Sweet Roses[^<]*<\/title>/);
  assert.ok(!/data-brand="mono"/.test(html));
});
