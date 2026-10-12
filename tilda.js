"use strict";
/** Imports products from the Sweet Roses Tilda store (the same source the site uses). */

const API = "https://store.tildaapi.com/api/getproductslist/";
const clean = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function mapProduct(p) {
  const text = clean(p.text);
  const parts = text.split("*").map(clean);
  let images = [];
  try { images = JSON.parse(p.gallery || "[]").map((g) => g.img).filter(Boolean); } catch (e) {}
  const m = /Можно выбрать\s*(\d)\s*вид/i.exec(text);
  return {
    id: String(p.uid),
    title: clean(p.title),
    short: clean(p.descr),
    intro: parts[0] || "",
    details: parts.slice(1).filter((x) => x && !/^при оформлении/i.test(x)),
    price: Math.round(parseFloat(p.price) || 0),
    oldPrice: p.priceold ? Math.round(parseFloat(p.priceold)) : null,
    images: images.slice(0, 6),
    chocolateChoices: m ? Number(m[1]) : 0,
    sourceUrl: p.url || "",
  };
}

async function fetchStore(parts, fetchImpl = fetch) {
  const byId = new Map();
  for (const [cat, uid] of Object.entries(parts)) {
    const res = await fetchImpl(`${API}?storepartuid=${uid}&getparts=true&getoptions=true&slice=1&size=500`);
    if (!res.ok) throw new Error(`Сайт не ответил (${res.status}). Попробуйте позже.`);
    const json = await res.json();
    for (const raw of json.products || []) {
      const p = byId.get(String(raw.uid)) || Object.assign(mapProduct(raw), { cats: [] });
      if (cat !== "full" && !p.cats.includes(cat)) p.cats.push(cat);
      byId.set(p.id, p);
    }
  }
  return [...byId.values()];
}

/** Merges site products into the catalog. Keeps admin choices: hidden flag, order, and manual category edits for existing items. */
function mergeProducts(catalog, siteProducts) {
  const existing = new Map(catalog.products.map((p) => [String(p.id), p]));
  let updated = 0, added = 0;
  let maxSort = Math.max(0, ...catalog.products.map((p) => p.sort || 0));
  for (const sp of siteProducts) {
    const cur = existing.get(sp.id);
    if (cur) {
      Object.assign(cur, { title: sp.title, short: sp.short, intro: sp.intro, details: sp.details, price: sp.price, oldPrice: sp.oldPrice, images: sp.images.length ? sp.images : cur.images, chocolateChoices: sp.chocolateChoices, sourceUrl: sp.sourceUrl });
      updated++;
    } else {
      catalog.products.push(Object.assign(sp, { hidden: false, sort: ++maxSort }));
      added++;
    }
  }
  const siteIds = new Set(siteProducts.map((p) => p.id));
  const missing = catalog.products.filter((p) => p.sourceUrl && !siteIds.has(String(p.id))).length;
  return { updated, added, missing };
}

module.exports = { fetchStore, mergeProducts, mapProduct };
