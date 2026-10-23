"use strict";
// Night backups and restore (made 16.10.2026): the shop must come back with the same customers, orders, bonuses and photos.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const max = require("../server/max");
const BK = require("../server/backup");
const { createApp } = require("../server/index");

const TOKEN = "max-token-backup";
const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");
const quiet = { error() {}, log() {} };
const asUser = (id) => max.signInitData({ id, first_name: "Анна" + id, username: "u" + id }, TOKEN);
async function req(url, method, body, init) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json", "X-Init-Data": init || "" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
function start(dataDir, extra = {}) {
  const docs = [], sent = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); }, sendDocument: async (chat, buf, name, caption) => { docs.push({ chat: String(chat), buf, name, caption }); }, getUsername: () => "shop_bot" };
  const app = createApp(Object.assign({ messenger: "max", botToken: TOKEN, adminIds: "", dataDir, bot, seedFile: SEED, log: quiet }, extra));
  return new Promise((resolve) => app.server.listen(0, () => resolve({ app, docs, sent, url: `http://127.0.0.1:${app.server.address().port}` })));
}
const jpg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("photo-" + n)]);
const at = (iso) => new Date(iso);

test("zip: what goes in comes out (stored photos, deflated json, cyrillic names); Windows-readable crc", () => {
  const entries = [{ name: "catalog.json", data: Buffer.from(JSON.stringify({ a: "привет".repeat(50) })) }, { name: "uploads/" + "a".repeat(24) + ".jpg", data: jpg(1) }, { name: "КАК-ВОССТАНОВИТЬ.txt", data: Buffer.from("текст") }];
  const out = BK.readZip(BK.makeZip(entries));
  assert.deepEqual(out.map((e) => e.name), entries.map((e) => e.name));
  out.forEach((e, i) => assert.ok(e.data.equals(entries[i].data)));
  assert.equal(BK.crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.throws(() => BK.readZip(Buffer.from("not a zip")), /не ZIP/);
});

test("night copy: once a day after 3:00, sent to the owner, 14 kept on the server, photos only when they changed", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  const { app, docs, url } = await start(dataDir); t.after(() => app.server.close());
  app.claimOwner({ id: 77 });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "uploads", "b".repeat(24) + ".jpg"), jpg(2));
  await app.runJobs(at("2026-10-16T17:30:00Z")); // 01:30 in Irkutsk — too early
  assert.equal(docs.length, 0);
  await app.runJobs(at("2026-10-16T19:05:00Z")); // 03:05
  assert.equal(docs.length, 1);
  assert.equal(docs[0].chat, "77");
  assert.match(docs[0].name, /^gagulya-flowers-backup-2026-10-17-0305-foto\.zip$/);
  assert.match(docs[0].caption, /Копия Gagulya Flowers/);
  const files = BK.readZip(docs[0].buf).map((e) => e.name);
  for (const f of ["manifest.json", "catalog.json", "uploads/" + "b".repeat(24) + ".jpg", "КАК-ВОССТАНОВИТЬ.txt"]) assert.ok(files.includes(f), f);
  await app.runJobs(at("2026-10-16T19:35:00Z")); // same night — no second copy
  assert.equal(docs.length, 1);
  await app.runJobs(at("2026-10-17T19:10:00Z")); // next night, photos unchanged — data only
  assert.equal(docs.length, 2);
  assert.ok(!docs[1].name.includes("foto"));
  assert.match(docs[1].caption, /Фото букетов не менялись/);
  assert.ok(!BK.readZip(docs[1].buf).some((e) => e.name.startsWith("uploads/")));
  for (let d = 18; d < 40; d++) await app.runJobs(new Date(Date.UTC(2026, 9, d, 19, 10)));
  const kept = fs.readdirSync(path.join(dataDir, "backups")).filter((f) => /^backup-/.test(f));
  assert.equal(kept.length, 14);
  assert.ok(docs.filter((d) => d.name.includes("foto")).length >= 3, "photos at least once a week");
  // the owner's button «make a copy now» + status; managers and customers cannot
  const now = await req(url + "/api/admin/backup", "POST", null, asUser(77));
  assert.equal(now.status, 200);
  assert.equal(now.data.withPhotos, true);
  assert.equal(now.data.status.lastSent, 1);
  assert.equal((await req(url + "/api/admin/backup", "GET", null, asUser(5))).status, 403);
});

