"use strict";
/**
 * Loyalty: customers, bonus lots (with expiry), levels, referrals, important dates, segments.
 * Pure functions over plain objects — the server persists them in customers.json.
 */
const crypto = require("crypto");

const DAY = 864e5;
const TZ = "Asia/Irkutsk";

function defaultLoyalty() {
  return {
    features: { customers: true, bonuses: true, levels: true, burn: true, dates: true, repeat: true, referral: true, broadcasts: true, payments: true,
      hint: true, share: true, giftcard: true, sources: true, welcome: true, reviews: true, reviewAsk: true },
    welcomeBonus: 200,
    reviewBonus: 200,
    giftBonus: 200,
    maxPayPercent: 30,
    burnDays: 90,
    burnRemindDays: 7,
    levels: [
      { name: "Бронза", from: 0, percent: 5 },
      { name: "Серебро", from: 15000, percent: 7 },
      { name: "Золото", from: 40000, percent: 10 },
    ],
    referral: { friendBonus: 300, referrerBonus: 300 },
    datesRemindDays: 3,
  };
}
/** Settings with defaults filled in (old catalogs have no loyalty block). */
function loyaltyOf(settings) {
  const d = defaultLoyalty();
  const s = (settings && settings.loyalty) || {};
  return Object.assign({}, d, s, { features: Object.assign({}, d.features, s.features || {}), referral: Object.assign({}, d.referral, s.referral || {}), levels: Array.isArray(s.levels) && s.levels.length ? s.levels : d.levels });
}
const on = (L, f) => !!(L.features && L.features[f]);

const iso = (d) => new Date(d).toISOString();
const newId = () => crypto.randomBytes(5).toString("hex");

function newCustomer(user, now = new Date()) {
  return {
    id: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(" ").slice(0, 80), username: user.username || "",
    phone: "", createdAt: iso(now), lastSeenAt: iso(now), consent: false,
    refCode: crypto.randomBytes(4).toString("hex"), referredBy: null, referralRewarded: false,
    lots: [], history: [], dates: [], sent: {}, note: "",
  };
}

function log(c, entry) {
  c.history.unshift(entry);
  if (c.history.length > 200) c.history.length = 200;
}

/**
 * Launch parameter grammar (MAX/Telegram startapp, [A-Za-z0-9_-]): parts joined by "-", each "<key>_<value>".
 *   p_<product>  open a product      h_<product>  a hint "I want this as a gift"
 *   r_<refcode>  who shared the link  s_<source>   ad source / QR code
 *   g_<giftid>   a digital gift card  rv_1         open the review form (QR on the card in a bouquet)
 *   legacy: ref_<code>, paid_<order>
 */
function parseStart(sp) {
  sp = String(sp || "");
  const out = {};
  let m;
  if ((m = /^ref_([0-9a-f]{8})$/.exec(sp))) return { ref: m[1] };
  if ((m = /^paid_(\d{1,12})$/.exec(sp))) return { paid: m[1] };
  if ((m = /^pay_(\d{1,12})$/.exec(sp))) return { pay: m[1] };
  for (const part of sp.split("-")) {
    const i = part.indexOf("_");
    if (i < 1) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    if (k === "p" && /^[\w]{1,40}$/.test(v)) out.product = v;
    else if (k === "h" && /^[\w]{1,40}$/.test(v)) out.hint = v;
    else if (k === "r" && /^[0-9a-f]{8}$/.test(v)) out.ref = v;
    else if (k === "s" && /^[a-z0-9]{1,20}$/.test(v)) out.source = v;
    else if (k === "g" && /^[0-9a-f]{10}$/.test(v)) out.gift = v;
    else if (k === "rv") out.review = true;
    else if (k === "c" && /^[\w]{1,40}$/.test(v)) out.category = v; // a link straight to a category (25.10.2026)
  }
  return out;
}

