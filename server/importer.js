"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * One-time catalog import (made for Flowers Gagulya, 16.10.2026).
 * The shop is already running, so the seed is no longer read. A file <name>.import.json next to the seed
 * adds real products once: photos are copied into /data/uploads, demo products (photos from /demo/) are removed,
 * the import id is remembered in settings.importsDone, so later builds never add the products twice.
 * Settings, orders, staff and customers are not touched.
 */
function importCatalog(store, dataDir, importFile, log = console) {
  if (!importFile || !fs.existsSync(importFile)) return null;
  let imp;
  try { imp = JSON.parse(fs.readFileSync(importFile, "utf8")); } catch (e) { log.error("Импорт каталога: файл не читается — " + e.message); return null; }
  const c = store.getCatalog();
  c.settings = c.settings || {};
  const done = Array.isArray(c.settings.importsDone) ? c.settings.importsDone : [];
  if (!imp.id || done.includes(imp.id)) return null;

  const dir = path.dirname(importFile);
  const uploads = path.join(dataDir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const photo = (name) => {
    if (!/^[a-z0-9-]{1,60}\.(jpg|png|webp)$/.test(name)) return null;
    const file = fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : path.join(dir, "import", name);
    if (!fs.existsSync(file)) { log.error("Импорт каталога: нет фото " + name); return null; }
    const buf = fs.readFileSync(file);
    const out = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 24) + "." + name.split(".").pop();
    if (!fs.existsSync(path.join(uploads, out))) fs.writeFileSync(path.join(uploads, out), buf);
    return "/u/" + out;
  };

  let removed = 0;
  if (imp.removeDemo) {
    const before = c.products.length;
    c.products = c.products.filter((p) => !(p.images || []).length || !(p.images || []).every((u) => /^\/demo\//.test(u)));
    removed = before - c.products.length;
  }
  for (const cat of imp.categories || []) {
    if (!c.categories.some((x) => x.id === cat.id)) c.categories.push(Object.assign({ hidden: false, sort: c.categories.length }, cat));
  }
  const ids = new Set(c.products.map((p) => String(p.id)));
  let sort = Math.max(0, ...c.products.map((p) => p.sort || 0));
  let added = 0;
  for (const p of imp.products || []) {
    let id = String(p.id || "i" + (added + 1));
    while (ids.has(id)) id += "x";
    ids.add(id);
    c.products.push({
      id, title: String(p.title || "Букет"), short: p.short || "", intro: p.intro || "", details: p.details || [],
      images: (p.photos || []).map(photo).filter(Boolean), cats: p.cats || [], price: Math.max(0, Math.round(Number(p.price) || 0)),
      oldPrice: null, chocolateChoices: 0, hidden: !!p.hidden, sort: ++sort,
    });
    added++;
  }
  // contacts and other shop settings sent by the owner (only the keys listed in the file are changed)
  const SETTING_KEYS = ["phone", "address", "hours", "map2gis", "mapRoute", "mapYandex", "socials", "demoNote", "madeBy", "about"];
  for (const k of SETTING_KEYS) if (imp.settings && k in imp.settings) c.settings[k] = imp.settings[k];
  c.settings.importsDone = done.concat(imp.id);
  store.setCatalog(c);
  log.log(`Импорт каталога «${imp.id}»: добавлено ${added}, убрано примеров ${removed}`);
  return { added, removed };
}

module.exports = { importCatalog };
