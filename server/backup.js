"use strict";
/**
 * Night backups (made 16.10.2026). A ZIP with everything in /data: the catalog and settings, orders, customers and bonuses,
 * reviews, broadcasts, stats — and the uploaded photos (/data/uploads).
 *  - every night: saved to /data/backups (the last 14 are kept) and sent to the owner (Ilya) in the bot chat;
 *    photos go into the archive when they changed since the last sent copy, and at least once a week;
 *  - restore: put the ZIP into /data as restore*.zip (Amvera → «Data» → upload) and restart — on start the app unpacks it,
 *    keeps a copy of what was there before, and renames the file to restore-done-*.zip.
 * ZIP is written by hand (no dependencies): «stored» for photos, deflate for JSON. Opens in Windows Explorer.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
/** entries: [{ name, data: Buffer }] → ZIP Buffer */
function makeZip(entries, now = new Date()) {
  const { time, date } = dosTime(now);
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = e.data;
    const deflate = !/\.(jpe?g|png|webp|zip)$/i.test(e.name);
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    locals.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
/** ZIP Buffer → [{ name, data }] (stored and deflated entries; reads the central directory) */
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("Это не ZIP-архив копии");
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Архив повреждён");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const lnl = buf.readUInt16LE(loff + 26), lxl = buf.readUInt16LE(loff + 28);
    const body = buf.slice(loff + 30 + lnl + lxl, loff + 30 + lnl + lxl + csize);
    if (!name.endsWith("/")) out.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : method === 0 ? body : (() => { throw new Error("Неизвестный формат сжатия в архиве"); })() });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const DATA_FILES = ["catalog", "orders", "customers", "reviews", "broadcasts", "stats"];
const UPLOAD_RE = /^[a-f0-9]{24}\.(jpg|png|webp)$/;
const uploadsList = (dataDir) => { try { return fs.readdirSync(path.join(dataDir, "uploads")).filter((f) => UPLOAD_RE.test(f)).sort(); } catch (e) { return []; } };

/** Builds the archive from the files in dataDir (call store.flush() first). */
function createBackup(dataDir, { withPhotos = true, brand = "", now = new Date() } = {}) {
  const entries = [];
  const files = [];
  for (const n of DATA_FILES) {
    const f = path.join(dataDir, n + ".json");
    if (fs.existsSync(f)) { entries.push({ name: n + ".json", data: fs.readFileSync(f) }); files.push(n); }
  }
  const photos = uploadsList(dataDir);
  if (withPhotos) for (const f of photos) entries.push({ name: "uploads/" + f, data: fs.readFileSync(path.join(dataDir, "uploads", f)) });
  const manifest = { app: "digitap-shop", brand, createdAt: now.toISOString(), files, photos: withPhotos ? photos.length : 0, photosTotal: photos.length };
  entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 1)) });
  entries.push({ name: "КАК-ВОССТАНОВИТЬ.txt", data: Buffer.from(RESTORE_HELP, "utf8") });
  return { buf: makeZip(entries, now), manifest };
}
const RESTORE_HELP = [
  "Резервная копия магазина (DigiTap).",
  "",
  "Как восстановить:",
  "1. Amvera → ваш проект → «Репозиторий» → вкладка «Data» → «Загрузить данные».",
  "2. Загрузите этот ZIP-файл как есть (не распаковывая). Имя должно начинаться с restore, например restore.zip — переименуйте, если нужно.",
  "   Если в этой копии нет фото (смотрите manifest.json: photos = 0), загрузите ещё последнюю копию с фото: restore-foto.zip.",
  "3. Перезапустите приложение (круглая стрелка). При запуске копия развернётся сама, а прежние данные сохранятся в /data/backups.",
  "",
  "Ссылки, QR-коды и бот остаются прежними: они ведут в бота, а не на адрес сервера.",
].join("\n");

/** Unpacks one archive into dataDir: JSON files are replaced, photos are added. Returns the manifest. */
function restoreBackup(dataDir, buf) {
  const entries = readZip(buf);
  const man = entries.find((e) => e.name === "manifest.json");
  if (!man) throw new Error("В архиве нет manifest.json — это не копия магазина");
  const manifest = JSON.parse(man.data.toString("utf8"));
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  let photos = 0;
  for (const e of entries) {
    const m = /^([a-z]+)\.json$/.exec(e.name);
    if (m && DATA_FILES.includes(m[1])) {
      const json = JSON.parse(e.data.toString("utf8")); // must parse — never write a broken file
      // the new server has its own address: let the app learn it again (links go to the bot, so they stay the same)
      if (m[1] === "catalog" && json.settings) delete json.settings.webAppUrl;
      const f = path.join(dataDir, m[1] + ".json"), tmp = f + ".restore.tmp";
      fs.writeFileSync(tmp, JSON.stringify(json, null, 1)); fs.renameSync(tmp, f);
    } else if (/^uploads\/[a-f0-9]{24}\.(jpg|png|webp)$/.test(e.name)) {
      fs.writeFileSync(path.join(dataDir, e.name), e.data); photos++;
    }
  }
  return Object.assign({}, manifest, { restoredPhotos: photos });
}

/**
 * On start, before the data is read: restore*.zip in dataDir → unpack (oldest copy first, so the newest data wins),
 * keep the previous data as backups/before-restore-*.zip, rename the file to restore-done-*.zip.
 */
function restoreOnStart(dataDir, log = console) {
  let files;
  try { files = fs.readdirSync(dataDir).filter((f) => /^restore(?!-done).*\.zip$/i.test(f)); } catch (e) { return []; }
  if (!files.length) return [];
  const list = [];
  for (const f of files) {
    try {
      const buf = fs.readFileSync(path.join(dataDir, f));
      const man = readZip(buf).find((e) => e.name === "manifest.json");
      list.push({ f, buf, at: man ? JSON.parse(man.data.toString("utf8")).createdAt || "" : "" });
    } catch (e) { log.error(`Восстановление: ${f} — ${e.message}`); }
  }
  if (!list.length) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
    const before = createBackup(dataDir, { withPhotos: false });
    fs.writeFileSync(path.join(dataDir, "backups", `before-restore-${stamp}.zip`), before.buf);
  } catch (e) { log.error("Восстановление: не удалось сохранить прежние данные — " + e.message); }
  const done = [];
  for (const x of list.sort((a, b) => a.at.localeCompare(b.at))) {
    try {
      const m = restoreBackup(dataDir, x.buf);
      fs.renameSync(path.join(dataDir, x.f), path.join(dataDir, `restore-done-${stamp}-${x.f}`));
      log.log(`Восстановлено из ${x.f}: копия от ${m.createdAt}, файлы: ${m.files.join(", ")}, фото: ${m.restoredPhotos}`);
      done.push(m);
    } catch (e) { log.error(`Восстановление: ${x.f} — ${e.message}`); }
  }
  return done;
}

/** Saves to dataDir/backups and keeps the newest `keep` copies. */
function saveLocal(dataDir, name, buf, keep = 14) {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  const nightly = fs.readdirSync(dir).filter((f) => /^backup-.*\.zip$/.test(f)).sort();
  for (const f of nightly.slice(0, Math.max(0, nightly.length - keep))) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ } }
  return path.join(dir, name);
}

module.exports = { makeZip, readZip, createBackup, restoreBackup, restoreOnStart, saveLocal, uploadsList, crc32 };