test("restore: a new empty server gets the customers, orders, bonuses, reviews and photos back; the old address is forgotten", async (t) => {
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-old-"));
  const A = await start(oldDir);
  A.app.claimOwner({ id: 77 });
  const S = A.app.store.getCatalog().settings;
  S.webAppUrl = "https://old-server.amvera.tech"; S.transfer = { enabled: true, card: "2200 0000 0000 0000" };
  A.app.store.setCatalog(A.app.store.getCatalog());
  A.app.customers.touch({ id: 501, first_name: "Мария" }, "s_otzyv");
  A.app.customers.addBonus(A.app.customers.get(501), 300, "manual");
  A.app.store.addOrder({ createdAt: new Date().toISOString(), status: "done", tgUser: { id: 501 }, totals: { total: 5000, lines: [] }, phone: "+79001112233" });
  A.app.store.getReviews().list.push({ id: "r1", rating: 5, status: "approved", name: "Мария", text: "Супер", at: new Date().toISOString() });
  A.app.store.saveReviews();
  fs.mkdirSync(path.join(oldDir, "uploads"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "uploads", "c".repeat(24) + ".jpg"), jpg(3));
  const r = await A.app.runBackup({ full: true });
  const copy = A.docs[0].buf;
  A.app.server.close();
  assert.ok(r.withPhotos);

  // a brand new server: the owner uploads the file into /data as restore.zip and restarts
  const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-new-"));
  fs.writeFileSync(path.join(newDir, "restore.zip"), copy);
  const B = await start(newDir); t.after(() => B.app.server.close());
  assert.equal(B.app.restored.length, 1);
  assert.equal(B.app.store.getCustomers().list["501"].name, "Мария");
  assert.ok(B.app.customers.get(501).history.some((h) => h.delta === 300));
  assert.equal(B.app.store.getOrders().list.length, 1);
  assert.equal(B.app.store.getReviews().list[0].text, "Супер");
  assert.equal(B.app.store.getCatalog().settings.transfer.card, "2200 0000 0000 0000");
  assert.equal(B.app.store.getCatalog().settings.webAppUrl, undefined, "the new server learns its own address");
  assert.ok(B.app.isAdmin({ id: 77 }), "the same owner");
  assert.ok(fs.existsSync(path.join(newDir, "uploads", "c".repeat(24) + ".jpg")));
  const photo = await fetch(B.url + "/u/" + "c".repeat(24) + ".jpg");
  assert.equal(photo.status, 200);
  assert.ok(!fs.existsSync(path.join(newDir, "restore.zip")));
  assert.ok(fs.readdirSync(newDir).some((f) => /^restore-done-.*restore\.zip$/.test(f)), "done files are renamed, a restart won't restore again");
  assert.ok(fs.readdirSync(path.join(newDir, "backups")).some((f) => /^before-restore-/.test(f)));
  const st = await req(B.url + "/api/admin/backup", "GET", null, asUser(77));
  assert.equal(st.data.restored.length, 1);
});

test("restore: a data-only copy + an older photo copy → the newest data wins; a broken file changes nothing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-two-"));
  const man = (iso, extra) => ({ name: "manifest.json", data: Buffer.from(JSON.stringify(Object.assign({ createdAt: iso, files: ["catalog"] }, extra))) });
  const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
  const old = BK.makeZip([man("2026-10-10T00:00:00Z"), { name: "catalog.json", data: Buffer.from(JSON.stringify(Object.assign({}, seed, { settings: Object.assign({}, seed.settings, { phone: "старый" }) }))) }, { name: "uploads/" + "d".repeat(24) + ".jpg", data: jpg(4) }]);
  const fresh = BK.makeZip([man("2026-10-16T00:00:00Z"), { name: "catalog.json", data: Buffer.from(JSON.stringify(Object.assign({}, seed, { settings: Object.assign({}, seed.settings, { phone: "новый" }) }))) }]);
  fs.writeFileSync(path.join(dir, "restore.zip"), fresh);
  fs.writeFileSync(path.join(dir, "restore-foto.zip"), old);
  fs.writeFileSync(path.join(dir, "restore-bad.zip"), Buffer.from("garbage"));
  const errors = [];
  const { app } = await start(dir, { log: { error: (m) => errors.push(m), log() {} } }); t.after(() => app.server.close());
  assert.equal(app.store.getCatalog().settings.phone, "новый");
  assert.ok(fs.existsSync(path.join(dir, "uploads", "d".repeat(24) + ".jpg")));
  assert.ok(errors.some((e) => /restore-bad\.zip/.test(e)));
  assert.ok(fs.existsSync(path.join(dir, "restore-bad.zip")), "a broken file stays for a look");
});

