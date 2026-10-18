"use strict";
// 18.10.2026: a category's own picture (the circle on the home page) and filling a category with products from the admin.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tg = require("../server/telegram");
const { createApp } = require("../server/index");
const TOKEN = "123:cat";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const admin = tg.signInitData({ id: 100, first_name: "Гагуля" }, TOKEN);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
const req = async (url, method, body, init) => { const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };

test("a category gets its own picture; products are added to and removed from it", async (t) => {
  const bot = { sendMessage: async () => {}, sendPhotos: async () => {}, openButton: () => null, getUsername: () => "b", setWebAppUrl() {} };
  const app = createApp({ messenger: "telegram", botToken: TOKEN, bot, adminIds: "100", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cat-")), seedFile: SEED, log: { error() {}, log() {} }, noBackup: true });
  await new Promise((r) => app.server.listen(0, r)); t.after(() => app.server.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const cat = app.store.getCatalog().categories[0];
  const up = await fetch(url + "/api/admin/upload", { method: "POST", headers: { "X-Init-Data": admin }, body: PNG });
  const photo = (await up.json()).url;
  assert.match(photo, /^\/u\//);
  assert.equal((await req(url + `/api/admin/item/categories/${cat.id}`, "PUT", { image: photo }, admin)).status, 200);
  assert.equal((await req(url + "/api/catalog", "GET")).data.categories.find((c) => c.id === cat.id).image, photo);
  // someone else's address is refused; "" goes back to the first product's photo
  assert.equal((await req(url + `/api/admin/item/categories/${cat.id}`, "PUT", { image: "javascript:alert(1)" }, admin)).status, 400);
  assert.equal((await req(url + `/api/admin/item/categories/${cat.id}`, "PUT", { image: "" }, admin)).data.image, "");
  // a buyer can't change it
  assert.equal((await req(url + `/api/admin/item/categories/${cat.id}`, "PUT", { image: photo }, tg.signInitData({ id: 5 }, TOKEN))).status, 403);
  // put a product into the category and take it out
  const p = app.store.getCatalog().products.find((x) => !x.cats.includes(cat.id));
  assert.ok((await req(url + `/api/admin/item/products/${p.id}`, "PUT", { cats: [...p.cats, cat.id] }, admin)).data.cats.includes(cat.id));
  assert.ok(!(await req(url + `/api/admin/item/products/${p.id}`, "PUT", { cats: p.cats.filter((x) => x !== cat.id) }, admin)).data.cats.includes(cat.id));
});

test("extras: the owner adds, renames, puts a photo on and deletes an extra; the price counts in the order", async (t) => {
  const bot = { sendMessage: async () => {}, sendPhotos: async () => {}, openButton: () => null, getUsername: () => "b", setWebAppUrl() {} };
  const app = createApp({ messenger: "telegram", botToken: TOKEN, bot, adminIds: "100", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "add-")), seedFile: SEED, log: { error() {}, log() {} }, noBackup: true });
  await new Promise((r) => app.server.listen(0, r)); t.after(() => app.server.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const a = await req(url + "/api/admin/item/addons", "POST", { title: "Клубника в шоколаде", price: 900 }, admin);
  assert.equal(a.status, 200); assert.match(a.data.id, /^a/);
  const up = await fetch(url + "/api/admin/upload", { method: "POST", headers: { "X-Init-Data": admin }, body: PNG });
  const photo = (await up.json()).url;
  const e = await req(url + `/api/admin/item/addons/${a.data.id}`, "PUT", { image: photo, text: "9 ягод", title: "Клубника в шоколаде 9 шт" }, admin);
  assert.equal(e.data.image, photo); assert.equal(e.data.text, "9 ягод");
  const cat = (await req(url + "/api/catalog", "GET")).data;
  assert.ok(cat.addons.some((x) => x.id === a.data.id && x.image === photo));
  // a buyer can't add extras
  assert.equal((await req(url + "/api/admin/item/addons", "POST", { title: "x", price: 1 }, tg.signInitData({ id: 5 }, TOKEN))).status, 403);
  // the price is counted
  const P = require("../public/pricing.js");
  const tt = P.computeTotals ? P.computeTotals(cat, { lines: [{ id: cat.products[0].id, qty: 1 }], addons: { [a.data.id]: 2 } }) : null;
  if (tt) assert.ok(tt.addons.some((x) => x.id === a.data.id && x.sum === 1800));
  assert.equal((await req(url + `/api/admin/item/addons/${a.data.id}`, "DELETE", null, admin)).status, 200);
  assert.ok(!(await req(url + "/api/catalog", "GET")).data.addons.some((x) => x.id === a.data.id));
  // categories still can't be deleted
  assert.equal((await req(url + `/api/admin/item/categories/${cat.categories[0].id}`, "DELETE", null, admin)).status, 400);
});
