"use strict";
// 23.10.2026: night copies don't grow with every receipt; the app's files are compressed and not downloaded twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const max = require("../server/max");
const BK = require("../server/backup");
const { createApp } = require("../server/index");
const { createRelay } = require("../relay/index");

const TOKEN = "max-token-speed";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const quiet = { error() {}, log() {} };
function start(dataDir, bot) {
  const app = createApp({ messenger: "max", botToken: TOKEN, adminIds: "", dataDir, bot, seedFile: SEED, log: quiet, noRestore: true });
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const jpg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, n)]);
const at = (iso) => new Date(iso);
const hex = (c) => c.repeat(24);

test("night copy: shop photos as before, receipts only the new ones; a failed copy is reported in plain text", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-"));
  const docs = [], msgs = [];
  let fail = false;
  const bot = { sendMessage: async (chat, text) => { msgs.push({ chat: String(chat), text }); }, sendDocument: async (chat, buf, name) => { if (fail) throw new Error("MAX POST /uploads: 500"); docs.push({ buf, name }); }, getUsername: () => "shop_bot" };
  const { app } = await start(dataDir, bot); t.after(() => app.server.close());
  app.claimOwner({ id: 77 });
  const up = path.join(dataDir, "uploads"); fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, hex("a") + ".jpg"), jpg(1)); // a bouquet photo
  const addReceipt = (ch, iso) => {
    fs.writeFileSync(path.join(up, hex(ch) + ".jpg"), jpg(2));
    app.store.addOrder({ createdAt: iso, status: "new", name: "A", phone: "+79000000000", totals: { lines: [], addons: [], total: 100 }, receipt: "/u/" + hex(ch) + ".jpg", receiptAt: iso });
  };
  addReceipt("b", "2026-10-16T10:00:00Z");
  await app.runJobs(at("2026-10-16T19:05:00Z"));
  let names = BK.readZip(docs[0].buf).map((e) => e.name);
  assert.ok(names.includes("uploads/" + hex("a") + ".jpg") && names.includes("uploads/" + hex("b") + ".jpg"));
  // next day: a new receipt only — the bouquets are not repeated, the old receipt neither
  addReceipt("c", "2026-10-17T10:00:00Z");
  await app.runJobs(at("2026-10-17T19:05:00Z"));
  names = BK.readZip(docs[1].buf).map((e) => e.name);
  assert.deepEqual(names.filter((n) => n.startsWith("uploads/")), ["uploads/" + hex("c") + ".jpg"]);
  assert.ok(!docs[1].name.includes("foto"), "receipts don't count as «photos changed»");
  // the copy can't be sent → the owner gets a text message; next night the receipt is still included
  fail = true; addReceipt("d", "2026-10-18T10:00:00Z");
  await app.runJobs(at("2026-10-18T19:05:00Z"));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(msgs.some((m) => m.chat === "77" && /не отправлена/.test(m.text) && /500/.test(m.text)));
  fail = false;
  await app.runJobs(at("2026-10-19T19:05:00Z"));
  names = BK.readZip(docs[docs.length - 1].buf).map((e) => e.name);
  assert.ok(names.includes("uploads/" + hex("d") + ".jpg"), "the receipt of the failed night comes next time");
  assert.ok(!names.includes("uploads/" + hex("c") + ".jpg"));
});

test("speed: compressed files, «not changed» on the second open, the catalog is inside the page", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-"));
  const { app, url } = await start(dataDir, null); t.after(() => app.server.close());
  const r1 = await fetch(url + "/app.js");
  assert.equal(r1.headers.get("content-encoding"), "gzip");
  const tag = r1.headers.get("etag"); assert.ok(tag);
  await r1.arrayBuffer();
  const r2 = await fetch(url + "/app.js", { headers: { "If-None-Match": tag } });
  assert.equal(r2.status, 304);
  const page = await (await fetch(url + "/")).text();
  const m = /<script>window\.__CATALOG=([\s\S]*?);<\/script>/.exec(page);
  assert.ok(m, "the catalog is in the page");
  assert.equal(JSON.parse(m[1]).settings.brand, app.store.getCatalog().settings.brand);
  assert.ok(m[1].indexOf("</") === -1, "nothing in the data can close the script tag");
  const p2 = await fetch(url + "/", { headers: { "If-None-Match": (await fetch(url + "/")).headers.get("etag") } });
  assert.equal(p2.status, 304);
  // a change in the catalog changes the page
  app.store.getCatalog().settings.brand = "Новое имя </script>"; app.store.setCatalog(app.store.getCatalog());
  const page2 = await (await fetch(url + "/")).text();
  assert.match(page2, /Новое имя \\u003c\/script>/);
  const api = await fetch(url + "/api/catalog");
  assert.equal(api.headers.get("content-encoding"), "gzip");
  assert.equal((await api.json()).settings.brand, "Новое имя </script>");
});

test("the door abroad compresses pages for the phone and passes «not changed» through", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-"));
  const { app, url } = await start(dataDir, null); t.after(() => app.server.close());
  const door = createRelay({ key: "k", shop: url });
  await new Promise((r) => door.listen(0, r)); t.after(() => door.close());
  const durl = `http://127.0.0.1:${door.address().port}`;
  const raw = (p, h) => new Promise((resolve) => http.get(durl + p, { headers: h }, (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ res, buf: Buffer.concat(c) })); }));
  const a = await raw("/app.js", { "Accept-Encoding": "gzip" });
  assert.equal(a.res.headers["content-encoding"], "gzip");
  assert.ok(zlib.gunzipSync(a.buf).toString().includes("function"));
  assert.ok(a.buf.length < 70000);
  const b = await raw("/app.js", { "Accept-Encoding": "gzip", "If-None-Match": a.res.headers.etag });
  assert.equal(b.res.statusCode, 304);
});

test("«будет с …»: on that day the mark is gone — from the catalog at once and from the product by the background job", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "av-"));
  const { app, url } = await start(dataDir, null); t.after(() => app.server.close());
  const LY = require("../server/loyalty");
  const today = LY.todayLocal(new Date()), later = LY.todayLocal(new Date(Date.now() + 5 * 864e5));
  const c = app.store.getCatalog(), [a, b] = c.products.filter((p) => !p.hidden);
  a.availFrom = today; b.availFrom = later; app.store.setCatalog(c);
  const pub = await (await fetch(url + "/api/catalog")).json();
  assert.equal(pub.products.find((p) => p.id === a.id).availFrom, undefined);
  assert.equal(pub.products.find((p) => p.id === b.id).availFrom, later);
  await app.runJobs(new Date());
  assert.equal(app.store.getCatalog().products.find((p) => p.id === a.id).availFrom, undefined);
  assert.equal(app.store.getCatalog().products.find((p) => p.id === b.id).availFrom, later);
});