test("MAX: a file goes via an upload slot and is retried while «not ready»", async () => {
  const calls = [];
  let tries = 0;
  const request = async (method, p, body) => {
    calls.push({ method, p, body });
    if (p.startsWith("/uploads")) return { url: "https://upload.example/x", token: "" };
    if (p.startsWith("/messages")) { if (++tries < 3) throw new Error("MAX POST /messages: 400 attachment.not.ready"); return { ok: true }; }
    return {};
  };
  const bot = max.createBot({ token: "t", request, log: quiet });
  await bot.sendDocument(77, Buffer.from("zip"), "copy.zip", "Копия", { upload: async () => ({ token: "FILE-TOKEN" }), wait: async () => {} });
  const msg = calls.filter((c) => c.p.startsWith("/messages"));
  assert.equal(msg.length, 3);
  assert.deepEqual(msg[2].body.attachments, [{ type: "file", payload: { token: "FILE-TOKEN" } }]);
  assert.match(msg[2].p, /user_id=77/);
});

test("a copy too big for the chat (413) is sent in parts; all parts together restore everything", async (t) => {
  const fs2 = require("fs"), os2 = require("os"), path2 = require("path");
  const BK = require("../server/backup");
  const { createApp } = require("../server/index");
  const dataDir = fs2.mkdtempSync(path2.join(os2.tmpdir(), "bk413-"));
  fs2.mkdirSync(path2.join(dataDir, "uploads"), { recursive: true });
  for (let i = 0; i < 10; i++) fs2.writeFileSync(path2.join(dataDir, "uploads", (i.toString(16).padStart(2, "0") + "a".repeat(22)) + ".jpg"), require("crypto").randomBytes(900000));
  const docs = [];
  const bot = { sendMessage: async () => {}, sendPhotos: async () => {}, openButton: () => null, getUsername: () => "b", setWebAppUrl() {},
    sendDocument: async (chat, buf, name, cap) => { if (buf.length > 3e6) throw new Error("Telegram sendDocument: 413"); docs.push({ buf, name, cap }); } };
  const app = createApp({ messenger: "telegram", botToken: "1:x", bot, adminIds: "100", dataDir, seedFile: path2.join(__dirname, "..", "seed", "gagulya.seed.json"), log: { error() {}, log() {} }, noBackup: true });
  app.onBotStart({ id: 100, first_name: "Илья" }, "", "telegram");
  process.env.BACKUP_CHAT_IDS = "100";
  let r; try { r = await app.runBackup({ full: true }); } finally { delete process.env.BACKUP_CHAT_IDS; }
  assert.equal(r.error, ""); assert.equal(r.sentTo, 1);
  assert.ok(docs.length >= 4, "sent in several parts: " + docs.length);
  assert.ok(docs.every((d) => d.buf.length <= 3e6));
  assert.match(docs[0].cap, /частями/); assert.match(docs[1].name, /part2of/);
  // restore all parts into an empty folder → all 10 photos and the data are back
  const fresh = fs2.mkdtempSync(path2.join(os2.tmpdir(), "bk413r-"));
  docs.forEach((d, i) => fs2.writeFileSync(path2.join(fresh, `restore-${i + 1}.zip`), d.buf));
  const done = BK.restoreOnStart(fresh, { log() {}, error() {} });
  assert.equal(done.length, docs.length);
  assert.equal(fs2.readdirSync(path2.join(fresh, "uploads")).length, 10);
  assert.ok(fs2.existsSync(path2.join(fresh, "catalog.json")));
});
