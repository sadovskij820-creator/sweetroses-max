"use strict";
const crypto = require("crypto");
const { todayISO } = require("./orders");

const visitorKey = (id) => crypto.createHash("sha256").update("sr:" + id).digest("hex").slice(0, 12);

function day(stats, date) {
  return (stats.days[date] = stats.days[date] || { visitors: [], views: 0, carts: 0, orders: 0 });
}

/** type: visit | view | cart | order */
function trackEvent(stats, { type, productId, visitorId, now = new Date() }) {
  const d = day(stats, todayISO(now));
  if (type === "visit" && visitorId) {
    const k = visitorKey(visitorId);
    if (!d.visitors.includes(k)) d.visitors.push(k);
  }
  if (type === "view" || type === "cart") {
    d[type === "view" ? "views" : "carts"]++;
    if (productId) {
      const p = (stats.products[productId] = stats.products[productId] || { views: 0, carts: 0, orders: 0 });
      p[type === "view" ? "views" : "carts"]++;
    }
  }
  if (type === "order") d.orders++;
  // keep 120 days
  const keys = Object.keys(stats.days).sort();
  while (keys.length > 120) delete stats.days[keys.shift()];
}

function report(stats, catalog, now = new Date()) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const date = todayISO(new Date(now.getTime() - i * 864e5));
    const d = stats.days[date] || { visitors: [], orders: 0 };
    days.push({ date, visitors: d.visitors.length, orders: d.orders });
  }
  const week = days.slice(-7);
  const wv = week.reduce((s, d) => s + d.visitors, 0), wo = week.reduce((s, d) => s + d.orders, 0);
  const titles = new Map(catalog.products.map((p) => [String(p.id), p.title]));
  const topProducts = Object.entries(stats.products)
    .filter(([id]) => titles.has(id))
    .map(([id, v]) => ({ id, title: titles.get(id), ...v }))
    .sort((a, b) => b.views - a.views).slice(0, 10);
  return {
    today: days[days.length - 1],
    week: { visitors: wv, orders: wo, conversion: wv ? Math.round((wo / wv) * 1000) / 10 : 0 },
    days, topProducts,
  };
}

module.exports = { trackEvent, report };