/** Finds or creates the customer. A newcomer gets one gift: friend's bonus, gift-card bonus or the welcome bonus. */
function touchCustomer(db, user, { now = new Date(), settings = defaultLoyalty(), startParam = "", giftExists = () => false } = {}) {
  const id = String(user.id);
  let c = db.list[id];
  if (c) {
    c.lastSeenAt = iso(now);
    if (user.username) c.username = user.username;
    return c;
  }
  c = db.list[id] = newCustomer(user, now);
  const st = parseStart(startParam);
  const days = on(settings, "burn") ? settings.burnDays : 3650;
  const grant = (amount, kind, note) => {
    amount = Math.max(0, Math.round(amount || 0));
    if (!amount || !on(settings, "bonuses")) return;
    addBonus(c, amount, kind, { now, days, note });
    c.welcome = { amount, kind };
  };
  c.source = st.source || "";
  const owner = st.ref && Object.values(db.list).find((x) => x.refCode === st.ref && x.id !== id);
  if (owner && on(settings, "referral")) {
    c.referredBy = owner.id;
    if (!c.source) c.source = st.hint ? "hint" : "friend";
    grant(settings.referral.friendBonus, "friend", "Подарок по приглашению друга");
  } else if (st.gift && on(settings, "giftcard") && giftExists(st.gift)) {
    c.source = c.source || "gift";
    grant(settings.giftBonus, "gift", "Подарок к цифровой открытке");
  } else if (on(settings, "welcome")) {
    grant(settings.welcomeBonus, "welcome", "Приветственный подарок");
  }
  return c;
}

function addBonus(c, amount, kind, { now = new Date(), days = 90, orderId = null, note = "" } = {}) {
  amount = Math.round(amount);
  if (amount <= 0) return null;
  const lot = { id: newId(), amount, left: amount, kind, at: iso(now), expiresAt: iso(now.getTime() + (days || 3650) * DAY), orderId };
  c.lots.push(lot);
  log(c, { at: iso(now), delta: amount, kind, orderId, note });
  return lot;
}

const liveLots = (c, now) => c.lots.filter((l) => l.left > 0 && new Date(l.expiresAt) > now).sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
const balance = (c, now = new Date()) => liveLots(c, now).reduce((s, l) => s + l.left, 0);

/** Spends from the lots that expire first. Returns the amount actually spent. */
function spendBonus(c, amount, { now = new Date(), orderId = null, kind = "spend", note = "" } = {}) {
  let need = Math.max(0, Math.round(amount));
  let spent = 0;
  for (const l of liveLots(c, now)) {
    if (!need) break;
    const take = Math.min(l.left, need);
    l.left -= take; need -= take; spent += take;
  }
  if (spent) log(c, { at: iso(now), delta: -spent, kind, orderId, note });
  return spent;
}

function expireLots(c, now = new Date()) {
  let sum = 0;
  for (const l of c.lots) if (l.left > 0 && new Date(l.expiresAt) <= now) { sum += l.left; l.left = 0; }
  if (sum) log(c, { at: iso(now), delta: -sum, kind: "burn", note: "Сгорели" });
  // drop fully used lots older than a year to keep the file small
  c.lots = c.lots.filter((l) => l.left > 0 || now - new Date(l.at) < 365 * DAY);
  return sum;
}

/** Bonuses that expire within `days` — { amount, date, lots } or null. */
function burningSoon(c, now, days) {
  const until = now.getTime() + days * DAY;
  const lots = liveLots(c, now).filter((l) => new Date(l.expiresAt).getTime() <= until);
  if (!lots.length) return null;
  return { amount: lots.reduce((s, l) => s + l.left, 0), date: lots[0].expiresAt, lots };
}

function levelFor(L, spent) {
  const levels = L.levels.slice().sort((a, b) => a.from - b.from);
  if (!on(L, "levels")) return { name: levels[0].name, percent: levels[0].percent, next: null };
  let cur = levels[0];
  for (const lv of levels) if (spent >= lv.from) cur = lv;
  const nx = levels.find((lv) => lv.from > spent);
  return { name: cur.name, percent: cur.percent, next: nx ? { name: nx.name, percent: nx.percent, remaining: nx.from - spent } : null };
}

function maxPayable(L, bal, total) {
  if (!on(L, "bonuses")) return 0;
  return Math.max(0, Math.min(bal, Math.floor((total * (L.maxPayPercent || 0)) / 100)));
}

