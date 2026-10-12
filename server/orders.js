"use strict";
const { computeTotals, formatRub } = require("../public/pricing.js");

const TZ = "Asia/Irkutsk";
const todayISO = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function validateCustomer(c, settings, now = new Date()) {
  c = c || {};
  const out = {
    name: str(c.name, 80), phone: str(c.phone, 30), date: str(c.date, 10), time: str(c.time, 5),
    method: c.method === "delivery" ? "delivery" : "pickup", address: str(c.address, 200), comment: str(c.comment, 500),
  };
  const errors = [];
  if (out.name.length < 2) errors.push("Укажите имя");
  const digits = out.phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 12) errors.push("Проверьте номер телефона");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date) || out.date < todayISO(now)) errors.push("Выберите дату готовности не раньше сегодняшней");
  if (!(settings.timeSlots || []).includes(out.time)) errors.push("Выберите время готовности из списка");
  if (out.method === "delivery" && out.address.length < 5) errors.push("Укажите адрес доставки");
  return { customer: out, errors };
}

function isFirstOrder(orders, userId, phone) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-10);
  return !orders.list.some((o) => o.status !== "cancel" && ((userId && o.tgUser && o.tgUser.id === userId) || (digits && String(o.phone).replace(/\D/g, "").slice(-10) === digits)));
}

/** Returns { order } or { error } — prices are always recomputed here, never trusted from the client. */
function buildOrder({ catalog, orders, body, tgUser, now = new Date() }) {
  body = body || {};
  const cart = body.cart || {};
  const { customer, errors } = validateCustomer(body.customer, catalog.settings, now);
  if (errors.length) return { error: errors.join(". ") };
  const lines = Array.isArray(cart.lines) ? cart.lines.slice(0, 50) : [];
  const first = isFirstOrder(orders, tgUser && tgUser.id, customer.phone);
  const totals = computeTotals(catalog, { lines, addons: cart.addons || {} }, { promoCode: str(body.promoCode, 40), isFirstOrder: first });
  if (totals.errors.length) return { error: totals.errors.join(". ") + ". Обновите корзину." };
  if (!totals.lines.length) return { error: "Корзина пуста" };
  if (totals.promoError) return { error: totals.promoError + ". Уберите промокод в корзине и отправьте заявку ещё раз." };
  const cardText = cart.addons && cart.addons.card ? str(cart.cardText, 300) : "";
  const order = {
    createdAt: now.toISOString(), status: "new",
    name: customer.name, phone: customer.phone, date: customer.date, time: customer.time,
    method: customer.method, address: customer.address, comment: customer.comment, cardText,
    totals: { lines: totals.lines, addons: totals.addons, subtotal: totals.subtotal, discount: totals.discount, total: totals.total, promo: totals.promo },
    tgUser: tgUser ? { id: tgUser.id, username: tgUser.username || "", name: [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") } : null,
  };
  return { order };
}

function ruDate(iso) { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; }

function summaryText(o) {
  const t = o.totals;
  const rows = [
    ...t.lines.map((l) => `• ${l.title} × ${l.qty} — ${formatRub(l.sum)}${l.choc && l.choc.length ? `\n   шоколад: ${l.choc.join(", ")}` : ""}`),
    ...t.addons.map((a) => `• ${a.title} × ${a.qty} — ${formatRub(a.sum)}`),
  ];
  return [
    `${o.name}, ${o.phone}`,
    `${o.method === "delivery" ? "Доставка: " + o.address : "Самовывоз"} · ${ruDate(o.date)} к ${o.time}`,
    ...rows,
    t.discount ? `Скидка ${t.promo.percent}% (${t.promo.code}): −${formatRub(t.discount)}` : "",
    `Итого: ${formatRub(t.total)}${o.method === "delivery" ? " + доставка" : ""}`,
    o.cardText ? `Открытка: «${o.cardText}»` : "",
    o.comment ? `Пожелания: ${o.comment}` : "",
  ].filter(Boolean).join("\n");
}

function managerMessage(o, platform = "telegram") {
  const u = o.tgUser;
  let who = "—", label = "Telegram";
  if (platform === "max") {
    label = "MAX";
    if (u) who = u.username ? `<a href="https://max.ru/${encodeURIComponent(u.username)}">@${escHtml(u.username)}</a>` : `${escHtml(u.name || "профиль")} (ID ${escHtml(String(u.id))})`;
  } else if (u) {
    who = u.username ? `@${escHtml(u.username)}` : `<a href="tg://user?id=${u.id}">${escHtml(u.name || "профиль")}</a>`;
  }
  const pay = [
    o.bonusUsed ? `Оплачено бонусами: ${formatRub(o.bonusUsed)}\nК оплате: ${formatRub(o.toPay ?? Math.max(0, o.totals.total - o.bonusUsed))}` : "",
    o.paid ? "✅ <b>Оплачен онлайн</b>" : o.payError ? "⚠️ Онлайн-оплата не создалась — возьмите оплату при подтверждении" : "",
  ].filter(Boolean).join("\n");
  return `🍓 <b>Новая заявка №${o.id}</b>${o.paid ? " · Оплачен ✅" : ""}\n\n${escHtml(summaryText(o))}${pay ? "\n" + pay : ""}\n\n${label}: ${who}\nТелефон: <a href="tel:${escHtml(o.phone.replace(/[^\d+]/g, ""))}">${escHtml(o.phone)}</a>`;
}

module.exports = { validateCustomer, buildOrder, isFirstOrder, summaryText, managerMessage, todayISO };
