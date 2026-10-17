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
const { importCatalog } = require("./importer");
const BK = require("./backup");
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
  /* MESSENGER=telegram | max | telegram,max (16.10.2026: one shop in BOTH messengers — one catalog, one base, one set of orders).
     The first one is the main one: old data (customers, owners, ADMIN_IDS) without a messenger mark belongs to it.
     Tokens: BOT_TOKEN — Telegram, MAX_BOT_TOKEN — MAX. */
  const list = (opts.messengers || String(opts.messenger ?? process.env.MESSENGER ?? (process.env.MAX_BOT_TOKEN ? "max" : "telegram")).split(/[,+\s]+/))
    .map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const platforms = [...new Set(list)];
  if (!platforms.length || platforms.some((x) => !messengers[x])) throw new Error("MESSENGER должен быть telegram, max или telegram,max");
  const messenger = platforms[0];
  const M = messengers[messenger];
  const tokenOf = (pf) => (opts.botTokens && opts.botTokens[pf] != null ? opts.botTokens[pf] : pf === messenger && opts.botToken != null ? opts.botToken : (pf === "max" ? process.env.MAX_BOT_TOKEN : process.env.BOT_TOKEN)) || "";
  const config = {
    messenger, platforms,
    botToken: tokenOf(messenger),
    botTokens: Object.fromEntries(platforms.map((pf) => [pf, tokenOf(pf)])),
    // «123» — the main messenger, «max:123» / «telegram:123» — a person in the other one
    adminIds: (opts.adminIds ?? process.env.ADMIN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    managerChatId: opts.managerChatId ?? process.env.MANAGER_CHAT_ID ?? "",
    // Amvera (and similar hosts) mount persistent storage at /data
    dataDir: opts.dataDir ?? process.env.DATA_DIR ?? (fs.existsSync("/data") ? "/data" : path.join(__dirname, "..", "data")),
    devMode: opts.devMode ?? process.env.DEV_MODE === "1",
    publicDir: path.join(__dirname, "..", "public"),
    // SEED=gagulya starts a new shop from seed/gagulya.seed.json (only used on the very first start, when /data is empty)
    seedFile: opts.seedFile ?? path.join(__dirname, "..", "seed", (/^[a-z0-9-]{1,40}$/.test(process.env.SEED || "") ? process.env.SEED : "catalog") + ".seed.json"),
  };
  // restore*.zip put into /data (Amvera → «Data») is unpacked before the data is read — see backup.js
  const restored = opts.noRestore ? [] : BK.restoreOnStart(config.dataDir, opts.log || console);
  const store = createStore(config.dataDir, config.seedFile);
  // <name>.import.json next to the seed adds the real catalog once to a shop that is already running (see importer.js)
  importCatalog(store, config.dataDir, opts.importFile !== undefined ? opts.importFile : opts.seedFile ? null : config.seedFile.replace(/\.seed\.json$/, ".import.json"), opts.log || console);
  const bots = {};
  for (const pf of platforms) {
    if (opts.bots && pf in opts.bots) bots[pf] = opts.bots[pf];
    else if (pf === messenger && opts.bot !== undefined) bots[pf] = opts.bot;
    else bots[pf] = config.botTokens[pf] ? messengers[pf].createBot({ token: config.botTokens[pf], webAppUrl: process.env.WEBAPP_URL || store.getCatalog().settings.webAppUrl || "" }) : null;
  }
  const bot = bots[messenger]; // the main bot
  const botFor = (pf) => bots[pf || messenger] || null;
  const anyBot = () => platforms.some((pf) => bots[pf]);
  const PF_NAMES = platforms.map((pf) => PLATFORM_NAME[pf]).join(" или ");
  const log = opts.log || console;
  const orderTimes = new Map(); // rate limit per user/ip

  /* ---------- loyalty, customers, payments ---------- */
  const loyal = () => LY.loyaltyOf(store.getCatalog().settings);
  const paySettings = () => Object.assign({ enabled: false, provider: "demo" }, store.getCatalog().settings.payments || {});
  // ONLINE_PAYMENTS=off (Amvera → «Переменные») — the shop's tariff has no online payment (e.g. Бизнес, Gagulya):
  // no card payment, no «Демо»/«ЮKassa» in the admin; payment by transfer to the shop's card still works.
  const onlinePayAllowed = opts.onlinePayments !== undefined ? !!opts.onlinePayments : !/^(off|0|no|false)$/i.test(String(process.env.ONLINE_PAYMENTS || ""));
  const paymentsOn = () => onlinePayAllowed && paySettings().enabled && LY.on(loyal(), "payments");
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
    touch(user, startParam = "", now = new Date()) {
      const c = LY.touchCustomer(custDb(), user, { now, settings: loyal(), startParam, giftExists: (g) => !!findGift(g) });
      if (user && user.platform && user.platform !== messenger) c.platform = user.platform; else if (user && user.platform && c.platform) delete c.platform;
      store.saveCustomers(); return c;
    },
    get: (id) => custDb().list[String(id)] || null,
    addBonus(c, amount, kind, o = {}) { const lot = LY.addBonus(c, amount, kind, Object.assign({ days: loyal().burnDays }, o)); store.saveCustomers(); return lot; },
  };
  const findGift = (gid) => store.getOrders().list.find((o) => o.gift && o.gift.id === gid && o.status !== "cancel") || null;
  /**
   * Shareable link. In MAX it opens the bot CHAT (?start=) — so the shop stays in the person's chat list;
   * the bot then answers with an «Открыть» button that launches the app with the same parameters.
   * (?startapp= would open the app directly, but the chat would not appear.)
   */
  const username = (pf) => { const b = botFor(pf); return (b && b.getUsername && b.getUsername()) || ""; };
  function botLink(param, pf = messenger) {
    const u = username(pf);
    if (!u) return "";
    return pf === "max" ? `https://max.ru/${u}?start=${param}` : `https://t.me/${u}?startapp=${param}`;
  }
  /** The same link for every connected messenger: { telegram: …, max: … } */
  const linksFor = (fn, param) => Object.fromEntries(platforms.map((pf) => [pf, fn(param, pf)]).filter(([, l]) => l));
  /** Opens the mini app directly (used where the person is already in the chat, e.g. return after payment). */
  function appDirectLink(param, pf = messenger) {
    const u = username(pf);
    if (!u) return "";
    return pf === "max" ? `https://max.ru/${u}?startapp=${param}` : `https://t.me/${u}?startapp=${param}`;
  }
  /** In which messenger a customer lives (old records — the main one). */
  const platformOf = (id) => { const c = custDb().list[String(id)]; return (c && c.platform) || messenger; };
  /** Sends to a person through the bot of his messenger; withButton adds the "open the shop" button. */
  async function sendUser(id, text, withButton, pf) {
    pf = pf || platformOf(id);
    const b = botFor(pf);
    if (!b || !id) return false;
    let extra = {};
    if (withButton && b.openButton) {
      // withButton: true | "button text" | { text, payload } — the payload opens a page of the app (e.g. rv_1 → the review form)
      const o = typeof withButton === "object" ? withButton : { text: withButton === true ? "Открыть магазин" : withButton };
      const btn = b.openButton(o.text, o.payload || "");
      if (btn) extra = pf === "max" ? { buttons: btn } : { reply_markup: btn };
    }
    try { await b.sendMessage(id, text, extra); return true; } catch (e) { log.error("Send " + id + ": " + e.message); return false; }
  }
  const ruDate = (d) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Irkutsk", day: "2-digit", month: "2-digit" }).format(new Date(d));

  function userFrom(req) {
    const init = req.headers["x-init-data"] || "";
    const hint = String(req.headers["x-platform"] || "");
    // the messenger the app says it is in goes first; the signature decides (each bot has its own token)
    for (const pf of [...platforms].sort((a, b) => (b === hint) - (a === hint))) {
      const MM = messengers[pf];
      const u = init && config.botTokens[pf] ? MM.validateInitData(init, config.botTokens[pf]) : null;
      if (!u) continue;
      let startParam = "";
      try { startParam = new URLSearchParams(MM.extractWebAppData ? MM.extractWebAppData(init) : init).get("start_param") || ""; } catch (e) { /* none */ }
      // opened by the bot's button: Telegram buttons don't pass start_param, the app sends it from its own address (?start=…)
      if (!startParam) { const h = String(req.headers["x-start-param"] || ""); if (/^[A-Za-z0-9_-]{1,64}$/.test(h)) startParam = h; }
      return Object.assign(u, { platform: pf, startParam });
    }
    if (config.devMode) { const a = parseKey(config.adminIds[0] || "1"); return { id: Number(a.id), first_name: "Dev", platform: a.platform }; }
    return null;
  }
  /* People with access are «messenger:id» — a Telegram id and a MAX id are different people even if the numbers match.
     «123» without a mark (ADMIN_IDS, old ownerIds, old staff) is in the main messenger. */
  function parseKey(v) { const m = /^(telegram|max):(-?\d+)$/.exec(String(v).trim()); return m ? { platform: m[1], id: m[2] } : { platform: messenger, id: String(v).trim() }; }
  const keyOf = (pf, id) => (pf || messenger) + ":" + String(id);
  // Admins: ADMIN_IDS from .env plus the "owner" — the first person who sends /start when nobody is admin yet.
  const ownerEntries = () => [...config.adminIds.map(parseKey), ...((store.getCatalog().settings.ownerIds) || []).map(parseKey),
    ...(store.getCatalog().settings.staff || []).filter((x) => x.role === "owner").map((x) => ({ platform: x.platform || messenger, id: String(x.id) }))];
  const ownerList = () => ownerEntries().map((e) => e.id);
  /* Staff: managers invited by the owner with a one-time link (settings.staff). They see orders, customers and the catalog;
     settings, payment details and the staff list stay with the owner. */
  const staffList = () => (store.getCatalog().settings.staff || []);
  const adminKeys = () => new Set([...ownerEntries().map((e) => keyOf(e.platform, e.id)), ...staffList().map((x) => keyOf(x.platform, x.id))]);
  const adminList = () => [...adminKeys()];
  const isAdmin = (u) => !!u && adminKeys().has(keyOf(u.platform, u.id));
  const isOwner = (u) => !!u && ownerEntries().some((e) => keyOf(e.platform, e.id) === keyOf(u.platform, u.id));
  /** A link that opens the bot CHAT with /start <param> (the bot itself must see the invite). */
  function chatLink(param, pf = messenger) {
    const u = username(pf);
    if (!u) return "";
    return pf === "max" ? `https://max.ru/${u}?start=${param}` : `https://t.me/${u}?start=${param}`;
  }
  function acceptInvite(from, code, pf = messenger) {
    const S = store.getCatalog().settings;
    const now = Date.now();
    S.invites = (S.invites || []).filter((x) => new Date(x.expiresAt).getTime() > now);
    const inv = S.invites.find((x) => x.code === code);
    if (!inv) { store.setCatalog(store.getCatalog()); return "\n\n⚠️ Ссылка-приглашение уже использована или устарела. Попросите владельца прислать новую."; }
    S.invites = S.invites.filter((x) => x !== inv);
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || (from.username ? "@" + from.username : "Сотрудник");
    if (!isAdmin(Object.assign({}, from, { platform: pf }))) {
      S.staff = staffList().concat([Object.assign({ id: Number(from.id), name, username: from.username || "", role: inv.role === "owner" ? "owner" : "manager", notify: true, addedAt: new Date().toISOString() }, pf !== messenger ? { platform: pf } : {})]);
    }
    store.setCatalog(store.getCatalog());
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const own = inv.role === "owner";
    for (const o of ownerEntries()) if (keyOf(o.platform, o.id) !== keyOf(pf, from.id)) sendUser(o.id, `👤 <b>${esc(name)}</b> принял(а) приглашение${platforms.length > 1 ? ` (${PLATFORM_NAME[pf]})` : ""} и теперь ${own ? "владелец (полный доступ)" : "менеджер: видит заявки и получает их в чат"}.`, false, o.platform).catch(() => {});
    return own
      ? `\n\n✅ <b>Вы добавлены как владелец ${esc(S.brand || "")}.</b> Заявки будут приходить в этот чат, а в приложении появилась шестерёнка — там всё управление: заявки, товары, оплата, настройки, сотрудники.`
      : `\n\n✅ <b>Вы добавлены в сотрудники ${esc(S.brand || "")}.</b> Заявки будут приходить в этот чат, а в приложении появилась шестерёнка — там заявки, клиенты и товары.`;
  }
  function claimOwner(from, pf = messenger) {
    if (!from || !from.id || adminList().length) return "";
    store.getCatalog().settings.ownerIds = [pf === messenger ? Number(from.id) : keyOf(pf, from.id)];
    store.setCatalog(store.getCatalog());
    return "\n\n👑 <b>Вы назначены администратором.</b> В приложении у вас появилась шестерёнка — панель управления. Заявки будут приходить в этот чат.";
  }
  /** «Начать» in the bot chat: remember the customer (with the link's ref/source), mark the chat as saved. */
  function onBotStart(from, payload = "", pf = messenger) {
    if (from && from.id && /^staff_[a-f0-9]{12}$/.test(payload)) return { text: acceptInvite(from, payload.slice(6), pf), appPayload: "" };
    const owner = claimOwner(from, pf);
    if (!from || !from.id) return owner;
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
    const c = customers.touch({ id: from.id, first_name: name || from.first_name, username: from.username, platform: pf }, payload);
    c.botStarted = true; store.saveCustomers();
    const st = LY.parseStart(payload);
    const product = (st.product || st.hint) && store.getCatalog().products.find((p) => String(p.id) === String(st.product || st.hint) && !p.hidden);
    const res = { text: owner, appPayload: payload === "save" ? "" : payload };
    if (st.gift && findGift(st.gift)) Object.assign(res, { greeting: "🎁 Вам открытка с подарком! Нажмите кнопку, чтобы её открыть.", button: "Открыть открытку" });
    else if (product && st.hint) Object.assign(res, { greeting: `💝 Вам намекают на подарок: «${product.title}». Нажмите кнопку, чтобы посмотреть.`, button: "Посмотреть подарок" });
    else if (product) Object.assign(res, { greeting: `Вам прислали «${product.title}». Нажмите кнопку, чтобы посмотреть.`, button: "Посмотреть" });
    else if (st.review) {
      const L = loyal(), b = LY.on(L, "reviews") && LY.on(L, "bonuses") ? L.reviewBonus : 0;
      Object.assign(res, { greeting: `Здравствуйте! 💐 Спасибо, что выбрали ${store.getCatalog().settings.brand || "нас"}.\n\nРасскажите, как вам букет — это займёт минуту${b ? `, а мы подарим <b>${b} бонусов</b> на следующий заказ` : ""}. Нажмите кнопку ниже 👇`, button: "⭐ Оставить отзыв" });
    }
    else if (payload === "save") Object.assign(res, { greeting: "✅ Готово — магазин сохранён у вас в чатах. Здесь будут статусы заказов и бонусы. Нажмите кнопку, чтобы вернуться в магазин.", button: "Открыть магазин" });
    return res;
  }

  function publicCatalog() {
    const c = store.getCatalog();
    const cats = c.categories.filter((x) => !x.hidden);
    const settings = Object.assign({}, c.settings);
    delete settings.managerChatIds; delete settings.tildaParts; delete settings.ownerIds; delete settings.webAppUrl; delete settings.staff; delete settings.invites;
    const L = loyal();
    delete settings.loyalty; delete settings.payments; delete settings.sources; delete settings.transfer;
    return {
      platform: messenger, platforms,
      loyalty: { features: L.features, maxPayPercent: L.maxPayPercent, levels: L.levels, referral: L.referral, burnDays: L.burnDays, welcomeBonus: L.welcomeBonus, giftBonus: L.giftBonus },
      reviews: LY.on(L, "reviews") ? Object.assign(reviewsSummary(), { bonus: LY.on(L, "bonuses") ? L.reviewBonus : 0 }) : null,
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

  /** Managers' chats, each through the bot of its messenger. Returns [{ id, platform }] that got the message. */
  async function notify(text) {
    const c = store.getCatalog();
    const to = new Map();
    const add = (pf, id) => { if (id) to.set(keyOf(pf, id), { platform: pf || messenger, id: String(id) }); };
    for (const x of [...(c.settings.managerChatIds || []), config.managerChatId].filter(Boolean)) { const k = parseKey(x); add(k.platform, k.id); }
    if (!to.size && ownerEntries()[0]) add(ownerEntries()[0].platform, ownerEntries()[0].id);
    for (const x of staffList()) if (x.notify !== false) add(x.platform || messenger, x.id);
    const results = [];
    for (const r of to.values()) {
      const b = botFor(r.platform);
      if (!b) continue;
      try { await b.sendMessage(r.id, text); results.push(r); } catch (e) { log.error("Notify " + r.id + ": " + e.message); }
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
    const sent = await notify(managerMessage(o, o.platform || messenger, E()));
    if (o.photosSent || !sent.length) return sent;
    const urls = [...new Set(o.totals.lines.map((l) => absUrl(l.image || "")).filter(Boolean))].slice(0, 6);
    if (!urls.length) return sent;
    o.photosSent = true; store.saveOrders();
    const titles = o.totals.lines.filter((l) => l.image).map((l) => l.title + (l.qty > 1 ? " × " + l.qty : "")).join(", ");
    for (const r of sent) {
      const b = botFor(r.platform);
      if (!b || !b.sendPhotos) continue;
      try { await b.sendPhotos(r.id, urls, `Фото к заявке №${o.id}: ${titles}`.slice(0, 1000)); } catch (e) { log.error("Фото в заявку " + r.id + ": " + e.message); }
    }
    return sent;
  }

  const routes = [];
  const on = (method, pattern, handler, { admin = false, owner = false, raw = false } = {}) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, handler, admin: admin || owner, owner, raw });
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
      if (st.review) start.review = true;
    }
    return { isAdmin: isAdmin(user), isOwner: isOwner(user), platform: user ? user.platform : messenger, startParam: user ? user.startParam || "" : "", start, user: user ? { id: user.id, first_name: user.first_name } : null };
  });

  /* ---------- profile ---------- */
  const needUser = (user) => { if (!user) throw httpError(401, `Откройте магазин через бота в ${PF_NAMES}.`); };
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
      refLink: LY.on(L, "referral") ? botLink("ref_" + c.refCode, user.platform) : "",
      refCode: c.refCode, linkBase: botLink("", user.platform),
      // MAX: opening the app by a link doesn't add the bot chat — nudge to press «Начать» once
      botStarted: user.platform !== "max" || !!c.botStarted,
      chatLink: user.platform === "max" ? botLink("save", "max") : "",
      welcome: c.welcome && !c.welcomeSeen ? c.welcome : null,
      referral: L.referral, referredBy: !!c.referredBy,
      dates: LY.on(L, "dates") ? c.dates : [],
      history: LY.on(L, "bonuses") ? c.history.slice(0, 20) : [],
      orders: myOrders(user.id).slice(-20).reverse().map((o) => ({
        id: o.id, createdAt: o.createdAt, status: o.status, paid: !!o.paid, total: o.totals.total, toPay: o.toPay ?? o.totals.total,
        payMethod: o.payMethod || "", transferPayable: transferPayable(o), transferClaimed: !!o.transferClaimedAt,
        bonusUsed: o.bonusUsed || 0, bonusAccrued: o.bonusAccrued || 0, date: o.date, time: o.time,
        lines: o.totals.lines.map((l) => ({ id: l.id, qty: l.qty, choc: l.choc || [], title: l.title })),
        giftLink: o.gift ? botLink("g_" + o.gift.id, user.platform) : "",
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
    const r = await p.create(order, { amount: order.toPay, returnUrl: appDirectLink("paid_" + order.id, order.platform || messenger) || (store.getCatalog().settings.webAppUrl || ""), description: `${store.getCatalog().settings.brand || "Заказ"} — заказ №${order.id}` });
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
    if (!user && platforms.some((pf) => config.botTokens[pf])) throw httpError(401, `Откройте магазин через бота в ${PF_NAMES}, чтобы отправить заявку.`);
    const key = user ? "u" + user.id : "ip" + ip;
    const recent = (orderTimes.get(key) || []).filter((t) => Date.now() - t < 10 * 60e3);
    if (recent.length >= 5) throw httpError(429, "Слишком много заявок подряд. Позвоните нам: менеджер поможет быстрее.");
    const { order, error } = buildOrder({ catalog: store.getCatalog(), orders: store.getOrders(), body, tgUser: user });
    if (error) throw httpError(400, error);
    const L = loyal();
    const c = user ? customers.touch(user, user.startParam) : null;
    order.bonusUsed = 0;
    if (user && user.platform && user.platform !== messenger) order.platform = user.platform;
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
    const giftLink = order.gift ? botLink("g_" + order.gift.id, user ? user.platform : messenger) : "";
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

  /* ---------- reviews (made 16.10.2026): a card with a QR code goes into every bouquet → «Как вам букет?» ----------
     The customer gets the bonus for any honest review (good or bad) in the app — never for a review on 2GIS.
     4–5 stars wait for the owner's approval, then appear in «Отзывы»; the customer is offered to share the text in 2GIS too.
     1–3 stars are not published: they go straight to the managers' chat, so the shop can fix things first. */
  const RV = () => store.getReviews();
  const REVIEW_SOURCE = { slug: "otzyv", title: "Вкладыш «Оцените букет» (отзывы)" };
  const REVIEW_BONUS_DAYS = 30; // one review bonus per person per 30 days
  const reviewPublic = (r) => ({ id: r.id, name: r.name, rating: r.rating, text: r.text, photos: r.photos, at: r.at, reply: r.reply || "" });
  function reviewsSummary() {
    const pub = RV().list.filter((r) => r.status === "approved");
    const avg = pub.length ? Math.round((pub.reduce((s, r) => s + r.rating, 0) / pub.length) * 10) / 10 : 0;
    return { count: pub.length, avg, latest: pub.slice(0, 3).map(reviewPublic) };
  }
  /** «Оставить отзыв» page of the shop in 2GIS: set by the owner, or made from its 2GIS card link (…/firm/<id>). */
  function reviewLink2gis() {
    const s = store.getCatalog().settings;
    if (s.review2gis) return s.review2gis;
    const m = /^(https:\/\/2gis\.ru\/[a-z-]+\/firm\/\d+)/.exec(s.map2gis || "");
    return m ? m[1] + "/tab/reviews" : "";
  }
  function ensureReviewSource() {
    const S = store.getCatalog().settings;
    S.sources = S.sources || [];
    if (!S.sources.some((x) => x.slug === REVIEW_SOURCE.slug)) { S.sources.push(Object.assign({}, REVIEW_SOURCE)); store.setCatalog(store.getCatalog()); }
  }
  // the bot CHAT (?start=), in Telegram too: it works without a «main mini app» in BotFather and keeps the chat for bonus messages
  const reviewCardLink = (pf = messenger) => chatLink("rv_1-s_" + REVIEW_SOURCE.slug, pf);
  const reviewPhotoCount = new Map(); // user id → { day, n } — customers may add a few photos a day, not fill the disk
  const escH = (t) => String(t).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));

  on("GET", "/api/reviews", () => {
    if (!LY.on(loyal(), "reviews")) return { list: [], count: 0, avg: 0 };
    const pub = RV().list.filter((r) => r.status === "approved");
    return Object.assign(reviewsSummary(), { list: pub.slice(0, 100).map(reviewPublic) });
  });
  on("POST", "/api/reviews/photo", ({ user, body }) => {
    needUser(user);
    if (!Buffer.isBuffer(body) || !body.length) throw httpError(400, "Фото не получено");
    const kind = imageKind(body);
    if (!kind) throw httpError(400, "Это не фото. Подходят JPG, PNG и WebP");
    const day = LY.todayLocal(new Date()), k = String(user.id);
    const cnt = reviewPhotoCount.get(k);
    const n = cnt && cnt.day === day ? cnt.n : 0;
    if (n >= 6) throw httpError(429, "На сегодня фото достаточно — отправьте отзыв так");
    reviewPhotoCount.set(k, { day, n: n + 1 });
    fs.mkdirSync(uploadsDir, { recursive: true });
    const name = crypto.randomBytes(12).toString("hex") + "." + kind;
    fs.writeFileSync(path.join(uploadsDir, name), body);
    return { url: "/u/" + name };
  }, { raw: true });
  on("POST", "/api/reviews", async ({ user, body }) => {
    needUser(user);
    const L = loyal();
    if (!LY.on(L, "reviews")) throw httpError(400, "Отзывы сейчас выключены");
    const rating = Math.round(Number(body.rating));
    if (!(rating >= 1 && rating <= 5)) throw httpError(400, "Поставьте оценку — от 1 до 5 звёзд");
    const text = String(body.text || "").trim().slice(0, 1500);
    if (rating <= 3 && text.length < 3) throw httpError(400, "Расскажите, пожалуйста, что не понравилось — мы обязательно разберёмся");
    const mine = RV().list.filter((r) => String(r.userId) === String(user.id));
    if (mine.some((r) => Date.now() - new Date(r.at) < 60e3)) throw httpError(429, "Отзыв уже отправлен — спасибо!");
    const photos = (Array.isArray(body.photos) ? body.photos : []).map(String).filter((u) => /^\/u\//.test(u) && UPLOAD_RE.test(u.slice(3))).slice(0, 3);
    const c = customers.touch(user, user.startParam);
    if (body.consent) c.consent = true;
    const last = myOrders(user.id).slice(-1)[0];
    const r = {
      id: crypto.randomBytes(5).toString("hex"), userId: String(user.id), name: (c.name || user.first_name || "Покупатель").split(" ")[0].slice(0, 40),
      username: user.username || c.username || "", phone: (last && last.phone) || c.phone || "", rating, text, photos, at: new Date().toISOString(),
      status: rating >= 4 ? "pending" : "private", orderId: last ? last.id : null,
    };
    // the bonus: for any review, at most once in 30 days
    let bonus = 0;
    const lastBonus = mine.filter((x) => x.bonus).sort((a, b) => b.at.localeCompare(a.at))[0];
    if (LY.on(L, "bonuses") && L.reviewBonus > 0 && (!lastBonus || Date.now() - new Date(lastBonus.at) > REVIEW_BONUS_DAYS * 864e5)) {
      customers.addBonus(c, L.reviewBonus, "review", { note: "Спасибо за отзыв" });
      bonus = r.bonus = L.reviewBonus;
    }
    store.saveCustomers();
    RV().list.unshift(r); if (RV().list.length > 2000) RV().list.length = 2000; store.saveReviews();
    const who = [escH(r.name), r.username ? "@" + escH(r.username) : "", r.phone ? escH(r.phone) : ""].filter(Boolean).join(" · ");
    const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
    notify(rating <= 3
      ? `⚠️ <b>Клиент недоволен</b> — ${stars}\n${who}${r.orderId ? `\nЗаказ №${r.orderId}` : ""}\n\n«${escH(text)}»\n\nСвяжитесь с ним, пока он не написал об этом в 2ГИС. Отзыв не опубликован.`
      : `⭐ <b>Новый отзыв</b> — ${stars}\n${who}\n\n${text ? "«" + escH(text) + "»" : "(без текста)"}${photos.length ? `\n📷 Фото: ${photos.length}` : ""}\n\nОпубликовать: шестерёнка → «⭐ Отзывы».`).catch(() => {});
    return { ok: true, id: r.id, bonus, status: r.status, link2gis: rating >= 4 ? reviewLink2gis() : "" };
  });
  /* admin: moderation and the QR for the card in the bouquet */
  on("GET", "/api/admin/reviews", () => {
    ensureReviewSource();
    const src = sourcesReport().find((x) => x.slug === REVIEW_SOURCE.slug) || {};
    return { list: RV().list.slice(0, 300), link: reviewCardLink(), links: linksFor(chatLink, "rv_1-s_" + REVIEW_SOURCE.slug), bonus: loyal().reviewBonus, enabled: LY.on(loyal(), "reviews"), link2gis: reviewLink2gis(), custom2gis: store.getCatalog().settings.review2gis || "",
      fromCard: { customers: src.customers || 0, orders: src.orders || 0, revenue: src.revenue || 0 } };
  }, { admin: true });
  on("PATCH", "/api/admin/reviews/:id", ({ params, body }) => {
    const r = RV().list.find((x) => x.id === params.id);
    if (!r) throw httpError(404, "Отзыв не найден");
    if (["approved", "hidden", "pending", "private"].includes(body.status)) r.status = body.status;
    if ("reply" in body) r.reply = String(body.reply || "").trim().slice(0, 1000);
    store.saveReviews();
    return { ok: true };
  }, { admin: true });
  on("DELETE", "/api/admin/reviews/:id", ({ params }) => {
    const before = RV().list.length;
    RV().list = RV().list.filter((x) => x.id !== params.id);
    if (RV().list.length === before) throw httpError(404, "Отзыв не найден");
    store.saveReviews();
    return { ok: true };
  }, { admin: true });

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

  on("GET", "/api/admin/catalog", ({ user }) => Object.assign({}, store.getCatalog(), isOwner(user) ? {} : { settings: Object.assign({}, store.getCatalog().settings, { transfer: undefined, staff: undefined, invites: undefined }) }, { loyaltyResolved: loyal(), paymentsResolved: Object.assign({}, paySettings(), onlinePayAllowed ? {} : { enabled: false }), onlinePayAllowed, transferResolved: isOwner(user) ? transferSettings() : null, env: { yookassa: !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY) } }), { admin: true });
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
    o.status = body.status;
    if (prev !== o.status) o.doneAt = o.status === "done" ? new Date().toISOString() : undefined;
    store.saveOrders();
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
      return Object.assign({}, src, { link: botLink("s_" + src.slug), links: linksFor(botLink, "s_" + src.slug), customers: ids.size, orders: mine.length, revenue: mine.reduce((sum, o) => sum + (o.toPay ?? o.totals.total), 0) });
    });
  }
  on("GET", "/api/admin/sources", () => {
    const all = Object.values(custDb().list);
    const other = { friend: "По ссылке друга", hint: "Через «Намекнуть»", gift: "Через цифровую открытку" };
    return { sources: sourcesReport(), auto: Object.entries(other).map(([k, t]) => ({ slug: k, title: t, customers: all.filter((c) => c.source === k).length })), linkBase: botLink("") || Object.values(linksFor(botLink, ""))[0] || "" };
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
    const qpf = platforms.includes(query.get("pf")) ? query.get("pf") : messenger;
    const text = slug ? botLink("s_" + slug, qpf) : String(query.get("text") || "");
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
    if (!anyBot()) throw httpError(400, "Бот не подключён");
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
    if ("review2gis" in body) { const u = str(body.review2gis, 300); if (u && !/^https:\/\/(2gis\.ru|go\.2gis\.com)\//.test(u)) throw httpError(400, "Нужна ссылка на 2ГИС: https://2gis.ru/…"); s.review2gis = u; }
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
      if ("reviewBonus" in b) next.reviewBonus = num(b.reviewBonus, 0, 10000, cur.reviewBonus);
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
    if (body.payments && typeof body.payments === "object" && onlinePayAllowed) {
      const cur = Object.assign({ enabled: false, provider: "demo" }, s.payments || {});
      if ("enabled" in body.payments) cur.enabled = !!body.payments.enabled;
      if (["demo", "yookassa"].includes(body.payments.provider)) cur.provider = body.payments.provider;
      s.payments = cur;
    }
    store.setCatalog(store.getCatalog());
    return { ok: true };
  }, { owner: true });
  /* ---------- admin: staff ---------- */
  function staffView() {
    const S = store.getCatalog().settings, cust = custDb().list, now = Date.now();
    const staffKeys = new Set(staffList().map((x) => keyOf(x.platform, x.id)));
    const owners = ownerEntries().filter((e) => !staffKeys.has(keyOf(e.platform, e.id))).map((e) => { const c = cust[String(e.id)]; return { id: Number(e.id), platform: e.platform, name: (c && c.name) || "Владелец", username: (c && c.username) || "", role: "owner" }; });
    return { platforms, owners, staff: staffList().map((x) => Object.assign({ platform: messenger }, x)), invites: (S.invites || []).filter((x) => new Date(x.expiresAt).getTime() > now).map((x) => ({ code: x.code, role: x.role || "manager", expiresAt: x.expiresAt, link: chatLink("staff_" + x.code), links: linksFor(chatLink, "staff_" + x.code) })) };
  }
  on("GET", "/api/admin/staff", () => staffView(), { owner: true });
  on("POST", "/api/admin/staff/invite", ({ body }) => {
    const S = store.getCatalog().settings;
    if (!Object.keys(linksFor(chatLink, "x")).length) throw httpError(400, "Бот ещё не подключён — пригласить не получится");
    const now = Date.now();
    S.invites = (S.invites || []).filter((x) => new Date(x.expiresAt).getTime() > now).slice(-9);
    const inv = { code: crypto.randomBytes(6).toString("hex"), role: body && body.role === "owner" ? "owner" : "manager", expiresAt: new Date(now + 864e5).toISOString() };
    S.invites.push(inv); store.setCatalog(store.getCatalog());
    const links = linksFor(chatLink, "staff_" + inv.code);
    return Object.assign(staffView(), { link: links[messenger] || Object.values(links)[0], links });
  }, { owner: true });
  on("PATCH", "/api/admin/staff/:id", ({ params, body }) => {
    const x = staffList().find((m) => String(m.id) === params.id);
    if (!x) throw httpError(404, "Сотрудник не найден");
    if ("notify" in body) x.notify = !!body.notify;
    if (body.role === "owner" || body.role === "manager") x.role = body.role;
    store.setCatalog(store.getCatalog());
    return staffView();
  }, { owner: true });
  on("DELETE", "/api/admin/staff/:id", ({ params, user }) => {
    if (String(user.id) === params.id) throw httpError(400, "Себя убрать нельзя");
    const S = store.getCatalog().settings;
    const gone = staffList().find((m) => String(m.id) === params.id);
    if (!gone) throw httpError(404, "Сотрудник не найден");
    S.staff = staffList().filter((m) => m !== gone);
    store.setCatalog(store.getCatalog());
    sendUser(params.id, `Доступ к управлению ${S.brand || "магазином"} закрыт владельцем.`, false, (gone && gone.platform) || messenger).catch(() => {});
    return staffView();
  }, { owner: true });
  on("DELETE", "/api/admin/staff/invite/:code", ({ params }) => {
    const S = store.getCatalog().settings;
    S.invites = (S.invites || []).filter((x) => x.code !== params.code);
    store.setCatalog(store.getCatalog());
    return staffView();
  }, { owner: true });
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
    if (!anyBot()) throw httpError(400, "Бот не подключён: укажите BOT_TOKEN (Telegram) или MAX_BOT_TOKEN (MAX) в настройках сервера.");
    const sent = await notify(`${E()} <b>Тестовая заявка</b>\nЕсли вы видите это сообщение, заявки из мини-аппа будут приходить сюда.\nОтправил: ${user.first_name || user.id}`);
    if (!sent.length) throw httpError(400, "Не удалось отправить. Напишите боту /start с нужного аккаунта и проверьте ID в настройках.");
    return { ok: true, sent };
  }, { admin: true });

  /* ---------- night backups (backup.js): /data/backups + the owner's bot chat ---------- */
  const bkStateFile = path.join(config.dataDir, "backups", "state.json");
  const bkState = () => { try { return JSON.parse(fs.readFileSync(bkStateFile, "utf8")); } catch (e) { return {}; } };
  const bkSave = (st) => { fs.mkdirSync(path.dirname(bkStateFile), { recursive: true }); fs.writeFileSync(bkStateFile, JSON.stringify(st, null, 1)); };
  /** Who gets the copies: BACKUP_CHAT_IDS (env) or the first owner — the person who started the bot first (Ilya). */
  const backupTo = () => {
    const env = String(process.env.BACKUP_CHAT_IDS || "").split(",").map((x) => x.trim()).filter((x) => /^((telegram|max):)?-?\d{3,20}$/.test(x)).map(parseKey);
    return env.length ? env : (store.getCatalog().settings.ownerIds || []).slice(0, 1).map(parseKey);
  };
  const ruDT = (d) => new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Irkutsk", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
  let bkRunning = false;
  async function runBackup({ now = new Date(), full = false } = {}) {
    if (bkRunning) throw httpError(409, "Копия уже делается — подождите минуту");
    bkRunning = true;
    const st = bkState();
    try {
      store.flush();
      const photos = BK.uploadsList(config.dataDir);
      const sig = crypto.createHash("sha1").update(photos.join(",")).digest("hex");
      const withPhotos = full || sig !== st.photosSig || !st.photosAt || now - new Date(st.photosAt) > 7 * 864e5;
      const S = store.getCatalog().settings;
      const { buf, manifest } = BK.createBackup(config.dataDir, { withPhotos, brand: S.brand || "", now });
      const stamp = LY.todayLocal(now) + "-" + String(LY.hourLocal(now)).padStart(2, "0") + new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Irkutsk", minute: "2-digit" }).format(now).padStart(2, "0");
      const name = `backup-${stamp}${withPhotos ? "-foto" : ""}.zip`;
      BK.saveLocal(config.dataDir, name, buf);
      const nCust = Object.keys(store.getCustomers().list).length, nOrd = store.getOrders().list.length;
      const caption = `🗄 <b>Копия ${escH(S.brand || "магазина")}</b> от ${ruDT(now)}\nКлиентов: ${nCust} · заказов: ${nOrd} · товаров: ${store.getCatalog().products.length}\n` +
        (withPhotos ? `Фото: ${manifest.photos} (все)` : `Фото не менялись — они в копии от ${st.photosAt ? ruDT(st.photosAt) : "—"}`) +
        `\n\nСохраните файл. Как восстановить — внутри архива, файл «КАК-ВОССТАНОВИТЬ.txt».`;
      const to = backupTo(), sentTo = [];
      let sendError = "";
      for (const r of to) {
        const b = botFor(r.platform);
        if (!b || !b.sendDocument) continue;
        try { await b.sendDocument(r.id, buf, `${(S.brand || "shop").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}-${name}`, caption); sentTo.push(r.id); }
        catch (e) { sendError = e.message; log.error("Копия в чат " + r.id + ": " + e.message); }
      }
      const next = Object.assign(st, { day: LY.todayLocal(now), lastAt: now.toISOString(), lastName: name, lastSize: buf.length, lastSent: sentTo.length, lastError: sendError || (to.length ? "" : "Некому отправить: нет владельца") });
      if (withPhotos && (sentTo.length || !to.length || !anyBot())) Object.assign(next, { photosSig: sig, photosAt: now.toISOString(), photosName: name });
      bkSave(next);
      return { name, size: buf.length, withPhotos, sentTo: sentTo.length, error: next.lastError };
    } finally { bkRunning = false; }
  }
  function backupStatus() {
    const st = bkState();
    let files = [];
    try { files = fs.readdirSync(path.join(config.dataDir, "backups")).filter((f) => /^backup-.*\.zip$/.test(f)).sort().reverse(); } catch (e) { /* none yet */ }
    return { lastAt: st.lastAt || null, lastName: st.lastName || "", lastSize: st.lastSize || 0, lastSent: st.lastSent || 0, lastError: st.lastError || "", photosAt: st.photosAt || null, onServer: files.length, to: backupTo().length, restored: restored.map((m) => ({ createdAt: m.createdAt, files: m.files, photos: m.restoredPhotos })) };
  }
  on("GET", "/api/admin/backup", () => backupStatus(), { owner: true });
  on("POST", "/api/admin/backup", async () => Object.assign(await runBackup({ full: true }), { status: backupStatus() }), { owner: true });
  if (restored.length && anyBot()) {
    const t = setTimeout(() => {
      const last = restored[restored.length - 1];
      for (const r of backupTo()) sendUser(r.id, `✅ <b>Магазин восстановлен из копии</b> от ${ruDT(last.createdAt)}.\nЗагружено: ${last.files.join(", ")}${restored.some((m) => m.restoredPhotos) ? `, фото: ${restored.reduce((a, m) => a + m.restoredPhotos, 0)}` : ""}.`, false, r.platform).catch(() => {});
    }, 4000);
    if (t.unref) t.unref();
  }

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
  /* index.html is written for Sweet Roses; the app re-paints it after loading the catalog. To avoid a flash of the
     wrong shop, the server puts this shop's title, theme, logo, phone and catalog icon into the page right away. */
  const LOGO_MARKS = {
    gf: `<svg class="logo-mark" viewBox="0 0 84 66" fill="none" stroke="currentColor" stroke-width="3.6" aria-hidden="true"><path d="M40 8A28 28 0 0 0 28 61.4"/><path d="M38.5 8H76M50 8V66M27 33H73M27 43H73M39 43V66"/></svg>`,
  };
  const FLOWER_ICON = '<path d="M7 4.5l2.5 2L12 3.5l2.5 3 2.5-2V9a5 5 0 0 1-10 0z"/><path d="M12 14v7M12 18.5c-1.8-2-4-2.2-5-1.6 1.4 1.5 3.4 2.1 5 1.6M12 17c1.4-1.6 3.4-1.8 4.4-1.3-1.2 1.3-2.9 1.8-4.4 1.3"/>';
  function brandedIndex(html) {
    const S = store.getCatalog().settings || {};
    const e = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    if (S.brand) html = html.replace(/<title>[^<]*<\/title>/, `<title>${e(S.brand)}</title>`);
    if (S.theme && /^[a-z0-9-]{1,30}$/.test(S.theme)) html = html.replace('<html lang="ru">', `<html lang="ru" data-brand="${S.theme}">`);
    const mark = LOGO_MARKS[S.logoMark] || (Array.isArray(S.monogram) && S.monogram.length === 2 ? `${e(S.monogram[0])}<i></i>${e(S.monogram[1])}` : "");
    if (mark) html = html.replace(/<a class="monogram" href="#\/" aria-label="[^"]*">[\s\S]*?<\/a>/, `<a class="monogram" href="#/" aria-label="${e((S.brand || "") + " — на главную")}">${mark}</a>`);
    const tel = String(S.phone || "").replace(/[^\d+]/g, "");
    if (tel) html = html.replace(/id="topLeft" href="tel:[^"]*"/, `id="topLeft" href="tel:${tel}"`);
    if (S.catalogIcon === "flower") html = html.replace(/(<button class="tab" data-tab="catalog"[^>]*>\s*<svg viewBox="0 0 24 24">)[\s\S]*?(<\/svg>)/, `$1${FLOWER_ICON}$2`);
    return html;
  }
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Не найдено"); }
    const ext = path.extname(file);
    if (path.basename(file) === "index.html") { // the shop's name, logo and colours from the first frame — no Sweet Roses flash
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      return res.end(brandedIndex(fs.readFileSync(file, "utf8")));
    }
    const long = ext === ".woff2";
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": long ? "public, max-age=31536000, immutable" : "no-cache", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(file).pipe(res);
  }

  // When no WEBAPP_URL is configured, learn the public https address from the first real request
  // (e.g. https://sweetroses-xxx.amvera.io) and point the bot's buttons at it.
  const HOST_SUFFIXES = (process.env.PUBLIC_HOST_SUFFIXES || ".amvera.io,.amvera.app,.amvera.tech").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  function detectPublicUrl(req) {
    const setAll = (u) => { for (const pf of platforms) { const b = bots[pf]; if (b && b.setWebAppUrl) b.setWebAppUrl(u); } };
    if (process.env.WEBAPP_URL || !anyBot()) return;
    const s = store.getCatalog().settings;
    if (s.webAppUrl) { setAll(s.webAppUrl); return; } // learned once, never overwritten by request headers
    const host = String(req.headers.host || "").trim().toLowerCase().replace(/:\d+$/, "");
    if (!/^[a-z0-9.-]+$/.test(host) || !HOST_SUFFIXES.some((suf) => host.endsWith(suf))) return;
    s.webAppUrl = "https://" + host;
    store.setCatalog(store.getCatalog());
    if (log.log) log.log("Адрес мини-аппа: " + s.webAppUrl);
    setAll(s.webAppUrl);
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
      if (route.owner && !isOwner(user)) throw httpError(403, "Это может только владелец");
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

  /** The text of the «how was the bouquet?» message for an order, or null if it is not the time or not needed. */
  const REVIEW_ASK_AFTER_H = 18, REVIEW_ASK_GAP_DAYS = 14;
  function reviewAskFor(o, now = new Date()) {
    if (o.status !== "done" || !o.doneAt || o.reviewAskedAt || !o.tgUser) return null;
    const age = now - new Date(o.doneAt);
    if (age < REVIEW_ASK_AFTER_H * 3600e3 || age > 5 * 864e5) return null; // not before the next day; old orders — no
    const uid = String(o.tgUser.id);
    const c = custDb().list[uid];
    if (c && c.sent && c.sent.reviewAsk && now - new Date(c.sent.reviewAsk) < REVIEW_ASK_GAP_DAYS * 864e5) return null; // not too often
    const mine = RV().list.filter((r) => r.userId === uid);
    if (mine.some((r) => r.at > o.createdAt)) return null; // already left a review for it
    const L = loyal();
    const lastBonus = mine.filter((x) => x.bonus).sort((a, b) => b.at.localeCompare(a.at))[0];
    const bonus = LY.on(L, "bonuses") && L.reviewBonus > 0 && (!lastBonus || now - new Date(lastBonus.at) > REVIEW_BONUS_DAYS * 864e5) ? L.reviewBonus : 0;
    const name = ((c && c.name) || o.tgUser.name || "").split(" ")[0];
    const brand = store.getCatalog().settings.brand || "наш магазин";
    return `${name ? name + ", здравствуйте!" : "Здравствуйте!"} 💐\n\n`
      + (o.method === "delivery" ? `Ваш букет из ${brand} уже доставлен — надеемся, он подарил много радости 🌷` : `Надеемся, букет из ${brand} порадовал вас и того, для кого он был 🌷`)
      + `\n\nПоделитесь, пожалуйста, как вам цветы, упаковка и наша работа. Это займёт минуту, а нам очень поможет стать лучше.`
      + (bonus ? `\n\n🎁 За отзыв подарим <b>${bonus} бонусов</b> на следующий заказ.` : "")
      + `\n\nНажмите кнопку ниже 👇`;
  }

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
    // «Как вам букет?» — the day after the order is marked «Выполнен», 11:00–21:00
    if (LY.on(L, "reviews") && LY.on(L, "reviewAsk") && hour >= 11 && hour < 21) {
      for (const o of store.getOrders().list) {
        const ask = reviewAskFor(o, now);
        if (!ask) continue;
        o.reviewAskedAt = now.toISOString(); ordersChanged = true;
        const c = db.list[String(o.tgUser.id)];
        if (c) { c.sent = c.sent || {}; c.sent.reviewAsk = now.toISOString(); changed = true; }
        await sendUser(o.tgUser.id, ask, { text: "⭐ Оценить букет", payload: "rv_1" });
      }
    }
    if (ordersChanged) store.saveOrders();
    if (changed) store.saveCustomers();
    // the night backup: once a day after 3:00 (Irkutsk)
    if (!opts.noBackup && hour >= 3 && bkState().day !== today) { try { await runBackup({ now }); } catch (e) { log.error("Ночная копия: " + e.message); } }
  }

  return { server, store, bot, bots, config, isAdmin, claimOwner, onBotStart, greeting, customers, runJobs, runBackup, backupStatus, restored };
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, () => {
    console.log(`Sweet Roses mini app: http://localhost:${port}`);
    for (const pf of app.config.platforms) {
      if (!app.config.botTokens[pf]) console.log((pf === "max" ? "MAX_BOT_TOKEN" : "BOT_TOKEN") + " не задан — бот " + PLATFORM_NAME[pf] + " выключен.");
      else console.log("Мессенджер: " + PLATFORM_NAME[pf]);
    }
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
  for (const pf of app.config.platforms) {
    const b = app.bots[pf];
    if (b) b.startPolling({ isAdmin: (id) => app.isAdmin({ id, platform: pf }), onStart: (from, payload) => app.onBotStart(from, payload, pf), greeting: app.greeting });
  }
  setInterval(() => app.runJobs().catch((e) => console.error("Фоновые задачи: " + e.message)), 5 * 60e3).unref();
  setTimeout(() => app.runJobs().catch(() => {}), 20e3).unref();
  const shutdown = () => { app.store.flush(); for (const b of Object.values(app.bots)) if (b) b.stop(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

module.exports = { createApp };