/** Order became "done": accrue bonuses by the level before this order, reward the referrer on the friend's first done order. */
function onOrderDone(db, c, order, { settings, spentBefore = 0, now = new Date() }) {
  const L = settings;
  const res = { accrued: 0, referrerRewarded: null };
  if (!on(L, "bonuses") || order.bonusAccrued) return res;
  const pct = levelFor(L, spentBefore).percent;
  const base = Math.max(0, (order.totals.total || 0) - (order.bonusUsed || 0));
  const amount = Math.floor((base * pct) / 100);
  if (amount > 0) { addBonus(c, amount, "order", { now, days: on(L, "burn") ? L.burnDays : 3650, orderId: order.id, note: `За заказ №${order.id}` }); order.bonusAccrued = amount; res.accrued = amount; }
  if (on(L, "referral") && c.referredBy && !c.referralRewarded && db.list[c.referredBy]) {
    c.referralRewarded = true;
    const r = Math.round(L.referral.referrerBonus || 0);
    if (r > 0) { addBonus(db.list[c.referredBy], r, "referral", { now, days: on(L, "burn") ? L.burnDays : 3650, note: `Друг ${c.name || ""} сделал первый заказ`.trim() }); res.referrerRewarded = c.referredBy; }
  }
  return res;
}
/** Order moved back from "done": take the accrued bonuses back (as far as they are not spent yet). */
function onOrderUndone(c, order, { now = new Date() } = {}) {
  if (!order.bonusAccrued) return 0;
  const lot = c.lots.find((l) => l.orderId === order.id && l.kind === "order");
  let back = 0;
  if (lot) { back = Math.min(lot.left, order.bonusAccrued); lot.left -= back; }
  log(c, { at: iso(now), delta: -order.bonusAccrued, kind: "reverse", orderId: order.id, note: `Отмена начисления за заказ №${order.id}` });
  order.bonusAccrued = 0;
  return back;
}

/* ---------- important dates ---------- */
function addDate(c, { title, md, remindDays }) {
  title = String(title || "").trim().slice(0, 60);
  md = String(md || "").trim();
  const m = /^(\d{2})-(\d{2})$/.exec(md);
  if (!title) throw new Error("Укажите, что за дата");
  if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) throw new Error("Проверьте дату");
  if (c.dates.length >= 20) throw new Error("Можно сохранить до 20 дат");
  const d = { id: newId(), title, md, remindDays: remindDays ? Math.max(1, Math.min(14, Math.round(remindDays))) : null };
  c.dates.push(d);
  return d;
}
/** Dates that are exactly `days` (or their own remindDays) ahead of `today` (YYYY-MM-DD, local). */
function dueDates(c, today, days) {
  const [y] = today.split("-").map(Number);
  const t = Date.UTC(...today.split("-").map((n, i) => (i === 1 ? n - 1 : +n)));
  return c.dates.filter((d) => {
    const n = d.remindDays || days;
    const [mm, dd] = d.md.split("-").map(Number);
    for (const yy of [y, y + 1]) {
      const day = Math.min(dd, new Date(Date.UTC(yy, mm, 0)).getUTCDate()); // 29 Feb → 28 Feb
      const diff = Math.round((Date.UTC(yy, mm - 1, day) - t) / DAY);
      if (diff === n) return true;
    }
    return false;
  });
}

/* ---------- segments ---------- */
function orderStatsFor(orders, id) {
  const mine = orders.list.filter((o) => o.tgUser && String(o.tgUser.id) === String(id) && o.status !== "cancel");
  const done = mine.filter((o) => o.status === "done");
  return {
    count: mine.length, doneCount: done.length,
    spent: done.reduce((s, o) => s + Math.max(0, (o.totals.total || 0) - (o.bonusUsed || 0)), 0),
    lastOrderAt: mine.length ? mine[mine.length - 1].createdAt : null,
    lastOrder: mine.length ? mine[mine.length - 1] : null,
  };
}
function segmentOf(st, c, now = new Date()) {
  const last = st.lastOrderAt ? new Date(st.lastOrderAt) : null;
  if (last && now - last > 60 * DAY) return "sleeping";
  if (st.doneCount >= 2) return "regular";
  return "new";
}
const SEGMENTS = { all: "Все", regular: "Постоянные", new: "Новые", sleeping: "Давно не заказывали" };
const inSegment = (wanted, seg) => wanted === "all" || wanted === seg;

const todayLocal = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
const hourLocal = (now = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now));

module.exports = {
  parseStart, defaultLoyalty, loyaltyOf, on, newCustomer, touchCustomer, addBonus, balance, spendBonus, expireLots, burningSoon,
  levelFor, maxPayable, onOrderDone, onOrderUndone, addDate, dueDates, orderStatsFor, segmentOf, SEGMENTS, inSegment,
  todayLocal, hourLocal,
};
