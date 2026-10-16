"use strict";
// One-time catalog import for a shop that is already running (Flowers Gagulya, 16.10.2026).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server/index");

const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const IMPORT = path.join(__dirname, "..", "seed", "gagulya.import.json");
const quiet = { error() {}, log() {} };
const make = (dataDir, importFile) => createApp({ messenger: "max", botToken: "", adminIds: "100", dataDir, bot: null, seedFile: SEED, importFile, log: quiet });

test("import adds the real catalog once, removes demo products and keeps settings", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));
  // the shop already runs on the seed and the owner has changed settings
  let app = make(dataDir, null);
  const c0 = app.store.getCatalog();
  assert.ok(c0.products.every((p) => p.images[0].startsWith("/demo/")));
  c0.settings.transfer = { enabled: true, card: "2200 0000 0000 0000" };
  c0.products.push({ id: "own1", title: "Свой букет", images: ["/u/" + "a".repeat(24) + ".jpg"], cats: [], price: 1000, sort: 99 });
  app.store.setCatalog(c0);

  app = make(dataDir, IMPORT);
  const imp = JSON.parse(fs.readFileSync(IMPORT, "utf8"));
  const c1 = app.store.getCatalog();
  assert.equal(c1.settings.transfer.card, "2200 0000 0000 0000");
  assert.ok(!c1.products.some((p) => p.images.some((u) => u.startsWith("/demo/"))));
  assert.ok(c1.products.some((p) => p.id === "own1"));
  assert.equal(c1.products.length, imp.products.length + 1);
  assert.deepEqual(c1.settings.importsDone, [imp.id]);
  const ecu = c1.products.find((p) => p.title.includes("эквадорская"));
  assert.equal(ecu.price, 29000); assert.equal(ecu.hidden, false);
  assert.equal(c1.products.filter((p) => !p.hidden && p.id !== "own1").length, 13);
  for (const p of c1.products.filter((x) => x.id !== "own1")) {
    assert.ok(p.images.length, p.title + " без фото");
    for (const u of p.images) assert.ok(fs.existsSync(path.join(dataDir, "uploads", u.slice(3))), u);
  }

  assert.equal(c1.settings.phone, "+7 901 666-01-00");
  assert.ok(c1.settings.mapRoute.includes("/directions/"));
  assert.ok(c1.settings.socials.some((x) => x.url === "https://t.me/Gagulya_Flowers"));
  assert.equal(c1.settings.demoNote, "");
  assert.ok(c1.settings.madeBy.text.includes("DigiTap"));
  // the next build (same import file) must not add anything again
  app = make(dataDir, IMPORT);
  assert.equal(app.store.getCatalog().products.length, imp.products.length + 1);
});

test("imported photos are served and every product is valid", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));
  const app = make(dataDir, IMPORT);
  await new Promise((r) => app.server.listen(0, r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const p = app.store.getCatalog().products[0];
  const r = await fetch(url + p.images[0]);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  const cats = new Set(app.store.getCatalog().categories.map((c) => c.id));
  for (const x of app.store.getCatalog().products) for (const c of x.cats) assert.ok(cats.has(c), x.title + ": " + c);
  app.server.close();
});
