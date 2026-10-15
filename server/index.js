"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createStore } = require("./store");
const messengers = { telegram: require("./telegram"), max: require("./max") };
const PLATFORM_NAME = { telegram: "Telegram", max: "MAX" };
const { buildOrder, isFirstOrder, managerMessage, summaryText } = require("./orders");
const { trackEvent, report } = require("./stats");
const { fetchStore, mergeProducts } = require("./tilda");
const { findPromo, formatRub, zoneTime } = require("../public/pricing.js");
const LY = require("./loyalty");
const { createPayments } = require("./payments");
const qrcode = require("./vendor/qrcode.js");
const crypto = require("crypto");

loadDotEnv(path.join(__dirname, "..", ".env"));

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

function createApp(opts = {}) {
  // MESSENGER=max (or MAX_BOT_TOKEN set) runs the app inside MAX; otherwise Telegram.
  const messenger = opts.messenger ?? process.env.MESSENGER ?? (process.env.MAX_BOT_TOKEN ? "max" : "telegram");
  if (!messengers[messenger]) throw new Error("MESSENGER должен быть telegram или max");
  const M = messengers[messenger];
  const config = {
    messenger,
    botToken: opts.botToken ?? (messenger === "max" ? process.env.MAX_BOT_TOKEN : process.env.BOT_TOKEN) ?? "",
    adminIds: (opts.adminIds ?? process.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
    managerChatId: opts.managerChatId ?? process.env.MANAGER_CHAT_ID ?? "",
    // Amvera (and similar hosts) mount persistent storage at /data
    dataDir: opts.dataDir ?? process.env.DATA_DIR ?? (fs.existsSync("/data") ? "/data" : path.join(__dirname, "..", "data")),
    devMode: opts.devMode ?? process.env.DEV_MODE === "1",
    publicDir: path.join(__dirname, "..", "public"),
    // SEED=gagulya starts a new shop from seed/gagulya.seed.json (only used on the very first start, when /data is empty)
    seedFile: opts.seedFile ?? path.join(__dirname, "..", "seed", (/^[a-z0-9-]{1,40}$/.test(process.env.SEED || "") ? process.env.SEED : "catalog") + ".seed.json"),
  };
  const store = createStore(config.dataDir, config.seedFile);
  const bot = opts.bot !== undefined ? opts.bot : config.botToken ? M.createBot({ token: config.botToken, webAppUrl: process.env.WEBAPP_URL || store.getCatalog().settings.webAppUrl || "" }) : null;
  const log = opts.log || console;
  const orderTimes = new Map(); // rate limit per user/ip

  /* ---------- loyalty, customers, payments ---------- */
  const loyal = () => LY.loyaltyOf(store.getCatalog().settings);
  const paySettings = () => Object.assign({ enabled: false, provider: "demo" }, store.getCatalog().settings.payments || {});
  const paymentsOn = () => paySettings().enabled && LY.on(loyal(), "payments");
  /* Payment by transfer to the shop's own card / SBP phone. The owner enters the details in the admin; the manager confirms receipt. */
  const transferSettings = () => Object.assign({ enabled: false, mode: "now", card: "", phone: "", bank: "", holder: "", note: "" }, store.getCatalog().settings.transfer || {});
  const transferOn = () => { const t = transferSettings(); return !!(t.enabled && (t.card || t.phone)) && !paymentsOn(); };
  const transferPayable = (o) => o.payMethod === "transfer" && !o.paid && o.status !== "cancel" && o.status !== "done" && (o.transferMode !== "after" || o.status === "work");
  function transferInfo(o) {
    const t = transferSettings();
    return { id: o.id, amount: o.toPay ?? o.totals.total, card: t.card, phone: t.phone, bank: t.bank, holder: t.holder, note: t.note, claimed: !!o.transferClaimedAt, paid: !!o.paid, payable: transferPayable(o) };
  }
  function transferText(o) {
    const t = transferSettings(), e = (x) => String(x).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    return [
      `К оплате: <b>${formatRub(o.toPay ?? o.totals.total)}</b>`,
      t.card ? `Карта: <b>${e(t.card)}</b>` : "",
      t.phone ? `СБП по номеру: <b>${e(t.phone)}</b>` : "",
      t.bank ? `Банк: ${e(t.bank)}` : "",
      t.holder ? `Получатель: ${e(t.holder)}` : "",
      t.note ? e(t.note) : "",
      "После перевода нажмите «Я оплатил» в приложении.",
    ].filter(Boolean).join("\n");
  }
  const E = () => store.getCatalog().settings.emoji || "🍓";
  let paymentsInst = null;
  function payments() {
    if (opts.payments) return opts.payments;
    const ps = paySettings();
    if (!paymentsInst || paymentsInst.provider !== ps.provider) {
      paymentsInst = createPayments({ provider: ps.provider, shopId: process.env.YOOKASSA_SHOP_ID || "", secretKey: process.env.YOOKASSA_SECRET_KEY || "", demoSecret: config.botToken || "demo-secret" });
    }
    return paymentsInst;
  }
  const custDb = () => store.getCustomers();
  const customers = {
    touch(user, startParam = "", now = new Date()) { const c = LY.touchCustomer(custDb(), user, { now, settings: loyal(), startParam, giftExists: (g) => !!findGift(g) }); store.saveCustomers(); return c; },
    get: (id) => custDb().list[String(id)] || null,
    addBonus(c, amount, kind, o = {}) { const lot = LY.addBonus(c, amount, kind, Object.assign({ days: loyal().burnDays }, o)); store.saveCustomers(); return lot; },
  };
  const findGift = (gid) => store.getOrders().list.find((o) => o.gift && o.gift.id === gid && o.status !== "cancel") || null;
  /**
   * Shareable link. In MAX it opens the bot CHAT (?start=) — so the shop stays in the person's chat list;
   * the bot then answers with an «Открыть» button that launches the app with the same parameters.
   * (?startapp= would open the app directly, but the chat would not appear.)
   */
  function botLink(param) {
    const u = bot && bot.getUsername && bot.getUsername();
    if (!u) return "";
    return messenger === "max" ? `https://max.ru/${u}?start=${param}` : `https://t.me/${u}?startapp=${param}`;
  }
  /** Opens the mini app directly (used where the person is already in the chat, e.g. return after payment). */
  function appDirectLink(param) {
    const u = bot && bot.getUsername && bot.getUsername();
    if (!u) return "";
    return messenger === "max" ? `https://max.ru/${u}?startapp=${param}` : `https://t.me/${u}?startapp=${param}`;
  }
  /** Sends to a customer; withButton adds the "open the shop" button. */
  async function sendUser(id, text, withButton) {
    if (!bot || !id) return false;
    let extra = {};
    if (withButton && bot.openButton) {
      const b = bot.openButton(withButton === true ? "Открыть магазин" : withButton);
      if (b) extra = messenger === "max" ? { buttons: b } : { reply_markup: b };
    }
    try { await bot.sendMessage(id, text, extra); return true; } catch (e) { log.error("Send " + id + ": " + e.message); return false; }
  }
  const ruDate = (d) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Irkutsk", day: "2-digit", month: "2-digit" }).format(new Date(d));

  function userFrom(req) {
    const init = req.headers["x-init-data"] || "";
    const u = M.validateInitData(init, config.botToken);
    if (u) {
      let startParam = "";
      try { startParam = new URLSearchParams(M.extractWebAppData ? M.extractWebAppData(init) : init).get("start_param") || ""; } catch (e) { /* none */ }
      return Object.assign(u, { platform: messenger, startParam });
    }
    if (config.devMode) return { id: config.adminIds[0] || 1, first_name: "Dev", platform: messenger };
    return null;
  }
  // Admins: ADMIN_IDS from .env plus the "owner" — the first person who sends /start when nobody is admin yet.
  const adminList = () => [...config.adminIds, ...((store.getCatalog().settings.ownerIds) || []).map(Number)];
  const isAdmin = (u) => !!u && adminList().includes(Number(u.id));
  function claimOwner(from) {
    if (!from || !from.id || adminList().length) return "";
    store.getCatalog().settings.ownerIds = [Number(from.id)];
    store.setCatalog(store.getCatalog());
    return "\n\n👑 <b>Вы назначены администратором.</b> В приложении у вас появилась шестерёнка — панель управления. Заявки будут приходить в этот чат.";
  }
  /** «Начать» in the bot chat: remember the customer (with the link's ref/source), mark the chat as saved. */
  function onBotStart(from, payload = "") {
    const owner = claimOwner(from);
    if (!from || !from.id) return owner;
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
    const c = customers.touch({ id: from.id, first_name: name || from.first_name, username: from.username }, payload);
    c.botStarted = true; store.saveCustomers();
    const st = LY.parseStart(payload);
    const product = (st.product || st.hint) && store.getCatalog().products.find((p) => String(p.id) === String(st.product || st.hint) && !p.hidden);
    const res = { text: owner, appPayload: payload === "save" ? "" : payload };
    if (st.gift && findGift(st.gift)) Object.assign(res, { greeting: "🎁 Вам открытка с подарком! Нажмите кнопку, чтобы её открыть.", button: "Открыть открытку" });
    else if (product && st.hint) Object.assign(res, { greeting: `💝 Вам намекают на подарок: «${product.title}». Нажмите кнопку, чтобы посмотреть.`, button: "Посмотреть подарок" });
    else if (product) Object.assign(res, { greeting: `Вам прислали «${product.title}». Нажмите кнопку, чтобы посмотреть.`, button: "Посмотреть" });
    else if (payload === "save") Object.assign(res, { greeting: "✅ Готово — магазин сохранён у вас в чатах. Здесь будут статусы заказов и бонусы. Нажмите кнопку, чтобы вернуться в магазин.", button: "Открыть магазин" });
    return res;
  }

  function publicCatalog() {
    const c = store.getCatalog();
    const cats = c.categories.filter((x) => !x.hidden);
    const settings = Object.assign({}, c.settings);
    delete settings.managerChatIds; delete settings.tildaParts; delete settings.ownerIds; delete settings.webAppUrl;
    const L = loyal();
    delete settings.loyalty; delete settings.payments; delete settings.sources; delete settings.transfer;
    return {
      platform: messenger,
      loyalty: { features: L.features, maxPayPercent: L.maxPayPercent, levels: L.levels, referral: L.referral, burnDays: L.burnDays, welcomeBonus: L.welcomeBonus, giftBonus: L.giftBonus },
      payments: { enabled: paymentsOn(), provider: paySettings().provider },
      transfer: { enabled: transferOn(), mode: transferSettings().mode },
      categories: cats,
      products: c.products.filter((p) => !p.hidden).map(({ sourceUrl, ...p }) => p),
      addons: c.addons.filter((a) => !a.hidden),
      chocolates: c.chocolates,
      promos: [], // codes are checked on the server
      settings,
    };
  }

  async function notify(text) {
    const c = store.getCatalog();
    const ids = new Set([...(c.settings.managerChatIds || []), config.managerChatId].map(String).filter(Boolean));
    if (!ids.size) ids.add(String(adminList()[0] || ""));
    const results = [];
    for (const id of ids) {
      if (!id || !bot) continue;
      try { await bot.sendMessage(id, text); results.push(id); } catch (e) { log.error("Notify " + id + ": " + e.message); }
    }
    return results;
  }

  /** Absolute address of a product photo, so the messenger can fetch it (uploads are served by this app at /u/...). */
  function absUrl(u) {
    if (/^https:\/\//.test(u)) return u;
    const base = (process.env.WEBAPP_URL || store.getCatalog().settings.webAppUrl || "").replace(/\/$/, "");
    return base && /^\/(u|demo)\//.test(u) ? base + u : "";
  }
  /** New order to the managers: the text first, then the photos of what was ordered (if the bot can send pictures). */
  async function notifyOrder(o) {
    const sent = await notify(managerMessage(o, messenger, E()));
    if (o.photosSent || !bot || !bot.sendPhotos || !sent.length) return sent;
    const urls = [...new Set(o.totals.lines.map((l) => absUrl(l.image || "")).filter(Boolean))].slice(0, 6);
    if (!urls.length) return sent;
    o.photosSent = true; store.saveOrders();
    const titles = o.totals.lines.filter((l) => l.image).map((l) => l.title + (l.qty > 1 ? " × " + l.qty : "")).join(", ");
    for (const id of sent) {
      try { await bot.sendPhotos(id, urls, `Фото к заявке №${o.id}: ${titles}`.slice(0, 1000)); } catch (e) { log.error("Фото в заявку " + id + ": " + e.message); }
    }
    return sent;
  }

  const routes = [];
  const on = (method, pattern, handler, { admin = false, raw = false } = {}) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, handler, admin, raw });
  };

  /* ---------- public ---------- */
  on("GET", "/api/catalog", () => publicCatalog());
  on("GET", "/api/me", ({ user }) => {
    const start = {};
    if (user) {
      customers.touch(user, user.startParam);
      const st = LY.parseStart(user.startParam);
      const pid = st.product || st.hint;
      if (pid && store.getCatalog().products.some((p) => String(p.id) === pid && !p.hidden)) {
        start.productId = pid;
        if (st.hint) {
          const from = st.ref && Object.values(custDb().list).find((x) => x.refCode === st.ref);
          Object.assign(start, { hint: true, fromName: from ? (from.name || "").split(" ")[0] : "" });
        }
      }
      if (st.gift && findGift(st.gift)) start.gift = st.gift;
      if (st.paid) start.paid = st.paid;
    }
    return { isAdmin: isAdmin(user), platform: messenger, startParam: user ? user.startParam || "" : "", start, user: user ? { id: user.id, first_name: user.first_name } : null };
  });

  /* ---------- profile ---------- */
  const needUser = (user) => { if (!user) throw httpError(401, `Откройте магазин через бота в ${PLATFORM_NAME[messenger]}.`); };
  const myOrders = (id) => store.getOrders().list.filter((o) => o.tgUser && String(o.tgUser.id) === String(id));
  function profileOf(user) {
    const L = loyal(), now = new Date();
    const c = customers.touch(user, user.startParam, now);
    const st = LY.orderStatsFor(store.getOrders(), user.id);
    return {
      features: L.features, name: c.name, consent: c.consent,
      balance: LY.on(L, "bonuses") ? LY.balance(c, now) : 0,
      level: Object.assign(LY.levelFor(L, st.spent), { spent: st.spent }),
      burning: LY.on(L, "bonuses") && LY.on(L, "burn") ? (() => { const b = LY.burningSoon(c, now, 30); return b ? { amount: b.amount, date: b.date } : null; })() : null,
      maxPayPercent: L.maxPayPercent,
      refLink: LY.on(L, "referral") ? botLink("ref_" + c.refCode) : "",
      refCode: c.refCode, linkBase: botLink(""),
      // MAX: opening the app by a link doesn't add the bot chat — nudge to press «Начать» once
      botStarted: messenger !== "max" || !!c.botStarted,
      chatLink: messenger === "max" ? botLink("save") : "",
      welcome: c.welcome && !c.welcomeSeen ? c.welcome : null,
      referral: L.referral, referredBy: !!c.referredBy,
      dates: LY.on(L, "dates") ? c.dates : [],
      history: LY.on(L, "bonuses") ? c.history.slice(0, 20) : [],
      orders: myOrders(user.id).slice(-20).reverse().map((o) => ({
        id: o.id, createdAt: o.createdAt, status: o.status, paid: !!o.paid, total: o.totals.total, toPay: o.toPay ?? o.totals.total,
        payMethod: o.payMethod || "", transferPayable: transferPayable(o), transferClaimed: !!o.transferClaimedAt,
        bonusUsed: o.bonusUsed || 0, bonusAccrued: o.bonusAccrued || 0, date: o.date, time: o.time,
        lines: o.totals.lines.map((l) => ({ id: l.id, qty: l.qty, choc: l.choc || [], title: l.title })),
        giftLink: o.gift ? botLink("g_" + o.gift.id) : "",
      })),
    };
  }
  on("GET", "/api/profile", ({ user }) => { needUser(user); return profileOf(user); });
  on("PUT", "/api/profile", ({ user, body }) => {
    needUser(user);
    const c = customers.touch(user, user.startParam);
    if ("consent" in body) c.consent = !!body.consent;
    if (body.welcomeSeen) c.welcomeSeen = true;
    store.saveCustomers();
    return profileOf(user);
  });
  on("POST", "/api/profile/dates", ({ user, body }) => {
    needUser(user);
    if (!LY.on(loyal(), "dates")) throw httpError(400, "Напоминания о датах выключены");
    const c = customers.touch(user, user.startParam);
    try { LY.addDate(c, { title: body.title, md: body.md, remindDays: body.remindDays }); } catch (e) { throw httpError(400, e.message); }
    store.saveCustomers();
    return profileOf(user);
  });
  on("DELETE", "/api/profile/dates/:id", ({ user, params }) => {
    needUser(user);
    const c = customers.touch(user, user.startParam);
    c.dates = c.dates.filter((d) => d.id !== params.id);
    store.saveCustomers();
    return profileOf(user);
  });

  on("GET", "/api/gift/:id", ({ params }) => {
    const o = /^[0-9a-f]{10}$/.test(params.id) && findGift(params.id);
    if (!o) throw httpError(404, "Открытка не найдена");
    const L = loyal();
    return { from: o.gift.from, to: o.gift.to, text: o.gift.text, bonus: LY.on(L, "giftcard") && LY.on(L, "bonuses") ? L.giftBonus : 0 };
  });

  /* ---------- payments ---------- */
  async function startPayment(order) {
    order.payAttempt = (order.payAttempt || 0) + 1;
    const p = payments();
    const r = await p.create(order, { amount: order.toPay, returnUrl: appDirectLink("paid_" + order.id) || (store.getCatalog().settings.webAppUrl || ""), description: `${store.getCatalog().settings.brand || "Заказ"} — заказ №${order.id}` });
    order.paymentId = r.paymentId; store.saveOrders();
    return { provider: p.provider, url: r.url || "", token: r.demoToken || "", amount: order.toPay };
  }
  async function markPaid(order) {
    if (order.paid) return;
    order.paid = true; order.paidAt = new Date().toISOString();
    if (order.status === "pay") order.status = "new";
    store.saveOrders();
    notifyOrder(order).catch(() => {});
    if (order.tgUser) sendUser(order.tgUser.id, `Оплата получена ✅\nЗаказ №${order.id} принят — ${store.getCatalog().settings.brand || "мы"} свяжемся с вами.`).catch(() => {});
  }
  on("POST", "/api/pay/demo", async ({ body }) => {
    const o = store.getOrders().list.find((x) => String(x.id) === String(body.orderId));
    if (!o || !payments().checkDemo(o.id, body.token)) throw httpError(403, "Неверная ссылка на оплату");
    if (o.status === "cancel") throw httpError(400, "Заказ уже отменён");
    await markPaid(o);
    return { ok: true, id: o.id };
  });
  on("POST", "/api/pay/yookassa", async ({ body }) => {
    const obj = (body && body.object) || {};
    const o = obj.metadata && store.getOrders().list.find((x) => String(x.id) === String(obj.metadata.orderId));
    if (o && !o.paid && o.status !== "cancel" && obj.id) {
      try { if (await payments().verify(obj.id, o, o.toPay)) await markPaid(o); } catch (e) { log.error("ЮKassa verify: " + e.message); }
    }
    return { ok: true };
  });
  on("POST", "/api/orders/:id/pay", async ({ user, params }) => {
    needUser(user);
    const o = myOrders(user.id).find((x) => String(x.id) === params.id);
    if (!o) throw httpError(404, "Заказ не найден");
    if (o.paid || o.status !== "pay") throw httpError(400, "Этот заказ не ждёт оплаты");
    try { return { id: o.id, pay: await startPayment(o) }; } catch (e) { throw httpError(502, "Не удалось создать оплату: " + e.message); }
  });
  on("GET", "/api/orders/:id/status", ({ user, params }) => {
    needUser(user);
    const o = myOrders(user.id).find((x) => String(x.id) === params.id);
    if (!o) throw httpError(404, "Заказ не найден");
    return { id: o.id, status: o.status, paid: !!o.paid, toPay: o.toPay ?? o.totals.total };
  });
  on("GET", "/api/orders/:id/transfer", ({ user, params }) => {
    needUser(user);
    const o = myOrders(user.id).find((x) => String(x.id) === params.id);
    if (!o || o.payMethod !== "transfer") throw httpError(404, "Заказ не найден");
    return transferInfo(o);
  });
  on("POST", "/api/orders/:id/transfer", async ({ user, params }) => {
    needUser(user);
    const o = myOrders(user.id).find((x) => String(x.id) === params.id);
    if (!o || o.payMethod !== "transfer") throw httpError(404, "Заказ не найден");
    if (o.paid) return transferInfo(o);
    if (!transferPayable(o)) throw httpError(400, o.status === "cancel" ? "Заказ отменён" : "Этот заказ пока не ждёт оплаты");
    if (!o.transferClaimedAt) {
      o.transferClaimedAt = new Date().toISOString(); store.saveOrders();
      notify(`💳 <b>Заявка №${o.id}: клиент сообщил об оплате ${formatRub(o.toPay ?? o.totals.total)}</b>\n${o.name}, ${o.phone}\nПроверьте поступление в банке и нажмите «Оплата получена» в приложении (Управление → Заявки).`).catch(() => {});
    }
    return transferInfo(o);
  });
  on("POST", "/api/promo", ({ body, user }) => {
    const p = findPromo(store.getCatalog(), body.code);
    if (!p) return { ok: false, message: "Такого промокода нет. Проверьте написание." };
    if (p.firstOrderOnly && user && !isFirstOrder(store.getOrders(), user.id, "")) return { ok: false, message: "Этот промокод действует только на первый заказ." };
    return { ok: true, percent: p.percent, message: `Скидка ${p.percent}% применена${p.firstOrderOnly ? " (на первый заказ)" : ""}` };
  });
  on("POST", "/api/orders", async ({ body, user, ip }) => {
    if (!user && config.botToken) throw httpError(401, `Откройте магазин через бота в ${PLATFORM_NAME[messenger]}, чтобы отправить заявку.`);
    const key = user ? "u" + user.id : "ip" + ip;
    const recent = (orderTimes.get(key) || []).filter((t) => Date.now() - t < 10 * 60e3);
    if (recent.length >= 5) throw httpError(429, "Слишком много заявок подряд. Позвоните нам: менеджер поможет быстрее.");
    const { order, error } = buildOrder({ catalog: store.getCatalog(), orders: store.getOrders(), body, tgUser: user });
    if (error) throw httpError(400, error);
    const L = loyal();
    const c = user ? customers.touch(user, user.startParam) : null;
    order.bonusUsed = 0;
    store.addOrder(order);
    if (c) {
      if ("consent" in body) c.consent = !!body.consent;
      c.phone = order.phone; if (!c.name) c.name = order.name;
      if (body.useBonus) {
        const amt = LY.maxPayable(L, LY.balance(c), order.totals.total - (order.totals.delivery ? order.totals.delivery.price : 0));
        if (amt > 0) order.bonusUsed = LY.spendBonus(c, amt, { orderId: order.id, note: `Оплата заказа №${order.id}` });
      }
      store.saveCustomers();
    }
    order.toPay = Math.max(0, order.totals.total - order.bonusUsed);
    if (body.gift && LY.on(L, "giftcard")) {
      const g = body.gift, clip = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
      order.gift = { id: crypto.randomBytes(5).toString("hex"), from: clip(order.name.split(" ")[0], 40), to: clip(g.to, 40), text: clip(g.text, 300) };
    }
    const giftLink = order.gift ? botLink("g_" + order.gift.id) : "";
    store.saveOrders();
    recent.push(Date.now()); orderTimes.set(key, recent);
    trackEvent(store.getStats(), { type: "order" }); store.touchStats();
    if (!paymentsOn() && transferOn() && user && order.toPay > 0) {
      order.payMethod = "transfer"; order.transferMode = transferSettings().mode === "after" ? "after" : "now"; store.saveOrders();
    }
    if (paymentsOn() && order.toPay > 0 && user) {
      order.status = "pay"; store.saveOrders();
      try { return { id: order.id, giftLink, pay: await startPayment(order) }; }
      catch (e) {
        log.error("Оплата: " + e.message);
        order.status = "new"; order.payError = e.message; store.saveOrders();
        notifyOrder(order).catch(() => {});
        return { id: order.id, giftLink, payError: "Онлайн-оплата сейчас недоступна — менеджер свяжется с вами." };
      }
    }
    const payNow = order.payMethod === "transfer" && order.transferMode !== "after";
    notifyOrder(order).catch(() => {});
    const S = store.getCatalog().settings;
    if (user) sendUser(user.id, `Спасибо! Заявка №${order.id} принята ${E()}\n` + (payNow
      ? `К оплате ${formatRub(order.toPay)}. Реквизиты для перевода — в приложении (Профиль → Мои заказы → «Оплатить»).`
      : `Менеджер ${S.brand || ""} свяжется с вами в течение 10 минут${S.hours ? " (" + S.hours.toLowerCase() + ")" : ""}.`.replace("  ", " ")), payNow ? "Оплатить" : false).catch(() => {});
    return Object.assign({ id: order.id, giftLink }, payNow ? { transfer: transferInfo(order) } : {}, order.payMethod === "transfer" && !payNow ? { transferAfter: true } : {});
  });
  on("POST", "/api/track", ({ body, user, ip }) => {
    const type = ["visit", "view", "cart"].includes(body.type) ? body.type : null;
    if (!type) return { ok: false };
    const pid = body.productId ? String(body.productId).slice(0, 20) : undefined;
    if (pid && !store.getCatalog().products.some((p) => String(p.id) === pid)) return { ok: false };
    trackEvent(store.getStats(), { type, productId: pid, visitorId: user ? "u" + user.id : "ip" + ip });
    store.touchStats();
    return { ok: true };
  });

  /* ---------- admin ---------- */
  const COLLS = ["products", "categories", "addons"];
  const findColl = (name) => { if (!COLLS.includes(name)) throw httpError(404, "Неизвестный раздел"); return store.getCatalog()[name]; };
  /* ---------- photos uploaded from the admin's phone: /data/uploads/<random>.<ext>, served at /u/<name> ---------- */
  const UPLOAD_RE = /^[a-f0-9]{24}\.(jpg|png|webp)$/;
  const okImage = (u) => /^https:\/\//.test(u) || (/^\/u\//.test(u) && UPLOAD_RE.test(u.slice(3))) || /^\/demo\/[a-z0-9-]{1,40}\.(jpg|png|webp)$/.test(u);
  const uploadsDir = path.join(config.dataDir, "uploads");
  function imageKind(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
    if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
    return null;
  }
  on("POST", "/api/admin/upload", ({ body }) => {
    if (!Buffer.isBuffer(body) || !body.length) throw httpError(400, "Фото не получено");
    const kind = imageKind(body);
    if (!kind) throw httpError(400, "Это не фото. Подходят JPG, PNG и WebP");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const name = crypto.randomBytes(12).toString("hex") + "." + kind;
    fs.writeFileSync(path.join(uploadsDir, name), body);
    return { url: "/u/" + name };
  }, { admin: true, raw: true });

  const PRODUCT_FIELDS = { title: "s", short: "s", intro: "s", details: "a", images: "a", cats: "a", price: "n", oldPrice: "n?", chocolateChoices: "n", hidden: "b" };
  const OTHER_FIELDS = { categories: { title: "s", hidden: "b" }, addons: { title: "s", price: "n", hidden: "b" } };
  function pick(body, spec) {
    const out = {};
    for (const [k, t] of Object.entries(spec)) {
      if (!(k in body)) continue;
      const v = body[k];
      if (t === "s") out[k] = String(v || "").trim().slice(0, 2000);
      if (t === "n") out[k] = Math.max(0, Math.round(Number(v) || 0));
      if (t === "n?") out[k] = v ? Math.max(0, Math.round(Number(v) || 0)) || null : null;
      if (t === "b") out[k] = !!v;
      if (t === "a") out[k] = (Array.isArray(v) ? v : []).map((x) => String(x).trim().slice(0, 500)).filter(Boolean).slice(0, 30);
    }
    if (out.images) out.images = out.images.filter(okImage);
    return out;
  }

  on("GET", "/api/admin/catalog", () => Object.assign({}, store.getCatalog(), { loyaltyResolved: loyal(), paymentsResolved: paySettings(), transferResolved: transferSettings(), env: { yookassa: !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY) } }), { admin: true });
  on("GET", "/api/admin/orders", () => ({ orders: store.getOrders().list.slice(-200).reverse().map((o) => ({ ...o, summary: summaryText(o) })) }), { admin: true });
  on("PATCH", "/api/admin/orders/:id", ({ params, body }) => {
    const o = store.getOrders().list.find((x) => String(x.id) === params.id);
    if (!o) throw httpError(404, "Заявка не найдена");
    if ("paid" in body && !("status" in body)) {
      const was = !!o.paid;
      o.paid = !!body.paid; o.paidAt = o.paid ? o.paidAt || new Date().toISOString() : null; store.saveOrders();
      if (o.paid && !was && o.tgUser) sendUser(o.tgUser.id, `Оплата заказа №${o.id} получена ✅ Спасибо!`).catch(() => {});
      return { ok: true };
    }
    if (!["new", "work", "done", "cancel", "pay"].includes(body.status)) throw httpError(400, "Неизвестный статус");
    const prev = o.status;
    o.status = body.status; store.saveOrders();
    if (prev !== o.status && o.status === "work" && o.tgUser) {
      const pay = transferPayable(o) && !o.transferClaimedAt && o.transferMode === "after";
      sendUser(o.tgUser.id, pay ? `Заказ №${o.id} подтверждён ✅\n\n${transferText(o)}` : `Заказ №${o.id} подтверждён ✅ Уже готовим.`, pay ? "Оплатить" : false).catch(() => {});
    }
    const c = o.tgUser && customers.get(o.tgUser.id);
    if (c && prev !== o.status) {
      const L = loyal();
      if (o.status === "done") {
        const st = LY.orderStatsFor(store.getOrders(), c.id);
        const spentBefore = st.spent - Math.max(0, o.totals.total - (o.bonusUsed || 0));
        const r = LY.onOrderDone(custDb(), c, o, { settings: L, spentBefore });
        if (r.accrued) sendUser(c.id, `Заказ №${o.id} выполнен ${E()} Спасибо!\nНачислено ${r.accrued} бонусов, на счёте ${LY.balance(c)}. Ими можно оплатить до ${L.maxPayPercent}% следующего заказа.`, true).catch(() => {});
        if (r.referrerRewarded) sendUser(r.referrerRewarded, `🎁 Ваш друг сделал первый заказ — вам начислено ${L.referral.referrerBonus} бонусов!`, true).catch(() => {});
      }
      if (prev === "done") LY.onOrderUndone(c, o);
      if (o.status === "cancel" && o.bonusUsed && !o.bonusRefunded) { LY.addBonus(c, o.bonusUsed, "refund", { days: L.burnDays, orderId: o.id, note: `Возврат за отменённый заказ №${o.id}` }); o.bonusRefunded = true; }
      store.saveCustomers(); store.saveOrders();
    }
    return { ok: true };
  }, { admin: true });

  /* ---------- admin: customers & broadcasts ---------- */
  function customerRow(c, now = new Date()) {
    const st = LY.orderStatsFor(store.getOrders(), c.id);
    return { id: c.id, name: c.name, username: c.username, phone: c.phone, orders: st.count, spent: st.spent, lastOrderAt: st.lastOrderAt, createdAt: c.createdAt,
      balance: LY.balance(c, now), level: LY.levelFor(loyal(), st.spent).name, segment: LY.segmentOf(st, c, now), consent: c.consent, dates: c.dates.length };
  }
  const listCustomers = (segment = "all", q = "") => {
    const ql = String(q || "").toLowerCase().trim();
    return Object.values(custDb().list).map((c) => customerRow(c))
      .filter((r) => LY.inSegment(segment, r.segment) && (!ql || [r.name, r.username, r.phone].join(" ").toLowerCase().includes(ql)))
      .sort((a, b) => String(b.lastOrderAt || b.createdAt).localeCompare(String(a.lastOrderAt || a.createdAt)));
  };
  on("GET", "/api/admin/customers", ({ query }) => ({ segments: LY.SEGMENTS, customers: listCustomers(query.get("segment") || "all", query.get("q")).slice(0, 500) }), { admin: true });
  on("GET", "/api/admin/customers/:id", ({ params }) => {
    const c = customers.get(params.id);
    if (!c) throw httpError(404, "Клиент не найден");
    return Object.assign(customerRow(c), { note: c.note, history: c.history.slice(0, 50), datesList: c.dates, referredBy: c.referredBy,
      orderList: myOrders(c.id).slice(-30).reverse().map((o) => ({ id: o.id, createdAt: o.createdAt, status: o.status, paid: !!o.paid, total: o.totals.total, summary: summaryText(o) })) });
  }, { admin: true });
  on("PATCH", "/api/admin/customers/:id", ({ params, body }) => {
    const c = customers.get(params.id);
    if (!c) throw httpError(404, "Клиент не найден");
    if ("note" in body) c.note = String(body.note || "").slice(0, 1000);
    const d = Math.round(Number(body.bonusDelta) || 0);
    const note = String(body.comment || "Начислено вручную").slice(0, 120);
    if (d > 0) LY.addBonus(c, Math.min(d, 100000), "manual", { days: loyal().burnDays, note });
    if (d < 0) LY.spendBonus(c, -d, { kind: "manual", note: String(body.comment || "Списано вручную").slice(0, 120) });
    store.saveCustomers();
    return Object.assign(customerRow(c), { note: c.note, history: c.history.slice(0, 50) });
  }, { admin: true });
  /* ---------- admin: ad sources & QR codes ---------- */
  function sourcesReport() {
    const all = Object.values(custDb().list), orders = store.getOrders().list;
    return (store.getCatalog().settings.sources || []).map((src) => {
      const ids = new Set(all.filter((c) => c.source === src.slug).map((c) => c.id));
      const mine = orders.filter((o) => o.tgUser && ids.has(String(o.tgUser.id)) && o.status !== "cancel" && o.status !== "pay");
      return Object.assign({}, src, { link: botLink("s_" + src.slug), customers: ids.size, orders: mine.length, revenue: mine.reduce((sum, o) => sum + (o.toPay ?? o.totals.total), 0) });
    });
  }
  on("GET", "/api/admin/sources", () => {
    const all = Object.values(custDb().list);
    const other = { friend: "По ссылке друга", hint: "Через «Намекнуть»", gift: "Через цифровую открытку" };
    return { sources: sourcesReport(), auto: Object.entries(other).map(([k, t]) => ({ slug: k, title: t, customers: all.filter((c) => c.source === k).length })), linkBase: botLink("") };
  }, { admin: true });
  on("PUT", "/api/admin/sources", ({ body }) => {
    const seen = new Set();
    const list = (Array.isArray(body.sources) ? body.sources : []).slice(0, 50).map((x) => ({ title: String(x.title || "").trim().slice(0, 60), slug: String(x.slug || "").trim() }))
      .filter((x) => x.title && /^[a-z0-9]{1,20}$/.test(x.slug) && !["friend", "hint", "gift"].includes(x.slug) && !seen.has(x.slug) && seen.add(x.slug));
    store.getCatalog().settings.sources = list; store.setCatalog(store.getCatalog());
    return { sources: sourcesReport() };
  }, { admin: true });
  on("GET", "/api/admin/qr", ({ query }) => {
    const slug = String(query.get("slug") || "");
    const text = slug ? botLink("s_" + slug) : String(query.get("text") || "");
    if (!text || text.length > 500) throw httpError(400, "Нечего кодировать: бот ещё не подключён");
    const q = qrcode(0, "M"); q.addData(text); q.make();
    return { __raw: { type: "image/svg+xml; charset=utf-8", body: q.createSvgTag({ cellSize: 8, margin: 4, scalable: true }) } };
  }, { admin: true });

  const recipients = (segment) => listCustomers(segment).filter((r) => r.consent);
  on("GET", "/api/admin/broadcast/preview", ({ query }) => ({ count: recipients(query.get("segment") || "all").length }), { admin: true });
  on("GET", "/api/admin/broadcasts", () => ({ list: store.getBroadcasts().list.slice(0, 20) }), { admin: true });
  on("POST", "/api/admin/broadcast", ({ body }) => {
    if (!LY.on(loyal(), "broadcasts")) throw httpError(400, "Рассылки выключены в настройках");
    const text = String(body.text || "").trim().slice(0, 3000);
    if (text.length < 3) throw httpError(400, "Напишите текст рассылки");
    if (!bot) throw httpError(400, "Бот не подключён");
    const segment = LY.SEGMENTS[body.segment] ? body.segment : "all";
    const list = recipients(segment);
    const rec = { id: Date.now().toString(36), at: new Date().toISOString(), segment, text, total: list.length, sent: 0, failed: 0, done: false };
    store.getBroadcasts().list.unshift(rec); store.getBroadcasts().list.length = Math.min(store.getBroadcasts().list.length, 100); store.saveBroadcasts();
    const esc = (t) => t.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
    (async () => {
      for (const r of list) {
        (await sendUser(r.id, esc(text), body.button === false ? false : true)) ? rec.sent++ : rec.failed++;
        await new Promise((res) => setTimeout(res, 40)); // stay far below the API rate limit
      }
      rec.done = true; store.saveBroadcasts();
    })();
    return { id: rec.id, count: list.length };
  }, { admin: true });
  on("PUT", "/api/admin/item/:coll/:id", ({ params, body }) => {
    const list = findColl(params.coll);
    const item = list.find((x) => String(x.id) === params.id);
    if (!item) throw httpError(404, "Не найдено");
    Object.assign(item, pick(body, params.coll === "products" ? PRODUCT_FIELDS : OTHER_FIELDS[params.coll]));
    if (params.coll === "products" && !item.title) throw httpError(400, "У товара должно быть название");
    store.setCatalog(store.getCatalog());
    return item;
  }, { admin: true });
  on("POST", "/api/admin/item/:coll", ({ params, body }) => {
    const list = findColl(params.coll);
    if (params.coll === "addons") throw httpError(400, "Допы добавляются через настройки");
    const fields = pick(body, params.coll === "products" ? PRODUCT_FIELDS : OTHER_FIELDS[params.coll]);
    if (!fields.title) throw httpError(400, "Укажите название");
    const id = params.coll === "products" ? "m" + Date.now().toString(36) : "c" + Date.now().toString(36);
    const base = params.coll === "products" ? { short: "", intro: "", details: [], images: [], cats: [], price: 0, oldPrice: null, chocolateChoices: 0 } : {};
    const item = Object.assign(base, fields, { id, hidden: !!fields.hidden, sort: Math.max(0, ...list.map((x) => x.sort || 0)) + 1 });
    list.push(item);
    store.setCatalog(store.getCatalog());
    return item;
  }, { admin: true });
  on("DELETE", "/api/admin/item/:coll/:id", ({ params }) => {
    const list = findColl(params.coll);
    if (params.coll !== "products") throw httpError(400, "Категории и допы можно только скрыть");
    const i = list.findIndex((x) => String(x.id) === params.id);
    if (i < 0) throw httpError(404, "Не найдено");
    list.splice(i, 1);
    store.setCatalog(store.getCatalog());
    return { ok: true };
  }, { admin: true });
  on("POST", "/api/admin/move/:coll/:id", ({ params, body }) => {
    const list = findColl(params.coll).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const i = list.findIndex((x) => String(x.id) === params.id);
    const j = i + (body.dir > 0 ? 1 : -1);
    if (i < 0) throw httpError(404, "Не найдено");
    if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; list.forEach((x, k) => (x.sort = k)); store.setCatalog(store.getCatalog()); }
    return { ok: true };
  }, { admin: true });
  on("PUT", "/api/admin/promos", ({ body }) => {
    const promos = (Array.isArray(body.promos) ? body.promos : []).slice(0, 50).map((p) => ({
      code: String(p.code || "").trim().slice(0, 40), percent: Math.max(1, Math.min(90, Math.round(Number(p.percent) || 0))), active: p.active !== false, firstOrderOnly: !!p.firstOrderOnly,
    })).filter((p) => p.code);
    store.getCatalog().promos = promos; store.setCatalog(store.getCatalog());
    return { ok: true };
  }, { admin: true });
  on("PUT", "/api/admin/settings", ({ body }) => {
    const s = store.getCatalog().settings;
    const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
    const arr = (v) => (Array.isArray(v) ? v : []).map((x) => str(x, 600)).filter(Boolean).slice(0, 20);
    if (body.banner) s.banner = { title: str(body.banner.title, 120), text: str(body.banner.text, 200), image: okImage(body.banner.image || "") ? str(body.banner.image, 500) : s.banner.image };
    for (const k of ["phone", "address", "hours", "successText"]) if (k in body) s[k] = str(body[k], 500);
    if ("about" in body) s.about = arr(body.about);
    if ("delivery" in body) s.delivery = arr(body.delivery);
    if ("timeSlots" in body) { const t = arr(body.timeSlots).filter((x) => /^\d{1,2}:\d{2}$/.test(x)); if (t.length) s.timeSlots = t; }
    if ("managerChatIds" in body) s.managerChatIds = arr(body.managerChatIds).filter((x) => /^-?\d{3,20}$/.test(x));
    const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    if (body.loyalty && typeof body.loyalty === "object") {
      const cur = LY.loyaltyOf(s), b = body.loyalty;
      const next = Object.assign({}, cur);
      if (b.features) for (const k of Object.keys(cur.features)) if (k in b.features) next.features[k] = !!b.features[k];
      if ("maxPayPercent" in b) next.maxPayPercent = num(b.maxPayPercent, 0, 100, cur.maxPayPercent);
      if ("burnDays" in b) next.burnDays = num(b.burnDays, 7, 3650, cur.burnDays);
      if ("burnRemindDays" in b) next.burnRemindDays = num(b.burnRemindDays, 1, 30, cur.burnRemindDays);
      if ("datesRemindDays" in b) next.datesRemindDays = num(b.datesRemindDays, 1, 14, cur.datesRemindDays);
      if ("welcomeBonus" in b) next.welcomeBonus = num(b.welcomeBonus, 0, 10000, cur.welcomeBonus);
      if ("giftBonus" in b) next.giftBonus = num(b.giftBonus, 0, 10000, cur.giftBonus);
      if (b.referral) next.referral = { friendBonus: num(b.referral.friendBonus, 0, 10000, cur.referral.friendBonus), referrerBonus: num(b.referral.referrerBonus, 0, 10000, cur.referral.referrerBonus) };
      if (Array.isArray(b.levels)) {
        const lv = b.levels.slice(0, 5).map((x) => ({ name: str(x.name, 30), from: num(x.from, 0, 1e7, 0), percent: num(x.percent, 0, 50, 0) })).filter((x) => x.name);
        if (lv.length) { lv.sort((a, z) => a.from - z.from); lv[0].from = 0; next.levels = lv; }
      }
      s.loyalty = next;
    }
    if (Array.isArray(body.zones)) {
      const seen = new Set();
      s.zones = body.zones.slice(0, 30).map((z) => {
        z = z || {};
        let from = num(z.from, 0, 1440, 0), to = num(z.to, 0, 1440, 0);
        if (to && from > to) [from, to] = [to, from];
        let id = str(z.id, 20);
        if (!/^z[a-z0-9]{1,18}$/.test(id) || seen.has(id)) id = "z" + crypto.randomBytes(4).toString("hex");
        seen.add(id);
        return { id, name: str(z.name, 60), price: num(z.price, 0, 100000, 0), freeFrom: num(z.freeFrom, 0, 1e6, 0), from, to, hidden: !!z.hidden };
      }).filter((z) => z.name);
    }
    if (body.transfer && typeof body.transfer === "object") {
      const b = body.transfer, cur = transferSettings();
      const card = str(b.card, 40).replace(/\D/g, "");
      if (card && (card.length < 16 || card.length > 19)) throw httpError(400, "Номер карты: 16–19 цифр");
      const phone = str(b.phone, 30);
      if (phone && !/^\d{10,12}$/.test(phone.replace(/\D/g, ""))) throw httpError(400, "Телефон для СБП: проверьте номер, например +7 900 000-00-00");
      const next = { enabled: !!b.enabled, mode: b.mode === "after" ? "after" : "now", card: card.replace(/(\d{4})(?=\d)/g, "$1 "), phone, bank: str(b.bank, 40), holder: str(b.holder, 60), note: str(b.note, 200) };
      if (next.enabled && !next.card && !next.phone) throw httpError(400, "Укажите номер карты или телефон для СБП — иначе клиенту некуда платить");
      s.transfer = Object.assign(cur, next);
    }
    if (body.payments && typeof body.payments === "object") {
      const cur = Object.assign({ enabled: false, provider: "demo" }, s.payments || {});
      if ("enabled" in body.payments) cur.enabled = !!body.payments.enabled;
      if (["demo", "yookassa"].includes(body.payments.provider)) cur.provider = body.payments.provider;
      s.payments = cur;
    }
    store.setCatalog(store.getCatalog());
    return { ok: true };
  }, { admin: true });
  on("GET", "/api/admin/stats", () => report(store.getStats(), store.getCatalog()), { admin: true });
  on("POST", "/api/admin/import", async () => {
    const c = store.getCatalog();
    const products = await (opts.fetchStore || fetchStore)(c.settings.tildaParts || {});
    if (!products.length) throw httpError(502, "Сайт вернул пустой каталог — ничего не меняем.");
    const r = mergeProducts(c, products);
    store.setCatalog(c);
    return r;
  }, { admin: true });
  on("POST", "/api/admin/test-notify", async ({ user }) => {
    if (!bot) throw httpError(400, "Бот не подключён: укажите BOT_TOKEN в настройках сервера.");
    const sent = await notify(`${E()} <b>Тестовая заявка</b>\nЕсли вы видите это сообщение, заявки из мини-аппа будут приходить сюда.\nОтправил: ${user.first_name || user.id}`);
    if (!sent.length) throw httpError(400, "Не удалось отправить. Напишите боту /start с нужного аккаунта и проверьте ID в настройках.");
    return { ok: true, sent };
  }, { admin: true });

  /* ---------- server ---------- */
  function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
  function send(res, status, data, headers) {
    res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, headers || {}));
    res.end(JSON.stringify(data));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > 200e3) { reject(httpError(413, "Слишком большой запрос")); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}); } catch (e) { reject(httpError(400, "Неверный формат данных")); } });
      req.on("error", reject);
    });
  }
  const MAX_UPLOAD = 4e6; // the app shrinks photos to ~300 KB before sending; this is a hard ceiling
  function readRaw(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > limit) { reject(httpError(413, "Фото слишком большое")); req.destroy(); } else chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }
  function serveUpload(req, res, name) {
    const file = path.join(uploadsDir, name);
    if (!UPLOAD_RE.test(name) || !fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Не найдено"); }
    const type = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[name.split(".").pop()];
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Не найдено"); }
    const ext = path.extname(file);
    const long = ext === ".woff2";
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": long ? "public, max-age=31536000, immutable" : "no-cache", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(file).pipe(res);
  }

  // When no WEBAPP_URL is configured, learn the public https address from the first real request
  // (e.g. https://sweetroses-xxx.amvera.io) and point the bot's buttons at it.
  const HOST_SUFFIXES = (process.env.PUBLIC_HOST_SUFFIXES || ".amvera.io,.amvera.app,.amvera.tech").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  function detectPublicUrl(req) {
    if (process.env.WEBAPP_URL || !bot || !bot.setWebAppUrl) return;
    const s = store.getCatalog().settings;
    if (s.webAppUrl) { bot.setWebAppUrl(s.webAppUrl); return; } // learned once, never overwritten by request headers
    const host = String(req.headers.host || "").trim().toLowerCase().replace(/:\d+$/, "");
    if (!/^[a-z0-9.-]+$/.test(host) || !HOST_SUFFIXES.some((suf) => host.endsWith(suf))) return;
    s.webAppUrl = "https://" + host;
    store.setCatalog(store.getCatalog());
    if (log.log) log.log("Адрес мини-аппа: " + s.webAppUrl);
    bot.setWebAppUrl(s.webAppUrl);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    detectPublicUrl(req);
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
      if (url.pathname.startsWith("/u/")) return serveUpload(req, res, url.pathname.slice(3));
      return serveStatic(req, res, url.pathname);
    }
    try {
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) throw httpError(404, "Нет такого адреса");
      const m = route.re.exec(url.pathname);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const user = userFrom(req);
      if (route.admin && !isAdmin(user)) throw httpError(403, "Нет доступа к управлению");
      const body = req.method === "GET" ? {} : route.raw ? await readRaw(req, MAX_UPLOAD) : await readBody(req);
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const data = await route.handler({ params, body, user, ip, query: url.searchParams });
      if (data && data.__raw) { res.writeHead(200, { "Content-Type": data.__raw.type, "Cache-Control": "no-store" }); return res.end(data.__raw.body); }
      send(res, 200, data);
    } catch (e) {
      if (!e.status) log.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : "Ошибка на сервере. Попробуйте ещё раз через минуту." });
    }
  });

  const greeting = () => store.getCatalog().settings.botGreeting || "";

  /* ---------- background jobs: burning bonuses, important dates, unpaid orders ---------- */
  async function runJobs(now = new Date()) {
    const L = loyal(), db = custDb();
    const today = LY.todayLocal(now), hour = LY.hourLocal(now);
    let changed = false;
    for (const c of Object.values(db.list)) {
      if (LY.expireLots(c, now)) changed = true;
      c.sent = c.sent || {};
      if (LY.on(L, "bonuses") && LY.on(L, "burn")) {
        const b = LY.burningSoon(c, now, L.burnRemindDays);
        const fresh = b ? b.lots.filter((l) => !c.sent["burn:" + l.id]) : [];
        if (fresh.length) {
          fresh.forEach((l) => (c.sent["burn:" + l.id] = today)); changed = true;
          await sendUser(c.id, `⏳ ${b.amount} бонусов сгорят ${ruDate(b.date)}.\nУспейте потратить: бонусами можно оплатить до ${L.maxPayPercent}% заказа.`, true);
        }
      }
      if (LY.on(L, "dates") && hour >= 10 && hour < 21) {
        for (const d of LY.dueDates(c, today, L.datesRemindDays)) {
          const key = "date:" + d.id + ":" + today;
          if (c.sent[key]) continue;
          c.sent[key] = 1; changed = true;
          const [mm, dd] = d.md.split("-");
          const n = d.remindDays || L.datesRemindDays;
          await sendUser(c.id, `🎂 Через ${n} ${n === 1 ? "день" : n < 5 ? "дня" : "дней"} — «${d.title}» (${dd}.${mm}).\nПодберём подарок заранее? Закажите сейчас — приготовим к нужному дню.`, "Выбрать подарок");
        }
      }
      // keep the sent-marks small
      for (const k of Object.keys(c.sent)) if (k.startsWith("date:") && k.slice(-10) < LY.todayLocal(new Date(now.getTime() - 400 * 864e5))) delete c.sent[k];
    }
    let ordersChanged = false;
    for (const o of store.getOrders().list) {
      if (o.status === "pay" && !o.paid && now - new Date(o.createdAt) > 60 * 60e3) {
        o.status = "cancel"; o.cancelReason = "Не оплачен за 60 минут"; ordersChanged = true;
        const c = o.tgUser && db.list[String(o.tgUser.id)];
        if (c && o.bonusUsed && !o.bonusRefunded) { LY.addBonus(c, o.bonusUsed, "refund", { now, days: L.burnDays, orderId: o.id, note: `Возврат за неоплаченный заказ №${o.id}` }); o.bonusRefunded = true; changed = true; }
        if (o.tgUser) await sendUser(o.tgUser.id, `Заказ №${o.id} отменён: оплата не поступила за час. Если подарок ещё нужен — оформите заказ заново.`, true);
      }
    }
    if (ordersChanged) store.saveOrders();
    if (changed) store.saveCustomers();
  }

  return { server, store, bot, config, isAdmin, claimOwner, onBotStart, greeting, customers, runJobs };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, () => {
    console.log(`Sweet Roses mini app: http://localhost:${port}`);
    if (!app.config.botToken) console.log((app.config.messenger === "max" ? "MAX_BOT_TOKEN" : "BOT_TOKEN") + " не задан — бот выключен, заявки сохраняются только в админке.");
    else console.log("Мессенджер: " + PLATFORM_NAME[app.config.messenger]);
    if (process.env.WEBAPP_URL) console.log("Адрес мини-аппа: " + process.env.WEBAPP_URL);
  });
  // A light seed may ship without products: then the catalog is loaded from the Sweet Roses site on first start.
  (async function ensureProducts() {
    const c = app.store.getCatalog();
    if (c.products.length || !c.settings.tildaParts) return;
    try {
      const products = await fetchStore(c.settings.tildaParts || {});
      if (!products.length) throw new Error("пустой ответ");
      const r = mergeProducts(c, products); app.store.setCatalog(c);
      console.log(`Каталог загружен с сайта: ${r.added} товаров`);
    } catch (e) { console.error("Не удалось загрузить каталог с сайта (" + e.message + "), повтор через минуту"); setTimeout(ensureProducts, 60e3); }
  })();
  if (app.bot) app.bot.startPolling({ isAdmin: (id) => app.isAdmin({ id }), onStart: (from, payload) => app.onBotStart(from, payload), greeting: app.greeting });
  setInterval(() => app.runJobs().catch((e) => console.error("Фоновые задачи: " + e.message)), 5 * 60e3).unref();
  setTimeout(() => app.runJobs().catch(() => {}), 20e3).unref();
  const shutdown = () => { app.store.flush(); if (app.bot) app.bot.stop(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

module.exports = { createApp };
