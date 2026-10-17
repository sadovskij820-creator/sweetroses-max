/* Sweet Roses — mini app for MAX and Telegram (vanilla JS, no build step) */
// starts once the messenger bridge has loaded (or failed / timed out) — see index.html
(window.__bridgeReady || Promise.resolve()).then(function () {
  if (!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined) && window.__tgStandIn) {
    const st = window.__tgStandIn();
    if (st) { window.Telegram = window.Telegram || {}; window.Telegram.WebApp = st; }
  }
  "use strict";

  // Host messenger. MAX's script creates window.WebApp even outside MAX, so only a non-empty initData means "inside MAX".
  const TGW = window.Telegram && window.Telegram.WebApp;
  const LAUNCH_HASH = location.hash; // MAX passes launch data in the URL fragment (#WebAppData=...); keep it before the router changes the hash
  const MXW = window.WebApp && (window.WebApp.initData || /WebAppData=/.test(LAUNCH_HASH)) ? window.WebApp : null;
  const mx = MXW && !(TGW && TGW.initData) ? MXW : null;
  const tg = !mx && TGW && TGW.initData !== undefined ? TGW : null;
  const host = tg || mx;
  const HOST_NAME = mx ? "MAX" : "Telegram";
  const INIT_DATA = (host && host.initData) || (mx && /WebAppData=/.test(LAUNCH_HASH) ? LAUNCH_HASH : "");
  // the bot's button opens the app as …/?start=rv_1-s_otzyv (Telegram buttons have no start_param) — pass it to the server
  const START_PARAM = (() => { try { const v = new URLSearchParams(location.search).get("start") || ""; return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : ""; } catch (e) { return ""; } })();
  const P = window.SRPricing;
  const $app = document.getElementById("app");
  const TZ = "Asia/Irkutsk";

  const CHOC_COLORS = {
    "Молочный": "#9a6a48",
    "Белый": "#f6efe2",
    "Розовый (клубничный)": "#f2a7b5",
    "Руби": "#c45a6e",
    "Тёмный": "#3b2418",
    "Карамельный": "#c98d45",
  };
  // Shop logo marks drawn as lines (they follow the theme colour). "gf" — Flowers Gagulya, as on the shop sign.
  const LOGO_MARKS = {
    gf: `<svg class="logo-mark" viewBox="0 0 84 66" fill="none" stroke="currentColor" stroke-width="3.6" aria-hidden="true"><path d="M40 8A28 28 0 0 0 28 61.4"/><path d="M38.5 8H76M50 8V66M27 33H73M27 43H73M39 43V66"/></svg>`,
  };
  const STATUS = { new: "Новая", work: "В работе", done: "Выполнена", cancel: "Отменена", pay: "Ждёт оплаты" };
  const STATUS_CLIENT = { new: "Принят", work: "Готовим", done: "Выполнен", cancel: "Отменён", pay: "Ждёт оплаты" };

  const state = {
    catalog: null,
    me: { isAdmin: false, user: null },
    cart: loadCart(),
    promo: { code: "", percent: 0, message: "" },
    checkout: null,
    admin: { tab: "orders", data: null, search: "", segment: "all", cq: "" },
    profile: null,
    payment: null,
    start: {},
    lastGiftLink: "",
    search: "",
  };

  /* ---------------- utils ---------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const rub = (n) => P.formatRub(n);
  function img(url, w) {
    if (!url) return "";
    // Tilda CDN resize: static.tildacdn.com/<dir>/<file> -> optim.tildacdn.com/<dir>/-/resize/<w>x/-/format/webp/<file>
    const m = /^https:\/\/static\.tildacdn\.com\/([^/]+)\/([^/?#]+)$/.exec(url);
    return m ? `https://optim.tildacdn.com/${m[1]}/-/resize/${w}x/-/format/webp/${m[2]}` : url;
  }
  function imgTag(url, w, alt, extra) {
    if (!url) return `<div class="ph-empty"></div>`;
    return `<img src="${esc(img(url, w))}" data-orig="${esc(url)}" alt="${esc(alt || "")}" loading="lazy" decoding="async" ${extra || ""} onerror="if(this.dataset.orig&&this.src!==this.dataset.orig){this.src=this.dataset.orig}">`;
  }
  function store(key, val) {
    try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null"); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; }
  }
  function loadCart() {
    const c = store("sr_cart");
    return c && Array.isArray(c.lines) ? c : { lines: [], addons: {}, cardText: "" };
  }
  function saveCart() { store("sr_cart", state.cart); updateBadge(); }
  function haptic(kind) { try { host && host.HapticFeedback && (kind === "ok" ? host.HapticFeedback.notificationOccurred("success") : host.HapticFeedback.impactOccurred("light")); } catch (e) {} }
  let toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }
  function todayISO(offsetDays) {
    const d = new Date(Date.now() + (offsetDays || 0) * 864e5);
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  }
  function nowMinutesTZ() {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    const h = +parts.find((p) => p.type === "hour").value, m = +parts.find((p) => p.type === "minute").value;
    return h * 60 + m;
  }
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

  /* ---------------- API ---------------- */
  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json", "X-Init-Data": INIT_DATA, "X-Platform": mx ? "max" : "telegram" }, START_PARAM ? { "X-Start-Param": START_PARAM } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || "Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.");
    return data;
  }
  function track(type, productId) {
    if (window.__MOCK) return;
    api("/api/track", { method: "POST", body: { type, productId } }).catch(() => {});
  }

  /* ---------------- catalog helpers ---------------- */
  const visibleProducts = () => state.catalog.products.filter((p) => !p.hidden).sort((a, b) => a.sort - b.sort);
  const visibleCats = () => state.catalog.categories.filter((c) => !c.hidden).sort((a, b) => a.sort - b.sort);
  const productById = (id) => state.catalog.products.find((p) => String(p.id) === String(id));
  function catCover(catId) {
    const p = visibleProducts().find((x) => x.cats.includes(catId));
    return p ? p.images[0] : "";
  }
  function totals(co) {
    // Promo codes are verified by the server (/api/promo); here we only apply the confirmed percent for display.
    const promos = state.promo.percent ? [{ code: state.promo.code, percent: state.promo.percent, active: true }] : [];
    const d = co ? { method: co.method, zoneId: co.zoneId } : {};
    return P.computeTotals(Object.assign({}, state.catalog, { promos }), state.cart, Object.assign({ promoCode: state.promo.percent ? state.promo.code : "" }, d));
  }
  const zones = () => P.activeZones(state.catalog);
  const zoneById = (id) => zones().find((z) => String(z.id) === String(id || ""));
  const transferOn = () => !!(state.catalog.transfer && state.catalog.transfer.enabled && host);
  const transferNow = () => transferOn() && state.catalog.transfer.mode !== "after";
  function cartCount() { return state.cart.lines.reduce((s, l) => s + l.qty, 0); }
  function updateBadge() {
    const b = document.getElementById("cartBadge");
    const n = cartCount();
    b.hidden = !n; b.textContent = n;
  }
  function addToCart(id, qty, choc) {
    choc = choc || [];
    const key = id + "|" + choc.join(",");
    const line = state.cart.lines.find((l) => l.id + "|" + (l.choc || []).join(",") === key);
    if (line) line.qty = Math.min(99, line.qty + qty);
    else state.cart.lines.push({ id: String(id), qty, choc });
    saveCart(); haptic(); track("cart", id);
    toast("Добавлено в корзину");
  }

  /* ---------------- loyalty helpers ---------------- */
  const LOY = () => (state.catalog && state.catalog.loyalty) || { features: {} };
  const feat = (f) => !!(LOY().features || {})[f];
  const ddmm = (iso) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(new Date(iso));
  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  function loadProfile() {
    if (!INIT_DATA || window.__MOCK) return Promise.resolve();
    state.profileAt = Date.now();
    return api("/api/profile").then((p) => { state.profile = p; render(); }).catch(() => {});
  }
  /** Days until the next occurrence of MM-DD (local). */
  function daysUntil(md) {
    const today = todayISO(0); const [y] = today.split("-").map(Number);
    const t = Date.UTC(...today.split("-").map((n, i) => (i === 1 ? n - 1 : +n)));
    const [mm, dd] = md.split("-").map(Number);
    for (const yy of [y, y + 1]) { const diff = Math.round((Date.UTC(yy, mm - 1, dd) - t) / 864e5); if (diff >= 0) return diff; }
    return 999;
  }
  /** A link that opens the bot's mini app with parameters (and credits the sharer as the referrer). */
  function appLink(param) {
    const p = state.profile;
    if (!p || !p.linkBase) return "";
    return p.linkBase + param + (p.refCode && feat("referral") ? "-r_" + p.refCode : "");
  }
  async function shareLink(text, link) {
    if (!link) { toast("Ссылка появится, когда магазин подключат к боту"); return; }
    try {
      if (mx && mx.shareMaxContent) { await mx.shareMaxContent({ text, link }); return; }
      if (tg) { tg.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(text)); return; }
      if (navigator.share) { await navigator.share({ text, url: link }); return; }
    } catch (e) { /* fall back to copying */ }
    try { await navigator.clipboard.writeText(text + " " + link); toast("Ссылка скопирована"); } catch (e) { toast(link); }
  }
  /** MAX: the app was opened by a link, the bot chat isn't saved yet — ask to press «Начать» once. */
  function saveChatCard() {
    const p = state.profile;
    if (!mx || !p || p.botStarted || !p.chatLink || state.saveChatHidden) return "";
    return `<div class="welcome-card save-chat"><div class="wc-emoji">📌</div><div><b>Сохраните магазин в чатах</b>
      <small>Нажмите «Начать» в чате — туда придут статус заказа, бонусы и напоминания.</small></div>
      <button class="btn small" data-action="openChat">В чат</button></div>`;
  }
  function welcomeCard() {
    const w = state.profile && state.profile.welcome;
    if (!w) return "";
    const why = { welcome: "Приветственный подарок", friend: "Подарок от друга", gift: "Подарок к открытке" }[w.kind] || "Подарок";
    return `<div class="welcome-card"><div class="wc-emoji">🎁</div><div><b>${why}: ${w.amount} ${plural(w.amount, "бонус", "бонуса", "бонусов")}</b>
      <small>Оплатите ими часть первого заказа — до ${LOY().maxPayPercent}% суммы.</small></div><button class="btn small" data-action="welcomeOk">Отлично</button></div>`;
  }
  function loyaltyCard(p, link) {
    const lv = p.level;
    const pct = lv.next ? Math.max(4, Math.min(100, Math.round((lv.spent / (lv.spent + lv.next.remaining)) * 100))) : 100;
    return `<${link ? 'a href="#/profile"' : "div"} class="loyal-card">
      <div class="lc-top"><span class="lc-level">${esc(lv.name)}</span><span class="lc-pct">${lv.percent}% бонусами</span></div>
      <div class="lc-bal"><b>${p.balance}</b> ${plural(p.balance, "бонус", "бонуса", "бонусов")}</div>
      ${feat("levels") ? `<div class="lc-bar"><i style="width:${pct}%"></i></div>
      <div class="lc-next">${lv.next ? `До уровня «${esc(lv.next.name)}» — ${rub(lv.next.remaining)}` : "Максимальный уровень 🎉"}</div>` : ""}
      ${p.burning ? `<div class="lc-burn">⏳ ${p.burning.amount} ${plural(p.burning.amount, "бонус сгорит", "бонуса сгорят", "бонусов сгорят")} ${ddmm(p.burning.date)}</div>` : ""}
    </${link ? "a" : "div"}>`;
  }
  function homeExtras() {
    const p = state.profile;
    if (!p) return "";
    const parts = [saveChatCard(), welcomeCard()];
    if (feat("bonuses")) parts.push(loyaltyCard(p, true));
    const last = p.orders.find((o) => o.status !== "cancel");
    if (feat("repeat") && last) parts.push(`<button class="quick-row" data-action="repeatOrder" data-id="${last.id}"><span>🔁</span><span><b>Повторить прошлый заказ</b><small>${esc(last.lines.map((l) => l.title).join(", ")).slice(0, 80)}</small></span></button>`);
    if (feat("dates") && p.dates.length) {
      const next = p.dates.map((d) => ({ d, n: daysUntil(d.md) })).sort((a, b) => a.n - b.n)[0];
      if (next && next.n <= 30) parts.push(`<a class="quick-row" href="#/catalog/all"><span>🎂</span><span><b>${esc(next.d.title)} ${next.n === 0 ? "сегодня" : `через ${next.n} ${plural(next.n, "день", "дня", "дней")}`}</b><small>Выбрать подарок заранее</small></span></a>`);
    }
    return parts.join("");
  }

  /* ---------------- views ---------------- */
  function productCard(p) {
    return `<div class="card">
      <div class="ph"><a href="#/p/${esc(p.id)}" style="display:block;height:100%" aria-label="${esc(p.title)}">${imgTag(p.images[0], 480, p.title)}</a>
      <button class="add glass" data-action="quickAdd" data-id="${esc(p.id)}" aria-label="Добавить «${esc(p.title)}» в корзину">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div>
      <a href="#/p/${esc(p.id)}" style="text-decoration:none"><h3>${esc(p.title)}</h3>
      <div class="price">${rub(p.price)}${p.oldPrice ? `<span class="old-price">${rub(p.oldPrice)}</span>` : ""}</div></a>
    </div>`;
  }

  function viewHome() {
    const s = state.catalog.settings;
    // the home page sections and chips come from the shop's settings (defaults = Sweet Roses)
    const sections = s.homeSections || [{ cat: "top", title: "Готовые подарки", more: "Все готовые подарки" }, { cat: "chocolate", title: "Боксы с клубникой", more: "Все боксы" }];
    const chips = s.heroChips || ["Доставка от 1 часа", "Производство по ГОСТу"];
    return `<div class="page">
      ${s.demoNote ? `<div class="demo-note">${esc(s.demoNote)}</div>` : ""}
      ${homeExtras()}
      <section class="hero">
        ${imgTag(s.banner.image, 900, s.tagline + " " + s.brand, 'loading="eager"')}
        <div class="hero-card glass">
          <h1 class="display">${esc(s.banner.title)}</h1>
          <p>${esc(s.banner.text)}</p>
          <a class="btn block" href="#/catalog/all">${esc(s.heroButton || "Выбрать подарок")}</a>
          <div class="hero-meta">${chips.map((x) => `<span class="chip-note">${esc(x)}</span>`).join("")}</div>
        </div>
      </section>

      <h2 class="h2">Каталог</h2>
      <div class="rail">
        ${visibleCats().map((c) => `<a class="cat-tile" href="#/catalog/${esc(c.id)}"><div class="ph">${imgTag(catCover(c.id), 240, "")}</div><span>${esc(c.title)}</span></a>`).join("")}
      </div>

      ${sections.map((sec) => {
        const list = visibleProducts().filter((p) => p.cats.includes(sec.cat)).slice(0, 6);
        return list.length ? `<h2 class="h2">${esc(sec.title)}</h2><div class="grid">${list.map(productCard).join("")}</div>
      <a class="btn soft block" style="margin-top:16px" href="#/catalog/${esc(sec.cat)}">${esc(sec.more || "Смотреть все")}</a>` : "";
      }).join("")}
      ${homeReviews()}
    </div>`;
  }

  function viewCatalog(catId, query) {
    const cats = visibleCats();
    const all = visibleProducts();
    const q = state.search.trim().toLowerCase();
    // search always covers the whole catalog, so a customer never misses an item hidden in another category
    let list = q ? all.filter((p) => (p.title + " " + p.short + " " + (p.intro || "")).toLowerCase().includes(q))
      : catId && catId !== "all" ? all.filter((p) => p.cats.includes(catId)) : all;
    const cat = cats.find((c) => c.id === catId);
    return `<div class="page">
      <h1 class="display" style="font-size:36px;margin-top:8px">${esc(q ? "Поиск" : cat ? cat.title : "Весь каталог")}</h1>
      <div class="chips" role="toolbar" aria-label="Категории">
        <button class="chip" aria-pressed="${!cat && !q}" data-action="go" data-to="#/catalog/all">Все</button>
        ${cats.map((c) => `<button class="chip" aria-pressed="${!q && c.id === catId}" data-action="go" data-to="#/catalog/${esc(c.id)}">${esc(c.title)}</button>`).join("")}
      </div>
      <input class="search" type="search" placeholder="Найти: пионы, корзина, XL…" value="${esc(state.search)}" data-input="search" ${query.search ? "autofocus" : ""} aria-label="Поиск по каталогу">
      <p class="muted" style="margin:6px 2px 14px;font-size:13px">${list.length} ${plural(list.length, "товар", "товара", "товаров")}</p>
      ${list.length ? `<div class="grid">${list.map(productCard).join("")}</div>` :
        `<div class="empty"><p>Ничего не нашлось. Попробуйте другое слово или посмотрите весь каталог.</p><a class="btn soft" href="#/catalog/all" data-action="clearSearch">Показать всё</a></div>`}
    </div>`;
  }
  function plural(n, a, b, c) { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; }

  let pdpChoc = [];
  let pdpQty = 1;
  function viewProduct(id) {
    const p = productById(id);
    if (!p || p.hidden) return `<div class="page empty"><h1 class="display">Товар не найден</h1><p>Возможно, его убрали из каталога.</p><a class="btn" href="#/catalog/all">Открыть каталог</a></div>`;
    const choices = state.catalog.chocolates;
    const need = p.chocolateChoices || 0;
    return `<div class="page" style="padding-bottom:90px">
      <div class="gallery" data-gallery>${p.images.map((u, i) => imgTag(u, 900, p.title + " — фото " + (i + 1), i ? "" : 'loading="eager"')).join("")}</div>
      ${p.images.length > 1 ? `<div class="dots">${p.images.map((_, i) => `<i class="${i ? "" : "on"}"></i>`).join("")}</div>` : ""}
      ${state.start.hint && String(state.start.productId) === String(p.id) ? `<div class="hint-banner">💝 <b>${esc(state.start.fromName || "Вам")}</b> ${state.start.fromName ? "намекает" : "намекают"}: очень хочется именно этот подарок</div>` : ""}
      <h1 class="product-title">${esc(p.title)}</h1>
      <div class="product-price price">${rub(p.price)}${p.oldPrice ? `<span class="old-price">${rub(p.oldPrice)}</span>` : ""}</div>
      <p class="muted" style="margin:10px 0 0">${esc(p.intro || p.short)}</p>
      ${need ? `<div class="choc-title">Шоколад: выберите до ${need === 1 ? "одного вида" : need + " видов"}</div>
        <div class="muted" style="font-size:13px">Если не выберете, менеджер уточнит при подтверждении.</div>
        <div class="choc-grid">${choices.map((c) => `<button class="choc" aria-pressed="${pdpChoc.includes(c)}" data-action="choc" data-choc="${esc(c)}" data-max="${need}"><i style="background:${CHOC_COLORS[c] || "#ccc"}"></i>${esc(c)}</button>`).join("")}</div>` : ""}
      ${p.details && p.details.length ? `<ul class="details">${p.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
      ${host && (feat("hint") || feat("share")) ? `<div class="share-row">
        ${feat("hint") ? `<button class="btn soft" data-action="hint" data-id="${esc(p.id)}">💝 Намекнуть</button>` : ""}
        ${feat("share") ? `<button class="btn ghost" data-action="shareProduct" data-id="${esc(p.id)}">Поделиться</button>` : ""}
      </div>${feat("hint") ? `<p class="muted" style="font-size:12.5px;margin:8px 2px 0">«Намекнуть» — отправьте этот подарок тому, кто должен его подарить 😉</p>` : ""}` : ""}
    </div>
    <div class="buybar glass">
      <div class="stepper"><button data-action="pdpQty" data-d="-1" aria-label="Меньше">−</button><span id="pdpQty">${pdpQty}</span><button data-action="pdpQty" data-d="1" aria-label="Больше">+</button></div>
      <button class="btn" style="flex:1" data-action="pdpAdd" data-id="${esc(p.id)}">В корзину · <span id="pdpSum">${rub(p.price * pdpQty)}</span></button>
    </div>`;
  }

  function viewCart() {
    if (!state.cart.lines.length) {
      return `<div class="page empty"><h1 class="display">Корзина пуста</h1><p>${esc(state.catalog.settings.emptyCartText || "Загляните в каталог: там боксы, букеты и наборы с клубникой в шоколаде.")}</p><a class="btn" href="#/catalog/all">Открыть каталог</a></div>`;
    }
    const t = totals();
    const addons = state.catalog.addons.filter((a) => !a.hidden);
    return `<div class="page">
      <h1 class="display" style="font-size:36px;margin-top:8px">Корзина</h1>
      ${state.cart.lines.map((l, i) => {
        const p = productById(l.id);
        if (!p) return "";
        return `<div class="line">${imgTag(p.images[0], 200, p.title)}<div>
          <h4>${esc(p.title)}</h4>
          ${l.choc && l.choc.length ? `<div class="sub">Шоколад: ${esc(l.choc.join(", "))}</div>` : ""}
          <div class="row"><div class="stepper"><button data-action="lineQty" data-i="${i}" data-d="-1" aria-label="Меньше">−</button><span>${l.qty}</span><button data-action="lineQty" data-i="${i}" data-d="1" aria-label="Больше">+</button></div>
          <b class="price">${rub(p.price * l.qty)}</b></div></div></div>`;
      }).join("")}

      <h2 class="h2" style="font-size:26px">Добавить к заказу</h2>
      ${addons.map((a) => {
        const q = state.cart.addons[a.id] || 0;
        return `<div class="addon"><div><div class="t">${esc(a.title)}</div><div class="p">${rub(a.price)}</div></div>
          ${q ? `<div class="stepper" style="height:38px;background:var(--surface)"><button style="height:38px;width:38px" data-action="addonQty" data-id="${esc(a.id)}" data-d="-1" aria-label="Меньше">−</button><span>${q}</span><button style="height:38px;width:38px" data-action="addonQty" data-id="${esc(a.id)}" data-d="1" aria-label="Больше">+</button></div>`
          : `<button class="btn soft small" data-action="addonQty" data-id="${esc(a.id)}" data-d="1">Добавить</button>`}</div>
          ${a.withText && q ? `<label class="field"><span>Текст для открытки</span><textarea class="input" maxlength="300" data-input="cardText" placeholder="Например: С днём рождения, мама!">${esc(state.cart.cardText)}</textarea></label>` : ""}`;
      }).join("")}

      <label class="field"><span>Промокод</span>
        <div style="display:flex;gap:8px"><input class="input" data-input="promo" value="${esc(state.promo.code)}" placeholder="Например, Клубника" autocapitalize="characters">
        <button class="btn soft" data-action="applyPromo">Применить</button></div></label>
      ${state.promo.message ? `<div class="${state.promo.percent ? "muted" : "err"}" style="font-size:13px;margin-top:6px">${esc(state.promo.message)}</div>` : ""}

      <div class="summary">
        <div class="r"><span>Товары и допы</span><span class="price">${rub(t.subtotal)}</span></div>
        ${t.discount ? `<div class="r"><span>Скидка ${t.promo.percent}%</span><span class="price">−${rub(t.discount)}</span></div>` : ""}
        <div class="r"><span>Доставка</span><span class="muted">${zones().length ? "по району — при оформлении" : "рассчитает менеджер"}</span></div>
        <div class="r total"><span>Итого</span><span class="price">${rub(t.total)}</span></div>
      </div>
      <a class="btn block" style="margin-top:16px" href="#/checkout">Оформить заказ</a>
    </div>`;
  }

  function initCheckout() {
    if (state.checkout) return state.checkout;
    const u = host && host.initDataUnsafe && host.initDataUnsafe.user;
    const saved = store("sr_contact") || {};
    state.checkout = {
      name: saved.name || (u ? [u.first_name, u.last_name].filter(Boolean).join(" ") : ""),
      phone: saved.phone || "",
      date: todayISO(0), time: "", method: "pickup", address: saved.address || "", zoneId: saved.zoneId && zoneById(saved.zoneId) ? saved.zoneId : "", comment: "", consent: false, errors: {}, sending: false,
      useBonus: false, marketing: !!(state.profile && state.profile.consent),
    };
    return state.checkout;
  }
  /** Minutes we need before a slot: the zone's delivery time (the "to" end of the range), otherwise one hour. */
  function leadMinutes(c) {
    const z = c && c.method === "delivery" ? zoneById(c.zoneId) : null;
    return z ? z.to || z.from || 60 : 60;
  }
  function slotsFor(date, c) {
    const slots = state.catalog.settings.timeSlots;
    const isToday = date === todayISO(0);
    const now = nowMinutesTZ(), lead = leadMinutes(c);
    return slots.map((s) => ({ s, disabled: isToday && toMin(s) < now + lead }));
  }
  function zonePicker(c, e) {
    const zs = zones();
    if (!zs.length) return "";
    const z = zoneById(c.zoneId);
    return `<div class="field"><span>Район доставки</span>
      <div class="zones">${zs.map((x) => `<button class="zone" data-action="zone" data-id="${esc(x.id)}" aria-pressed="${String(x.id) === String(c.zoneId)}">
        <b>${esc(x.name)}</b><span>${x.price ? rub(x.price) : "бесплатно"}${P.zoneTime(x) ? " · " + P.zoneTime(x) : ""}</span>${x.freeFrom && x.price ? `<small>бесплатно от ${rub(x.freeFrom)}</small>` : ""}</button>`).join("")}</div>
      ${e.zone ? `<div class="err">${e.zone}</div>` : ""}
      ${z && P.zoneTime(z) ? `<div class="muted" style="font-size:13px;margin-top:8px">Привезём за ${P.zoneTime(z)} после готовности. Время ниже показываем только то, к которому успеем.</div>` : ""}</div>`;
  }
  function viewCheckout() {
    if (!state.cart.lines.length) { location.hash = "#/cart"; return ""; }
    const c = initCheckout();
    const t = totals(c);
    const e = c.errors;
    const slots = slotsFor(c.date, c);
    const zs = zones();
    return `<div class="page">
      <h1 class="display" style="font-size:36px;margin-top:8px">Оформление</h1>
      <label class="field"><span>Ваше имя</span><input class="input ${e.name ? "invalid" : ""}" data-input="co.name" value="${esc(c.name)}" autocomplete="name">${e.name ? `<div class="err">${e.name}</div>` : ""}</label>
      <label class="field"><span>Телефон</span><input class="input ${e.phone ? "invalid" : ""}" data-input="co.phone" value="${esc(c.phone)}" type="tel" inputmode="tel" placeholder="+7 900 000-00-00" autocomplete="tel">${e.phone ? `<div class="err">${e.phone}</div>` : ""}</label>
      ${canShareContact() ? `<button class="btn ghost small" style="margin-top:8px" data-action="shareContact">Взять номер из ${HOST_NAME}</button>` : ""}

      <div class="field"><span>Как получить</span>
        <div class="seg"><button data-action="method" data-m="pickup" aria-pressed="${c.method === "pickup"}">Самовывоз</button><button data-action="method" data-m="delivery" aria-pressed="${c.method === "delivery"}">Доставка</button></div>
        <div class="muted" style="font-size:13px;margin-top:8px">${c.method === "pickup" ? esc(state.catalog.settings.address) + ", " + esc(state.catalog.settings.hours.toLowerCase()) : zs.length ? "Выберите район — цена доставки сразу добавится к заказу." : "Курьер по тарифу такси. Стоимость менеджер назовёт при подтверждении."}</div>
      </div>
      ${c.method === "delivery" ? zonePicker(c, e) : ""}
      ${c.method === "delivery" ? `<label class="field"><span>Адрес доставки</span><input class="input ${e.address ? "invalid" : ""}" data-input="co.address" value="${esc(c.address)}" placeholder="Улица, дом, квартира, подъезд" autocomplete="street-address">${e.address ? `<div class="err">${e.address}</div>` : ""}</label>` : ""}

      <label class="field"><span>Дата готовности</span><input class="input" type="date" data-input="co.date" value="${esc(c.date)}" min="${todayISO(0)}" max="${todayISO(60)}"></label>
      <div class="field"><span>Время готовности</span>
        <div class="slots">${slots.map((x) => `<button class="slot" data-action="slot" data-t="${x.s}" aria-pressed="${c.time === x.s}" ${x.disabled ? "disabled" : ""}>${x.s}</button>`).join("")}</div>
        ${e.time ? `<div class="err">${e.time}</div>` : ""}
        ${slots.every((x) => x.disabled) ? `<div class="muted" style="font-size:13px;margin-top:6px">На сегодня свободного времени уже нет. Выберите другую дату.</div>` : ""}
      </div>
      <label class="field"><span>Пожелания к заказу</span><textarea class="input" data-input="co.comment" maxlength="500" placeholder="Например: без орехов, позвонить получателю">${esc(c.comment)}</textarea></label>
      ${feat("giftcard") && host ? `<label class="bonus-box" style="background:var(--surface)"><input type="checkbox" data-input="co.isGift" ${c.isGift ? "checked" : ""}>
        <span><b>Это подарок 🎁</b><small>Отправим получателю цифровую открытку с вашими словами${feat("bonuses") && LOY().giftBonus ? ` и ${LOY().giftBonus} бонусов на его первый заказ` : ""}.</small></span></label>
      ${c.isGift ? `<label class="field"><span>Кому</span><input class="input" data-input="co.giftTo" value="${esc(c.giftTo || "")}" maxlength="40" placeholder="Например: Маше"></label>
      <label class="field"><span>Текст открытки</span><textarea class="input" data-input="co.giftText" maxlength="300" placeholder="С днём рождения! Пусть этот день будет сладким">${esc(c.giftText || "")}</textarea></label>` : ""}` : ""}

      ${bonusBox(t, c)}
      <div class="summary">
        ${t.lines.map((l) => `<div class="r"><span>${esc(l.title)} × ${l.qty}</span><span class="price">${rub(l.sum)}</span></div>`).join("")}
        ${t.addons.map((a) => `<div class="r"><span>${esc(a.title)} × ${a.qty}</span><span class="price">${rub(a.sum)}</span></div>`).join("")}
        ${t.discount ? `<div class="r"><span>Скидка ${t.promo.percent}%</span><span class="price">−${rub(t.discount)}</span></div>` : ""}
        ${t.delivery ? `<div class="r"><span>Доставка · ${esc(t.delivery.title)}</span><span class="price">${t.delivery.free ? "бесплатно" : rub(t.delivery.price)}</span></div>` : ""}
        ${usableBonus(t) && c.useBonus ? `<div class="r"><span>Бонусами</span><span class="price">−${rub(usableBonus(t))}</span></div>` : ""}
        <div class="r total"><span>${payOnline() || transferNow() ? "К оплате" : "Итого"}${c.method === "delivery" && !t.delivery ? " без доставки" : ""}</span><span class="price">${rub(t.total - (c.useBonus ? usableBonus(t) : 0))}</span></div>
      </div>
      <label class="check"><input type="checkbox" data-input="co.consent" ${c.consent ? "checked" : ""}><span>Согласен(на) на обработку персональных данных для оформления заказа</span></label>
      ${feat("broadcasts") && host ? `<label class="check"><input type="checkbox" data-input="co.marketing" ${c.marketing ? "checked" : ""}><span>Присылать акции, напоминания о датах и бонусах</span></label>` : ""}
      ${e.consent ? `<div class="err">${e.consent}</div>` : ""}
      ${e.form ? `<div class="err" style="margin-top:10px">${esc(e.form)}</div>` : ""}
      <button class="btn block" style="margin-top:16px" data-action="submitOrder" ${c.sending ? "disabled" : ""}>${c.sending ? "Отправляем…" : payOnline() || transferNow() ? "Перейти к оплате" : "Отправить заявку"}</button>
      <p class="muted" style="font-size:12.5px;text-align:center;margin:10px 0 0">${payOnline() ? "Оплата картой или по СБП. Заказ подтвердим сразу после оплаты." : transferNow() ? "Оплата переводом на карту или по СБП — реквизиты на следующем шаге. Можно оплатить в любое время, даже ночью." : transferOn() ? "Оплата переводом после подтверждения: менеджер пришлёт реквизиты в чат." : "Оплата после звонка менеджера. Заказ готовим после 100% предоплаты."}</p>
    </div>`;
  }

  function usableBonus(t) {
    const p = state.profile;
    if (!feat("bonuses") || !p || !p.balance) return 0;
    const base = t.total - (t.delivery ? t.delivery.price : 0);
    return Math.max(0, Math.min(p.balance, Math.floor((base * (LOY().maxPayPercent || 0)) / 100)));
  }
  const payOnline = () => !!(state.catalog.payments && state.catalog.payments.enabled && host);
  function bonusBox(t, c) {
    const u = usableBonus(t);
    if (!u) return "";
    return `<label class="bonus-box"><input type="checkbox" data-input="co.useBonus" ${c.useBonus ? "checked" : ""}>
      <span><b>Списать ${u} ${plural(u, "бонус", "бонуса", "бонусов")}</b><small>На счёте ${state.profile.balance}. Бонусами можно оплатить до ${LOY().maxPayPercent}% заказа.</small></span></label>`;
  }
  function viewDone(id, query) {
    const paid = query && query.paid;
    const p = state.profile;
    const pct = p && feat("bonuses") ? p.level.percent : 0;
    return `<div class="page empty" style="padding-top:20px">
      <div class="success-mark"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>
      <h1 class="display">${paid ? `Заказ №${esc(id)} оплачен` : `Заявка №${esc(id)} отправлена`}</h1>
      <p style="max-width:34ch;margin:12px auto 22px">${paid ? "Спасибо! Оплата получена — мы уже начали готовить ваш заказ." : esc(state.catalog.settings.successText)}</p>
      ${query && query.claimed ? `<div class="info-card" style="text-align:left;margin:0 0 18px"><p><b>💳 Спасибо за оплату!</b></p><p class="muted" style="font-size:13.5px;margin-top:6px">Менеджер проверит поступление и подтвердит заказ — сообщение придёт в чат.</p></div>` : ""}
      ${query && query.after ? `<div class="info-card" style="text-align:left;margin:0 0 18px"><p><b>💳 Оплата переводом</b></p><p class="muted" style="font-size:13.5px;margin-top:6px">После подтверждения менеджер пришлёт реквизиты в чат, а в профиле появится кнопка «Оплатить».</p></div>` : ""}
      ${pct ? `<p class="muted" style="max-width:34ch;margin:-8px auto 22px;font-size:13.5px">После выполнения заказа начислим ${pct}% бонусами 💎</p>` : ""}
      ${state.lastGiftLink ? `<div class="info-card" style="text-align:left;margin:0 0 18px"><p><b>🎁 Цифровая открытка готова</b></p><p class="muted" style="font-size:13.5px;margin-top:6px">Отправьте её получателю — он увидит ваши слова${feat("bonuses") && LOY().giftBonus ? ` и получит ${LOY().giftBonus} бонусов` : ""}.</p>
        <button class="btn block" style="margin-top:12px" data-action="sendGift">Отправить открытку</button></div>` : ""}
      <a class="btn" href="#/">На главную</a>
    </div>`;
  }

  /* ---------------- digital gift card ---------------- */
  const giftCache = {};
  function viewGift(id) {
    const g = giftCache[id];
    if (!g) {
      api("/api/gift/" + encodeURIComponent(id)).then((d) => { giftCache[id] = d; render(); }).catch(() => { giftCache[id] = { missing: true }; render(); });
      return `<div class="page empty"><p class="muted">Открываем открытку…</p></div>`;
    }
    if (g.missing) return `<div class="page empty"><h1 class="display">Открытка не найдена</h1><a class="btn" href="#/">В магазин</a></div>`;
    return `<div class="page">
      <div class="gift-card">
        <div class="gc-top">🎁</div>
        <div class="gc-to">${g.to ? esc(g.to) + ", вам" : "Вам"} подарок</div>
        ${g.text ? `<div class="gc-text">«${esc(g.text)}»</div>` : ""}
        <div class="gc-from">— ${esc(g.from || "друг")}</div>
      </div>
      ${g.bonus ? `<div class="welcome-card" style="margin-top:16px"><div class="wc-emoji">💎</div><div><b>И ещё ${g.bonus} бонусов — вам</b><small>Ими можно оплатить часть вашего первого заказа.</small></div></div>` : ""}
      <a class="btn block" style="margin-top:16px" href="#/catalog/all">Посмотреть, что ещё есть в ${esc(state.catalog.settings.brand)}</a>
    </div>`;
  }

  /* ---------------- payment ---------------- */
  let payPoll = null;
  function viewPay(id) {
    const pay = state.payment && String(state.payment.id) === String(id) ? state.payment : null;
    if (!pay) return `<div class="page empty"><h1 class="display">Оплата заказа №${esc(id)}</h1><p>Ссылка на оплату устарела.</p><button class="btn" data-action="retryPay" data-id="${esc(id)}">Оплатить</button></div>`;
    if (pay.provider === "demo") {
      return `<div class="page">
        <h1 class="display" style="font-size:34px;margin-top:8px">Оплата</h1>
        <p class="lead">Заказ №${esc(id)}</p>
        <div class="pay-card">
          <div class="pay-sum">${rub(pay.amount)}</div>
          <label class="field"><span>Номер карты</span><input class="input" value="4242 4242 4242 4242" readonly></label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><label class="field"><span>Срок</span><input class="input" value="12/29" readonly></label><label class="field"><span>CVC</span><input class="input" value="•••" readonly></label></div>
          <button class="btn block" style="margin-top:16px" data-action="demoPay" data-id="${esc(id)}" ${pay.sending ? "disabled" : ""}>${pay.sending ? "Проводим платёж…" : "Оплатить " + rub(pay.amount)}</button>
          <button class="btn ghost block" style="margin-top:8px" data-action="demoSbp" data-id="${esc(id)}">Оплатить по СБП</button>
        </div>
        <p class="demo-note" style="margin-top:14px">Демо-оплата: деньги не списываются. В рабочей версии здесь откроется страница банка (ЮKassa) — карта, СБП, SberPay.</p>
      </div>`;
    }
    if (!payPoll) payPoll = setInterval(checkPaid, 3000);
    return `<div class="page empty" style="padding-top:20px">
      <h1 class="display">Оплата заказа №${esc(id)}</h1>
      <p style="max-width:34ch;margin:12px auto 18px">К оплате ${rub(pay.amount)}. Страница банка откроется в браузере — после оплаты вернитесь сюда, мы всё увидим сами.</p>
      <a class="btn" href="${esc(pay.url)}" data-ext>Перейти к оплате</a>
      <p class="muted" style="font-size:13px;margin-top:16px">Ждём подтверждение оплаты…</p>
    </div>`;
  }
  async function checkPaid() {
    const pay = state.payment;
    if (!pay || !location.hash.startsWith("#/pay/")) { clearInterval(payPoll); payPoll = null; return; }
    try {
      const st = await api(`/api/orders/${pay.id}/status`);
      if (st.paid) { clearInterval(payPoll); payPoll = null; state.payment = null; haptic("ok"); loadProfile(); location.hash = `#/done/${pay.id}?paid=1`; }
      else if (st.status === "cancel") { clearInterval(payPoll); payPoll = null; state.payment = null; toast("Заказ отменён: оплата не поступила"); location.hash = "#/profile"; }
    } catch (e) { /* keep polling */ }
  }

  /* ---------------- payment by transfer to the shop's card ---------------- */
  function viewTransfer(id) {
    const t = state.transfer && String(state.transfer.id) === String(id) ? state.transfer : null;
    if (!t) {
      if (!state.transferLoading) {
        state.transferLoading = true;
        api(`/api/orders/${encodeURIComponent(id)}/transfer`).then((d) => { state.transfer = d; }).catch((e) => { state.transfer = { id, error: e.message }; }).finally(() => { state.transferLoading = false; render(); });
      }
      return `<div class="page empty"><p class="muted">Загружаем реквизиты…</p></div>`;
    }
    if (t.error) return `<div class="page empty"><h1 class="display">Оплата заказа №${esc(id)}</h1><p>${esc(t.error)}</p><a class="btn" href="#/profile">Мои заказы</a></div>`;
    if (t.paid) return `<div class="page empty"><h1 class="display">Заказ №${esc(id)} оплачен</h1><p>Оплата получена ✅ Спасибо!</p><a class="btn" href="#/">На главную</a></div>`;
    if (!t.payable) return `<div class="page empty"><h1 class="display">Заказ №${esc(id)}</h1><p>Реквизиты для оплаты пришлём после подтверждения заказа.</p><a class="btn" href="#/profile">Мои заказы</a></div>`;
    const row = (label, value, copy) => value ? `<div class="req-row"><span>${label}</span><b>${esc(value)}</b>${copy ? `<button class="btn soft small" data-action="copyText" data-text="${esc(copy)}">Копировать</button>` : ""}</div>` : "";
    return `<div class="page">
      <h1 class="display" style="font-size:34px;margin-top:8px">Оплата</h1>
      <p class="lead">Заказ №${esc(id)} · перевод на карту или по СБП</p>
      <div class="pay-card">
        <div class="pay-sum">${rub(t.amount)}</div>
        ${row("Карта", t.card, t.card.replace(/\s/g, ""))}
        ${row("СБП по номеру", t.phone, t.phone.replace(/[^\d+]/g, ""))}
        ${row("Банк", t.bank)}
        ${row("Получатель", t.holder)}
        ${t.note ? `<p class="muted" style="font-size:13px;margin:10px 0 0">${esc(t.note)}</p>` : ""}
        ${t.claimed ? `<div class="info-card" style="margin-top:14px"><p><b>Вы сообщили об оплате</b></p><p class="muted" style="font-size:13.5px;margin-top:4px">Менеджер проверит поступление и подтвердит — сообщение придёт в чат.</p></div>`
          : `<button class="btn block" style="margin-top:16px" data-action="transferDone" data-id="${esc(id)}" ${t.sending ? "disabled" : ""}>${t.sending ? "Отправляем…" : "Я оплатил(а)"}</button>`}
        <a class="btn ghost block" style="margin-top:8px" href="#/profile">${t.claimed ? "Мои заказы" : "Оплачу позже"}</a>
      </div>
      <p class="muted" style="font-size:12.5px;margin-top:12px">Переведите точную сумму. «Я оплатил(а)» — нажмите после перевода: менеджер получит уведомление.${t.claimed ? "" : " Реквизиты всегда можно открыть снова: Профиль → Мои заказы → «Оплатить»."}</p>
    </div>`;
  }

  /* ---------------- profile ---------------- */
  function viewProfile() {
    if (!host && !window.__MOCK) return `<div class="page empty"><h1 class="display">Профиль</h1><p>Откройте магазин через бота в ${HOST_NAME}, чтобы видеть бонусы и заказы.</p></div>`;
    const p = state.profile;
    if (!p) { loadProfile(); return `<div class="page"><h1 class="display" style="font-size:36px;margin-top:8px">Профиль</h1><p class="muted">Загружаем…</p></div>`; }
    const L = LOY();
    const lv = p.level;
    const orders = p.orders;
    return `<div class="page">
      <h1 class="display" style="font-size:36px;margin-top:8px">${esc(p.name || "Профиль")}</h1>
      ${feat("bonuses") ? loyaltyCard(p, false) + `<p class="muted" style="font-size:13px;margin:10px 2px 0">Начисляем ${lv.percent}% от суммы выполненного заказа. Бонусами можно оплатить до ${L.maxPayPercent}% заказа. ${feat("burn") ? `Бонусы действуют ${L.burnDays} дней.` : ""}</p>` : ""}
      ${feat("bonuses") && feat("levels") ? `<div class="levels">${L.levels.map((x) => `<div class="${x.name === lv.name ? "on" : ""}"><b>${esc(x.name)}</b><span>${x.percent}%</span><small>${x.from ? "от " + rub(x.from) : "сразу"}</small></div>`).join("")}</div>` : ""}

      ${feat("referral") && p.refLink ? `<h2 class="h2">Пригласите друга</h2>
      <div class="info-card"><p>Другу — <b>${L.referral.friendBonus} бонусов</b> на первый заказ, вам — <b>${L.referral.referrerBonus}</b>, когда он его получит.</p>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn small" data-action="shareRef">Поделиться</button><button class="btn soft small" data-action="copyRef">Скопировать ссылку</button></div></div>` : ""}

      ${feat("dates") ? `<h2 class="h2">Важные даты</h2>
      <p class="muted" style="font-size:13.5px;margin:-4px 0 8px">Напомним заранее, чтобы подарок был готов вовремя.</p>
      ${p.dates.map((d) => { const [mm, dd] = d.md.split("-"); const n = daysUntil(d.md); return `<div class="date-row"><span>🎂</span><span><b>${esc(d.title)}</b><small>${+dd} ${MONTHS[+mm - 1]} · ${n === 0 ? "сегодня" : "через " + n + " " + plural(n, "день", "дня", "дней")}</small></span><button class="icon-x" data-action="delDate" data-id="${esc(d.id)}" aria-label="Удалить">×</button></div>`; }).join("")}
      <form data-form="date" class="date-form">
        <input class="input" name="title" placeholder="Например: ДР мамы" maxlength="60" required>
        <div style="display:grid;grid-template-columns:90px 1fr;gap:8px;margin-top:8px">
          <select class="input" name="day">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}</select>
          <select class="input" name="month">${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("")}</select>
        </div>
        <button class="btn soft block" type="submit" style="margin-top:8px">Добавить дату</button>
      </form>` : ""}

      <h2 class="h2">Мои заказы</h2>
      ${orders.length ? orders.map((o) => `<div class="order">
        <div class="h"><span>№${o.id} · ${rub(o.total)}</span><span class="status">${STATUS_CLIENT[o.status] || o.status}${o.paid ? " · оплачен" : ""}</span></div>
        <div class="muted" style="font-size:13px">${ddmm(o.createdAt)} · ${esc(o.lines.map((l) => l.title + " × " + l.qty).join(", "))}</div>
        ${o.bonusAccrued ? `<div style="font-size:13px;margin-top:4px">💎 +${o.bonusAccrued} бонусов</div>` : ""}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          ${feat("repeat") ? `<button class="btn soft small" data-action="repeatOrder" data-id="${o.id}">Повторить</button>` : ""}
          ${o.status === "pay" && !o.paid ? `<button class="btn small" data-action="retryPay" data-id="${o.id}">Оплатить</button>` : ""}
          ${o.transferPayable && !o.transferClaimed ? `<a class="btn small" href="#/transfer/${o.id}" data-action="openTransfer" data-id="${o.id}">Оплатить ${rub(o.toPay)}</a>` : ""}
          ${o.transferPayable && o.transferClaimed ? `<span class="muted" style="font-size:13px;align-self:center">💳 Оплата на проверке</span>` : ""}
          ${o.giftLink ? `<button class="btn ghost small" data-action="sendGift" data-link="${esc(o.giftLink)}">🎁 Открытка</button>` : ""}
        </div></div>`).join("") : `<p class="muted">Здесь появятся ваши заказы.</p>`}
      ${RVS() && orders.length ? `<a class="btn soft block" style="margin-top:12px" href="#/review">⭐ Оценить букет${rvBonus() ? ` · +${rvBonus()} бонусов` : ""}</a>` : ""}

      ${feat("broadcasts") ? `<label class="check" style="margin-top:22px"><input type="checkbox" data-action="toggleConsent" ${p.consent ? "checked" : ""}><span>Присылать акции, напоминания о датах и бонусах</span></label>` : ""}
      ${feat("bonuses") && p.history.length ? `<details class="history"><summary>История бонусов</summary>${p.history.map((h) => `<div class="addon"><span class="t">${esc(h.note || h.kind)}<br><small class="muted">${ddmm(h.at)}</small></span><span class="p" style="color:${h.delta > 0 ? "var(--accent)" : "var(--muted)"}">${h.delta > 0 ? "+" : ""}${h.delta}</span></div>`).join("")}</details>` : ""}
      <a class="btn ghost block" style="margin-top:22px" href="#/about">${esc(state.catalog.settings.aboutLabel || "О мастерской")}</a>
    </div>`;
  }

  /* ---------------- reviews (QR on the card in a bouquet → «Как вам букет?») ---------------- */
  const RVS = () => state.catalog.reviews;
  const rvBonus = () => (RVS() && RVS().bonus) || 0;
  const starLine = (n) => `<span class="stars-ro" aria-label="${n} из 5">${"★".repeat(n)}<i>${"★".repeat(5 - n)}</i></span>`;
  const rvDate = (iso) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "numeric", month: "long" }).format(new Date(iso));
  const avgText = (n) => String(n).replace(".", ",");
  function reviewCard(r) {
    return `<div class="review-card"><div class="rc-h"><b>${esc(r.name)}</b>${starLine(r.rating)}</div>
      ${r.text ? `<p>${esc(r.text)}</p>` : ""}
      ${r.photos && r.photos.length ? `<div class="rc-pics">${r.photos.map((u) => `<a href="${esc(u)}" data-ext>${imgTag(u, 240, "Фото от покупателя")}</a>`).join("")}</div>` : ""}
      ${r.reply ? `<div class="rc-reply"><b>${esc(state.catalog.settings.brand)}:</b> ${esc(r.reply)}</div>` : ""}
      <small class="muted">${rvDate(r.at)}</small></div>`;
  }
  /** Home page block: rating and the latest reviews (only when there are published ones). */
  function homeReviews() {
    const R = RVS();
    if (!R || !R.count) return "";
    return `<h2 class="h2">Отзывы <span class="rv-avg">★ ${avgText(R.avg)}</span></h2>
      ${R.latest.map(reviewCard).join("")}
      <a class="btn soft block" style="margin-top:12px" href="#/reviews">Все отзывы · ${R.count}</a>`;
  }
  function viewReviews() {
    const d = state.reviewsList;
    if (!d && !state.reviewsLoading) { state.reviewsLoading = true; api("/api/reviews").then((x) => { state.reviewsList = x; state.reviewsLoading = false; render(); }).catch((e) => { state.reviewsLoading = false; toast(e.message); }); }
    return `<div class="page">
      <h1 class="display" style="font-size:36px;margin-top:8px">Отзывы</h1>
      ${d && d.count ? `<p class="lead">★ ${avgText(d.avg)} · ${d.count} ${plural(d.count, "отзыв", "отзыва", "отзывов")}</p>` : ""}
      ${RVS() ? `<a class="btn block" style="margin:14px 0 18px" href="#/review">Оставить отзыв${rvBonus() ? ` · +${rvBonus()} бонусов` : ""}</a>` : ""}
      ${!d ? `<p class="muted">Загружаем…</p>` : d.list.length ? d.list.map(reviewCard).join("") : `<p class="muted">Отзывов пока нет — будьте первым!</p>`}
    </div>`;
  }
  function rvForm() { return state.rv || (state.rv = { rating: 0, text: "", photos: [], consent: false, sending: false, done: null, err: "" }); }
  function viewReviewForm() {
    if (!RVS()) return `<div class="page empty"><h1 class="display">Спасибо!</h1><p>Будем рады видеть вас снова.</p><a class="btn" href="#/catalog/all">В каталог</a></div>`;
    const f = rvForm(), s = state.catalog.settings, bonus = rvBonus();
    if (f.done) {
      const good = f.done.status !== "private";
      return `<div class="page" style="text-align:center">
        <div class="success-mark"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
        <h1 class="display" style="font-size:32px">${good ? "Спасибо за отзыв!" : "Спасибо, что рассказали честно"}</h1>
        <p class="lead">${good ? "Нам очень приятно 💐 Отзыв появится в приложении после проверки." : "Мы уже передали отзыв владельцу — с вами свяжутся и всё исправят."}</p>
        ${f.done.bonus ? `<div class="info-card" style="margin-top:16px;text-align:left"><p>🎁 Начислили <b>${f.done.bonus} ${plural(f.done.bonus, "бонус", "бонуса", "бонусов")}</b> — ими можно оплатить часть следующего заказа.</p></div>` : ""}
        ${good && f.done.link2gis ? `<div class="info-card" style="margin-top:12px;text-align:left"><p><b>Поделитесь отзывом и в 2ГИС?</b></p>
          <p class="muted" style="font-size:13px;margin-top:4px">Это очень поможет магазину. Мы скопируем ваш текст — останется вставить его и нажать «Отправить».</p>
          <button class="btn block" style="margin-top:10px" data-action="rv2gis">Скопировать и открыть 2ГИС</button></div>` : ""}
        <a class="btn ghost block" style="margin-top:12px" href="#/catalog/all">В каталог</a>
      </div>`;
    }
    if (!host && !window.__MOCK) return `<div class="page empty"><h1 class="display">Оцените букет</h1><p>Откройте магазин через бота в ${HOST_NAME}, чтобы оставить отзыв.</p></div>`;
    return `<div class="page">
      <h1 class="display" style="font-size:34px;margin-top:8px">Как вам букет?</h1>
      <p class="lead">Оцените его, даже если букет вам подарили 💐${bonus ? ` За честный отзыв дарим <b>${bonus} бонусов</b> на ваш заказ в ${esc(s.brand)}.` : ""}</p>
      <form data-form="review" novalidate>
      <div class="stars" role="radiogroup" aria-label="Оценка">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star ${n <= f.rating ? "on" : ""}" data-action="rvStar" data-n="${n}" role="radio" aria-checked="${n === f.rating}" aria-label="${n} из 5">★</button>`).join("")}</div>
      <p class="muted" style="text-align:center;font-size:13px;margin:4px 0 0">${["Нажмите на звезду", "Очень плохо", "Плохо", "Нормально", "Хорошо", "Отлично!"][f.rating]}</p>
      <label class="field"><span>${f.rating && f.rating <= 3 ? "Что не понравилось? Мы обязательно разберёмся" : "Пара слов о букете (по желанию)"}</span>
        <textarea class="input" name="text" maxlength="1500" data-input="rvText" placeholder="Например: свежие цветы, красиво упаковали, привезли вовремя">${esc(f.text)}</textarea></label>
      <div class="field"><span>Фото букета (по желанию, до 3)</span>
        <div class="photo-grid">${f.photos.map((u, i) => `<div class="photo-tile">${imgTag(u, 240, "")}<button type="button" class="pt-del" data-action="rvPhotoDel" data-i="${i}" aria-label="Убрать фото">×</button></div>`).join("")}
        ${f.photos.length < 3 ? `<label class="photo-add"><input type="file" accept="image/*" data-review-upload hidden><b>+</b><small>Добавить фото</small></label>` : ""}</div></div>
      ${feat("broadcasts") ? `<label class="check"><input type="checkbox" data-input="rvConsent" ${f.consent ? "checked" : ""}><span>Присылать акции и бонусы в ${HOST_NAME}</span></label>` : ""}
      ${f.err ? `<p class="err">${esc(f.err)}</p>` : ""}
      <button class="btn block" type="submit" style="margin-top:18px" ${f.sending ? "disabled" : ""}>${f.sending ? "Отправляем…" : "Отправить отзыв"}</button>
      </form></div>`;
  }
  async function uploadReviewPhoto(file) {
    const body = await shrinkPhoto(file);
    if (body.size > 4e6) throw new Error("Фото слишком большое — выберите другое");
    const res = await fetch("/api/reviews/photo", { method: "POST", headers: { "Content-Type": body.type || "application/octet-stream", "X-Init-Data": INIT_DATA }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Не удалось загрузить фото");
    return data.url;
  }
  function openExternal(u) {
    if (tg) { /^https:\/\/t\.me\//.test(u) ? tg.openTelegramLink(u) : tg.openLink(u); return; }
    if (mx) { try { mx.openLink(u); return; } catch (e) { /* fall through */ } }
    window.open(u, "_blank");
  }

  function viewAbout() {
    const s = state.catalog.settings;
    return `<div class="page">
      <h1 class="display" style="font-size:38px;margin-top:8px">${esc(s.tagline || s.brand)}</h1>
      <p class="lead">${esc(s.brand)}, ${esc(s.city || "Иркутск")}. ${esc(s.hours)}</p>
      <div style="margin-top:20px">${s.about.map((t) => `<div class="info-block"><p style="color:var(--text);font-size:15px">${esc(t)}</p></div>`).join("")}</div>
      <h2 class="h2">Доставка и оплата</h2>
      ${s.delivery.map((t) => `<div class="info-block"><p>${esc(t)}</p></div>`).join("")}
      <p class="muted" style="font-size:12px;margin-top:24px">${esc(s.legal)}</p>
    </div>`;
  }

  function viewContacts() {
    const s = state.catalog.settings;
    const tel = s.phone.replace(/[^\d+]/g, "");
    return `<div class="page">
      <h1 class="display" style="font-size:38px;margin-top:8px">Контакты</h1>
      <p class="lead">${esc(s.hours)}. Менеджер отвечает в течение 10 минут.</p>
      <div style="margin-top:18px">
        ${s.phone ? `<a class="contact-row" href="tel:${esc(tel)}"><span>Телефон</span><b>${esc(s.phone)}</b></a>` : ""}
        ${s.address ? `<a class="contact-row" href="${esc(s.map2gis)}" data-ext><span>${esc(s.placeLabel || "Мастерская")}</span><b>${esc(s.address)}</b></a>` : ""}
        ${s.email ? `<a class="contact-row" href="mailto:${esc(s.email)}"><span>Почта</span><b>${esc(s.email)}</b></a>` : ""}
        ${s.socials.map((x) => `<a class="contact-row" href="${esc(x.url)}" data-ext><span>${esc(x.title)}</span><b>Открыть</b></a>`).join("")}
      </div>
      <a class="btn block" style="margin-top:20px" href="${esc(s.mapRoute || s.map2gis)}" data-ext>Построить маршрут в 2ГИС</a>
      ${s.mapYandex ? `<a class="btn ghost block" style="margin-top:10px" href="${esc(s.mapYandex)}" data-ext>Маршрут в Яндекс Картах</a>` : ""}
      <a class="btn ghost block" style="margin-top:10px" href="#/about">${esc(s.aboutLabel || "О мастерской")}, доставка и оплата</a>
      ${RVS() ? `<a class="btn ghost block" style="margin-top:10px" href="#/reviews">Отзывы${RVS().count ? ` · ★ ${avgText(RVS().avg)}` : ""}</a>` : ""}
      ${s.socials.some((x) => /instagram/i.test(x.title)) ? `<p class="muted" style="font-size:11.5px;margin-top:18px">*Instagram принадлежит компании Meta, деятельность которой запрещена в РФ.</p>` : ""}
      ${s.madeBy && s.madeBy.text ? `<p class="muted made-by" style="font-size:12px;margin-top:22px;text-align:center">${esc(s.madeBy.text)}${s.madeBy.url ? `<br><a href="${esc(s.madeBy.url)}" data-ext style="color:inherit;font-weight:700">${esc(s.madeBy.linkText || s.madeBy.url)}</a>` : ""}</p>` : ""}
    </div>`;
  }

  /* ---------------- admin ---------------- */
  async function loadAdmin(tab) {
    state.admin.loadingTab = tab;
    let data;
    try {
      if (tab === "orders") data = await api("/api/admin/orders");
      else if (tab === "stats") data = await api("/api/admin/stats");
      else if (tab === "customers") data = await api(`/api/admin/customers?segment=${encodeURIComponent(state.admin.segment)}&q=${encodeURIComponent(state.admin.cq)}`);
      else if (tab === "promo") data = await api("/api/admin/sources");
      else if (tab.startsWith("customer/")) data = await api(`/api/admin/customers/${encodeURIComponent(tab.slice(9))}`);
      else if (tab === "staff") data = await api("/api/admin/staff");
      else if (tab === "reviews") data = await api("/api/admin/reviews");
      else if (tab === "broadcast") {
        const [h, ...counts] = await Promise.all([api("/api/admin/broadcasts"), ...["all", "regular", "new", "sleeping"].map((sg) => api("/api/admin/broadcast/preview?segment=" + sg))]);
        data = { list: h.list, counts: { all: counts[0].count, regular: counts[1].count, new: counts[2].count, sleeping: counts[3].count } };
      }
      else data = await api("/api/admin/catalog");
    } catch (e) { data = { error: e.message }; }
    state.admin.data = data;
    state.admin.tab = tab;
    state.admin.loadingTab = null;
    render();
  }
  function adminTabs(active) {
    const owner = !!state.me.isOwner;
    const tabs = [["orders", "Заявки"], owner && ["pay", "💳 Оплата"], owner && ["staff", "👤 Сотрудники"], ["customers", "Клиенты"], ["reviews", "⭐ Отзывы"], ["products", "Товары"], ["categories", "Категории"], ["extras", "Допы и промо"], ["broadcast", "Рассылки"], ["promo", "Ссылки и QR"], owner && ["loyalty", "Бонусы"], owner && ["settings", "Настройки"], ["stats", "Статистика"]].filter(Boolean);
    return `<div class="admin-tabs">${tabs.map(([k, t]) => `<button class="chip" aria-pressed="${k === active}" data-action="adminTab" data-tab="${k}">${t}</button>`).join("")}</div>`;
  }
  function viewAdmin(tab, arg) {
    if (!state.me.isAdmin) return `<div class="page empty"><h1 class="display">Нет доступа</h1><p>Панель управления видна только администраторам.</p></div>`;
    const key = tab === "customer" ? "customer/" + arg : tab === "pay" ? "loyalty" : tab;
    const fresh = state.admin.tab === key && state.admin.data;
    if (!fresh && state.admin.loadingTab !== key) setTimeout(() => loadAdmin(key));
    const d = fresh ? state.admin.data : null;
    let body = `<p class="muted">Загружаем…</p>`;
    if (d && d.error) body = `<p class="err">${esc(d.error)}</p>`;
    else if (d) body = ({ pay: adminTransfer, staff: adminStaff, orders: adminOrders, products: adminProducts, categories: adminCategories, extras: adminExtras, settings: adminSettings, stats: adminStats, edit: adminEdit, customers: adminCustomers, customer: adminCustomer, broadcast: adminBroadcast, loyalty: adminLoyalty, promo: adminPromo, reviews: adminReviews }[tab] || adminOrders)(d, arg);
    return `<div class="page"><h1 class="display" style="font-size:34px;margin-top:8px">Управление</h1>${tab === "edit" || tab === "customer" ? "" : adminTabs(tab)}${body}</div>`;
  }
  function payBadge(o) {
    if (o.payMethod !== "transfer") return "";
    if (o.paid) return `<div class="pay-badge ok">✅ Оплата получена (перевод)</div>`;
    if (o.transferClaimedAt) return `<div class="pay-badge claim">💳 Клиент сообщил об оплате ${ddmm(o.transferClaimedAt)} в ${new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(new Date(o.transferClaimedAt))} — проверьте в банке</div>`;
    return `<div class="pay-badge wait">💳 Перевод: ${o.transferMode === "after" ? "реквизиты уйдут клиенту после «В работе»" : "ждём оплату"}</div>`;
  }
  function adminOrders(d) {
    if (!d.orders.length) return `<div class="empty"><p>Заявок пока нет. Они появятся здесь и придут вам в ${HOST_NAME}.</p></div>`;
    return d.orders.map((o) => {
      const pics = [...new Set(o.totals.lines.map((l) => l.image).filter(Boolean))].slice(0, 6);
      return `<div class="order">
      <div class="h"><span>№${o.id} · ${rub(o.totals.total)}</span><span class="status">${STATUS[o.status] || o.status}${o.paid ? " · ✅ оплачен" : ""}</span></div>
      ${pics.length ? `<div class="order-pics">${pics.map((u) => `<a href="${esc(u)}" data-ext>${imgTag(u, 240, "")}</a>`).join("")}</div>` : ""}
      <pre>${esc(o.summary)}</pre>
      ${payBadge(o)}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${o.payMethod === "transfer" && !o.paid && o.status !== "cancel" ? `<button class="btn small" data-action="orderPaid" data-id="${o.id}">Оплата получена</button>` : ""}
        <a class="btn soft small" href="tel:${esc(o.phone)}">Позвонить</a>
        ${Object.entries(STATUS).filter(([k]) => k !== o.status && k !== "pay").map(([k, t]) => `<button class="btn ghost small" data-action="orderStatus" data-id="${o.id}" data-s="${k}">${k === "work" && o.status === "new" ? "Подтвердить" : t}</button>`).join("")}
      </div></div>`;
    }).join("");
  }
  function adminProducts(d) {
    const q = state.admin.search.toLowerCase();
    const list = d.products.slice().sort((a, b) => a.sort - b.sort).filter((p) => !q || p.title.toLowerCase().includes(q));
    return `<div style="display:flex;gap:8px;margin-bottom:6px"><button class="btn small" data-action="go" data-to="#/admin/edit/new">Добавить товар</button>
      ${d.settings.tildaParts ? `<button class="btn soft small" data-action="importSite">Обновить с сайта</button>` : ""}</div>
      <input class="search" type="search" placeholder="Поиск товара" value="${esc(state.admin.search)}" data-input="adminSearch">
      ${list.map((p) => `<div class="admin-row ${p.hidden ? "is-hidden" : ""}">${imgTag(p.images[0], 120, "")}
        <a href="#/admin/edit/${esc(p.id)}" style="text-decoration:none"><div class="t">${esc(p.title)}</div><div class="s">${rub(p.price)}${p.hidden ? " · скрыт" : ""}</div></a>
        <div class="mini"><button data-action="move" data-coll="products" data-id="${esc(p.id)}" data-dir="-1" aria-label="Выше">↑</button><button data-action="move" data-coll="products" data-id="${esc(p.id)}" data-dir="1" aria-label="Ниже">↓</button>
        <button data-action="toggleHidden" data-coll="products" data-id="${esc(p.id)}" aria-label="${p.hidden ? "Показать" : "Скрыть"}">${p.hidden ? "◌" : "●"}</button></div></div>`).join("")}`;
  }
  function adminEdit(d, id) {
    const isNew = id === "new";
    const p = isNew ? { id: "", title: "", price: 0, oldPrice: null, short: "", intro: "", details: [], images: [], cats: [], chocolateChoices: 0, hidden: false } : d.products.find((x) => String(x.id) === String(id));
    if (!p) return `<p class="err">Товар не найден</p>`;
    return `<a class="btn ghost small" href="#/admin/products">Назад к товарам</a>
      <form data-form="product" data-id="${esc(p.id)}" style="margin-top:6px">
      <label class="field"><span>Название</span><input class="input" name="title" value="${esc(p.title)}" required></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Цена, ₽</span><input class="input" name="price" type="number" min="0" value="${p.price}" required></label>
        <label class="field"><span>Старая цена, ₽</span><input class="input" name="oldPrice" type="number" min="0" value="${p.oldPrice || ""}"></label></div>
      <label class="field"><span>Короткое описание</span><input class="input" name="short" value="${esc(p.short)}"></label>
      <label class="field"><span>Описание</span><textarea class="input" name="intro">${esc(p.intro)}</textarea></label>
      <label class="field"><span>Состав и детали (каждый пункт с новой строки)</span><textarea class="input" name="details" style="min-height:120px">${esc(p.details.join("\n"))}</textarea></label>
      <div class="field"><span>Фото</span>
        <div class="photo-grid" data-photos>${p.images.map(photoTile).join("")}<label class="photo-add"><input type="file" accept="image/*" multiple data-upload hidden><b>+</b><small>Добавить из галереи</small></label></div>
        <div class="muted" style="font-size:12.5px;margin-top:6px">Первое фото — главное, его видно в каталоге. Стрелкой ‹ можно передвинуть фото левее.</div>
        <details style="margin-top:8px"><summary class="muted" style="font-size:13px">Добавить фото по ссылке</summary>
          <div style="display:flex;gap:8px;margin-top:8px"><input class="input" data-photo-link placeholder="https://…" style="min-height:42px"><button type="button" class="btn soft small" data-action="addPhotoLink">Добавить</button></div></details>
      </div>
      ${(d.chocolates || []).length ? `<label class="field"><span>Сколько видов шоколада можно выбрать (0 — без выбора)</span><input class="input" name="chocolateChoices" type="number" min="0" max="6" value="${p.chocolateChoices || 0}"></label>` : `<input type="hidden" name="chocolateChoices" value="0">`}
      <div class="field"><span>Категории</span>${d.categories.map((c) => `<label class="check" style="margin-top:8px;color:var(--text)"><input type="checkbox" name="cats" value="${esc(c.id)}" ${p.cats.includes(c.id) ? "checked" : ""}>${esc(c.title)}</label>`).join("")}</div>
      <label class="check" style="color:var(--text)"><input type="checkbox" name="hidden" ${p.hidden ? "checked" : ""}>Скрыть из каталога</label>
      <button class="btn block" style="margin-top:18px" type="submit">${isNew ? "Создать товар" : "Сохранить изменения"}</button>
      ${isNew ? "" : `<button class="btn ghost block" style="margin-top:10px" type="button" data-action="deleteProduct" data-id="${esc(p.id)}">Удалить товар</button>`}
      </form>`;
  }
  function photoTile(u) {
    return `<div class="photo-tile" data-url="${esc(u)}">${imgTag(u, 240, "")}
      <button type="button" class="pt-left" data-action="photoLeft" aria-label="Сделать левее">‹</button><button type="button" class="pt-del" data-action="photoDel" aria-label="Убрать фото">×</button></div>`;
  }
  /** Shrinks a photo from the phone (they are 3–10 MB) to ≤1600 px JPEG before sending; falls back to the original file. */
  async function shrinkPhoto(file) {
    try {
      const url = URL.createObjectURL(file);
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
      if (blob) return blob;
    } catch (e) { /* use the original */ }
    return file;
  }
  async function uploadPhoto(file) {
    const body = await shrinkPhoto(file);
    if (body.size > 4e6) throw new Error("Фото слишком большое — выберите другое");
    const res = await fetch("/api/admin/upload", { method: "POST", headers: { "Content-Type": body.type || "application/octet-stream", "X-Init-Data": INIT_DATA }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Не удалось загрузить фото");
    return data.url;
  }
  function adminCategories(d) {
    return `<button class="btn small" data-action="addCategory" style="margin-bottom:8px">Добавить категорию</button>
      ${d.categories.slice().sort((a, b) => a.sort - b.sort).map((c) => `<div class="admin-row ${c.hidden ? "is-hidden" : ""}" style="grid-template-columns:1fr auto">
      <input class="input" style="min-height:42px" value="${esc(c.title)}" data-rename="${esc(c.id)}" aria-label="Название категории">
      <div class="mini"><button data-action="move" data-coll="categories" data-id="${esc(c.id)}" data-dir="-1" aria-label="Выше">↑</button><button data-action="move" data-coll="categories" data-id="${esc(c.id)}" data-dir="1" aria-label="Ниже">↓</button>
      <button data-action="toggleHidden" data-coll="categories" data-id="${esc(c.id)}" aria-label="${c.hidden ? "Показать" : "Скрыть"}">${c.hidden ? "◌" : "●"}</button></div></div>`).join("")}
      <p class="muted" style="font-size:12.5px">Название сохраняется, когда вы уходите из поля.</p>`;
  }
  function adminExtras(d) {
    return `<h2 class="h2" style="font-size:24px;margin-top:10px">Допы в корзине</h2>
      ${d.addons.map((a) => `<div class="admin-row ${a.hidden ? "is-hidden" : ""}" style="grid-template-columns:1fr 96px auto">
        <div class="t">${esc(a.title)}</div><input class="input" style="min-height:40px" type="number" min="0" value="${a.price}" data-addon-price="${esc(a.id)}" aria-label="Цена">
        <div class="mini"><button data-action="toggleHidden" data-coll="addons" data-id="${esc(a.id)}">${a.hidden ? "◌" : "●"}</button></div></div>`).join("")}
      <h2 class="h2" style="font-size:24px">Промокоды</h2>
      <form data-form="promos">
      ${d.promos.map((p, i) => `<div class="admin-row" style="grid-template-columns:1fr 70px auto">
        <input class="input" name="code_${i}" value="${esc(p.code)}" style="min-height:40px" aria-label="Код"><input class="input" name="percent_${i}" type="number" min="1" max="90" value="${p.percent}" style="min-height:40px" aria-label="Скидка, %">
        <label class="check" style="margin:0;font-size:12px"><input type="checkbox" name="active_${i}" ${p.active !== false ? "checked" : ""}>вкл</label>
        <input type="hidden" name="first_${i}" value="${p.firstOrderOnly ? 1 : 0}"></div>`).join("")}
      <div class="admin-row" style="grid-template-columns:1fr 70px auto"><input class="input" name="code_new" placeholder="Новый код" style="min-height:40px"><input class="input" name="percent_new" type="number" placeholder="%" style="min-height:40px"><span></span></div>
      <button class="btn block" type="submit" style="margin-top:12px">Сохранить промокоды</button></form>`;
  }
  function zoneRow(z) {
    z = z || { id: "", name: "", price: "", freeFrom: "", from: "", to: "" };
    return `<div class="zone-row" data-zid="${esc(z.id)}">
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px"><input class="input" name="zname" value="${esc(z.name)}" placeholder="Например: Октябрьский" maxlength="60" aria-label="Название района">
        <button type="button" class="icon-x" data-action="delZone" aria-label="Удалить район">×</button></div>
      <div class="zone-grid">
        <label><span>Доставка, ₽</span><input class="input" name="zprice" type="number" min="0" value="${z.price === "" ? "" : z.price}" placeholder="300"></label>
        <label><span>Бесплатно от, ₽</span><input class="input" name="zfree" type="number" min="0" value="${z.freeFrom || ""}" placeholder="—"></label>
        <label><span>Время от, мин</span><input class="input" name="zfrom" type="number" min="0" max="1440" value="${z.from || ""}" placeholder="40"></label>
        <label><span>до, мин</span><input class="input" name="zto" type="number" min="0" max="1440" value="${z.to || ""}" placeholder="60"></label>
      </div></div>`;
  }
  function adminZones(s) {
    return `<form data-form="zones" class="zones-form">
      <h2 class="h2" style="font-size:22px;margin-top:6px">Районы доставки</h2>
      <p class="muted" style="font-size:13px;margin:-4px 0 6px">Клиент при доставке сначала выбирает район: цена сразу добавляется к заказу, а время показываем только то, к которому успеете. Нет районов — доставку считает менеджер, как раньше.</p>
      <div data-zones>${(s.zones || []).map(zoneRow).join("")}</div>
      <button type="button" class="btn soft block" style="margin-top:10px" data-action="addZone">+ Добавить район</button>
      <button class="btn block" type="submit" style="margin-top:10px">Сохранить районы</button>
    </form>`;
  }
  function adminSettings(d) {
    const s = d.settings;
    return `${adminZones(s)}<h2 class="h2" style="font-size:22px">Магазин</h2><form data-form="settings">
      <label class="field"><span>Заголовок на главной</span><input class="input" name="banner.title" value="${esc(s.banner.title)}"></label>
      <label class="field"><span>Текст под заголовком</span><input class="input" name="banner.text" value="${esc(s.banner.text)}"></label>
      <div class="field"><span>Фото на главной</span>
        <div style="display:grid;grid-template-columns:72px 1fr;gap:10px;align-items:center"><div class="photo-tile" style="width:72px;height:72px" data-banner-preview>${imgTag(s.banner.image, 240, "")}</div>
        <label class="btn soft small" style="justify-self:start"><input type="file" accept="image/*" hidden data-upload-to="banner.image">Загрузить из галереи</label></div>
        <input type="hidden" name="banner.image" value="${esc(s.banner.image)}"></div>
      <label class="field"><span>Телефон</span><input class="input" name="phone" value="${esc(s.phone)}"></label>
      <label class="field"><span>Адрес</span><input class="input" name="address" value="${esc(s.address)}"></label>
      <label class="field"><span>Режим работы</span><input class="input" name="hours" value="${esc(s.hours)}"></label>
      <label class="field"><span>Время готовности (через запятую)</span><input class="input" name="timeSlots" value="${esc(s.timeSlots.join(", "))}"></label>
      <label class="field"><span>Куда присылать заявки — ID в ${HOST_NAME} через запятую</span><input class="input" name="managerChatIds" value="${esc((s.managerChatIds || []).join(", "))}" placeholder="Напишите боту /id, чтобы узнать свой ID"></label>
      <label class="field"><span>${esc(s.aboutLabel || "О мастерской")} (каждый абзац с новой строки)</span><textarea class="input" name="about" style="min-height:120px">${esc(s.about.join("\n"))}</textarea></label>
      <label class="field"><span>Доставка и оплата (каждый пункт с новой строки)</span><textarea class="input" name="delivery" style="min-height:120px">${esc(s.delivery.join("\n"))}</textarea></label>
      <label class="field"><span>Текст после отправки заявки</span><textarea class="input" name="successText">${esc(s.successText)}</textarea></label>
      <button class="btn block" type="submit" style="margin-top:16px">Сохранить настройки</button>
      <button class="btn ghost block" type="button" style="margin-top:10px" data-action="testNotify">Отправить тестовую заявку себе</button>
      </form>${backupBlock()}`;
  }
  /** «Резервные копии»: every night the app sends a copy of all data to the owner's bot chat and keeps 14 on the server. */
  function backupBlock() {
    const b = state.admin.backup;
    if (!b && !state.admin.backupLoading) { state.admin.backupLoading = true; api("/api/admin/backup").then((x) => { state.admin.backup = x; state.admin.backupLoading = false; render(); }).catch(() => { state.admin.backupLoading = false; }); }
    const dt = (iso) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    return `<h2 class="h2" style="font-size:22px">Резервные копии</h2>
      <div class="info-card"><p>Каждую ночь после 3:00 приложение сохраняет копию всех данных — клиенты, заказы, бонусы, отзывы, каталог, настройки и фото. Копия приходит в чат с ботом${b && b.to ? "" : " владельцу"}, ещё 14 последних хранятся на сервере.</p>
        ${!b ? `<p class="muted" style="font-size:13px;margin-top:8px">Загружаем…</p>` : `<p style="font-size:13.5px;margin-top:10px">${b.lastAt ? `Последняя копия: <b>${dt(b.lastAt)}</b>${b.lastSent ? " · отправлена в чат ✅" : ""}` : "Копий ещё не было — первая будет сегодня ночью."}<br><span class="muted">На сервере: ${b.onServer} · фото в копии от ${b.photosAt ? dt(b.photosAt) : "—"}</span></p>
        ${b.lastError ? `<p class="err" style="font-size:12.5px">Не получилось отправить: ${esc(b.lastError)}</p>` : ""}
        ${b.restored && b.restored.length ? `<p style="font-size:13px;margin-top:6px">✅ При последнем запуске магазин восстановлен из копии от ${dt(b.restored[b.restored.length - 1].createdAt)}.</p>` : ""}`}
        <button class="btn soft block" style="margin-top:12px" data-action="backupNow" ${state.admin.backupBusy ? "disabled" : ""}>${state.admin.backupBusy ? "Делаем копию…" : "Сделать копию сейчас"}</button>
        <details style="margin-top:10px"><summary class="muted" style="font-size:13px">Как восстановить из копии</summary>
          <p class="muted" style="font-size:12.5px;margin-top:6px">Amvera → проект → «Репозиторий» → «Data» → «Загрузить данные»: загрузите ZIP из чата, переименовав его в restore.zip. Если в копии нет фото — ещё последнюю копию с фото как restore-foto.zip. Затем перезапустите приложение. Ссылки, QR-коды и бот остаются прежними.</p></details>
      </div>`;
  }
  function adminStats(d) {
    const max = Math.max(1, ...d.days.map((x) => x.visitors));
    return `<div class="stat-grid">
      <div class="stat"><b>${d.today.visitors}</b><span>посетителей сегодня</span></div>
      <div class="stat"><b>${d.week.visitors}</b><span>посетителей за 7 дней</span></div>
      <div class="stat"><b>${d.week.orders}</b><span>заявок за 7 дней</span></div>
      <div class="stat"><b>${d.week.conversion}%</b><span>посетителей оставили заявку</span></div>
    </div>
    <h2 class="h2" style="font-size:22px">Посетители за 14 дней</h2>
    <div class="bars" role="img" aria-label="Посетители по дням">${d.days.map((x) => `<i style="height:${(x.visitors / max) * 100}%" title="${x.date}: ${x.visitors}"></i>`).join("")}</div>
    <div style="display:flex;justify-content:space-between;font-size:11px" class="muted"><span>${d.days[0] ? d.days[0].date.slice(5) : ""}</span><span>сегодня</span></div>
    <h2 class="h2" style="font-size:22px">Чаще всего смотрят</h2>
    ${d.topProducts.length ? d.topProducts.map((p) => `<div class="addon"><span class="t">${esc(p.title)}</span><span class="p">${p.views} просм. · ${p.carts} в корзину</span></div>`).join("") : `<p class="muted">Пока нет данных.</p>`}`;
  }

  const SEG = { all: "Все", regular: "Постоянные", new: "Новые", sleeping: "Давно не заказывали" };
  function adminCustomers(d) {
    return `<div class="admin-tabs" style="margin-top:0">${Object.entries(SEG).map(([k, t]) => `<button class="chip" aria-pressed="${state.admin.segment === k}" data-action="custSeg" data-seg="${k}">${t}</button>`).join("")}</div>
      <input class="search" type="search" placeholder="Имя, телефон или ник" value="${esc(state.admin.cq)}" data-input="custSearch">
      <p class="muted" style="font-size:13px">${d.customers.length} ${plural(d.customers.length, "клиент", "клиента", "клиентов")}</p>
      ${d.customers.map((c) => `<a class="cust-row" href="#/admin/customer/${esc(c.id)}">
        <span class="av">${esc((c.name || "?").slice(0, 1))}</span>
        <span class="mid"><b>${esc(c.name || "Без имени")}</b><small>${esc(c.phone || (c.username ? "@" + c.username : ""))} · ${c.orders} ${plural(c.orders, "заказ", "заказа", "заказов")} · ${rub(c.spent)}</small></span>
        <span class="rt"><span class="seg-badge seg-${c.segment}">${SEG[c.segment]}</span>${feat("bonuses") ? `<small>💎 ${c.balance}</small>` : ""}</span></a>`).join("") || `<p class="muted">Клиенты появятся, когда покупатели откроют приложение.</p>`}`;
  }
  function adminCustomer(c) {
    return `<a class="btn ghost small" href="#/admin/customers">Назад к клиентам</a>
      <h2 class="h2" style="margin-top:14px">${esc(c.name || "Без имени")}</h2>
      <p class="muted" style="margin:-6px 0 10px">${esc([c.phone, c.username ? "@" + c.username : ""].filter(Boolean).join(" · "))}${c.consent ? " · согласен на рассылки" : ""}</p>
      <div class="stat-grid">
        <div class="stat"><b>${c.orders}</b><span>заказов</span></div><div class="stat"><b>${rub(c.spent)}</b><span>выполнено на сумму</span></div>
        <div class="stat"><b>${c.balance}</b><span>бонусов · ${esc(c.level)}</span></div><div class="stat"><b>${SEG[c.segment]}</b><span>${c.lastOrderAt ? "последний заказ " + ddmm(c.lastOrderAt) : "ещё не заказывал"}</span></div>
      </div>
      <form data-form="custNote" data-id="${esc(c.id)}"><label class="field"><span>Заметка (видят только администраторы)</span><textarea class="input" name="note" placeholder="Например: любит белый шоколад">${esc(c.note || "")}</textarea></label>
      <button class="btn soft small" type="submit" style="margin-top:8px">Сохранить заметку</button></form>
      ${feat("bonuses") ? `<form data-form="custBonus" data-id="${esc(c.id)}"><div class="field"><span>Начислить или списать бонусы</span>
        <div style="display:grid;grid-template-columns:110px 1fr;gap:8px"><input class="input" name="delta" type="number" placeholder="+300 / −100" required><input class="input" name="comment" placeholder="Причина (видна клиенту)"></div></div>
        <button class="btn soft small" type="submit" style="margin-top:8px">Применить</button></form>` : ""}
      ${c.datesList && c.datesList.length ? `<h2 class="h2" style="font-size:22px">Важные даты</h2>${c.datesList.map((x) => { const [mm, dd] = x.md.split("-"); return `<div class="addon"><span class="t">${esc(x.title)}</span><span class="p">${+dd} ${MONTHS[+mm - 1]}</span></div>`; }).join("")}` : ""}
      <h2 class="h2" style="font-size:22px">Заказы</h2>
      ${c.orderList.length ? c.orderList.map((o) => `<div class="order"><div class="h"><span>№${o.id} · ${rub(o.total)}</span><span class="status">${STATUS[o.status] || o.status}${o.paid ? " · ✅" : ""}</span></div><pre>${esc(o.summary)}</pre></div>`).join("") : `<p class="muted">Заказов нет.</p>`}
      ${c.history.length ? `<h2 class="h2" style="font-size:22px">Бонусы</h2>${c.history.map((h) => `<div class="addon"><span class="t">${esc(h.note || h.kind)}<br><small class="muted">${ddmm(h.at)}</small></span><span class="p">${h.delta > 0 ? "+" : ""}${h.delta}</span></div>`).join("")}` : ""}`;
  }
  function adminBroadcast(d) {
    if (!feat("broadcasts")) return `<p class="muted">Рассылки выключены. Включите их во вкладке «Бонусы и оплата».</p>`;
    const seg = state.admin.bseg || "all";
    return `<form data-form="broadcast">
      <div class="field"><span>Кому</span><div class="admin-tabs" style="margin:0">${Object.entries(SEG).map(([k, t]) => `<button type="button" class="chip" aria-pressed="${seg === k}" data-action="bSeg" data-seg="${k}">${t} · ${d.counts[k]}</button>`).join("")}</div></div>
      <label class="field"><span>Текст</span><textarea class="input" name="text" style="min-height:120px" maxlength="3000" placeholder="Например: К 8 Марта — наборы со скидкой 10%. Успейте заказать заранее!" required></textarea></label>
      <label class="check" style="color:var(--text)"><input type="checkbox" name="button" checked>Добавить кнопку «Открыть магазин»</label>
      <button class="btn block" type="submit" style="margin-top:14px" ${d.counts[seg] ? "" : "disabled"}>Отправить ${d.counts[seg]} ${plural(d.counts[seg], "клиенту", "клиентам", "клиентам")}</button>
      <p class="muted" style="font-size:12.5px;margin-top:8px">Получат только те, кто согласился на рассылки — при заказе или в профиле.</p></form>
      <h2 class="h2" style="font-size:22px">Отправленные</h2>
      ${d.list.length ? d.list.map((b) => `<div class="order"><div class="h"><span>${ddmm(b.at)} · ${SEG[b.segment]}</span><span class="status">${b.sent}/${b.total}${b.done ? "" : " …"}</span></div><pre>${esc(b.text)}</pre></div>`).join("") : `<p class="muted">Рассылок ещё не было.</p>`}`;
  }
  const TRANSLIT = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sh", ы: "y", э: "e", ю: "yu", я: "ya" };
  function slugify(title, list) {
    let b = title.toLowerCase().split("").map((ch) => TRANSLIT[ch] ?? ch).join("").replace(/[^a-z0-9]/g, "").slice(0, 16) || "src";
    if (["friend", "hint", "gift"].includes(b)) b += "1";
    let s = b, i = 2;
    while (list.some((x) => x.slug === s)) s = b + i++;
    return s;
  }
  const PF_LABEL = { telegram: "Telegram", max: "MAX" };
  /** Links per messenger: one block when the shop is in one messenger, a block for each when in both. */
  const pfList = (links, single) => { const l = links ? Object.entries(links).filter(([, v]) => v) : []; return l.length > 1 ? l : single ? [["", single]] : l; };
  function qrBlocks(links, single, file) {
    return pfList(links, single).map(([pf, link]) => `<div class="src-body"><img class="qr" alt="QR-код" data-qr-text="${esc(link)}" src="">
          <div>${pf ? `<div style="font-weight:600;margin-bottom:4px">${PF_LABEL[pf] || pf}</div>` : ""}<div class="src-link">${esc(link)}</div>
          <button class="btn ghost small" style="margin-top:8px" data-action="copyText" data-text="${esc(link)}">Скопировать ссылку</button>
          <a class="btn ghost small" style="margin-top:6px" data-qr-dl="${esc(link)}" download="qr-${esc(file)}${pf ? "-" + pf : ""}.svg">Скачать QR</a></div></div>`).join("");
  }
  function adminPromo(d) {
    if (!d.linkBase) return `<p class="muted">Ссылки появятся, когда приложение подключат к боту.</p>`;
    const ownQr = (slug) => `/api/admin/qr?slug=${encodeURIComponent(slug)}`;
    return `<p class="muted" style="font-size:13.5px;margin-top:0">Отдельная ссылка и QR-код для каждого места рекламы. Видно, сколько людей пришло и сколько заказали.</p>
      <form class="date-form" onsubmit="return false"><input class="input" name="stitle" placeholder="Например: Авито, наклейка на коробке, блогер Маша" maxlength="60">
        <button class="btn soft block" type="button" style="margin-top:8px" data-action="addSource">Создать ссылку и QR-код</button></form>
      ${d.sources.map((x) => `<div class="src-card">
        <div class="src-h"><b>${esc(x.title)}</b><button class="icon-x" data-action="delSource" data-slug="${esc(x.slug)}" aria-label="Удалить">×</button></div>
        <div class="src-stats"><span><b>${x.customers}</b> пришло</span><span><b>${x.orders}</b> заказов</span><span><b>${rub(x.revenue)}</b></span></div>
        ${qrBlocks(x.links, x.link, x.slug)}</div>`).join("")}
      <h2 class="h2" style="font-size:22px">Пришли от других покупателей</h2>
      ${d.auto.map((x) => `<div class="addon"><span class="t">${esc(x.title)}</span><span class="p">${x.customers} чел.</span></div>`).join("")}`;
  }
  const RV_STATUS = { pending: "Ждёт проверки", approved: "Опубликован", hidden: "Скрыт", private: "Не публикуется" };
  function adminReviews(d) {
    const owner = !!state.me.isOwner;
    const dt = (iso) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    const f = state.admin.rvFilter || "pending";
    const groups = { pending: "Новые", bad: "Недовольные", approved: "Опубликованные", all: "Все" };
    const list = d.list.filter((r) => f === "all" || (f === "bad" ? r.status === "private" : r.status === f));
    const cnt = (k) => d.list.filter((r) => (k === "all" ? true : k === "bad" ? r.status === "private" : r.status === k)).length;
    return `<p class="muted" style="font-size:13.5px;margin-top:0">Вкладыш с QR-кодом кладёте в каждый букет. Покупатель или тот, кому подарили, сканирует QR, оценивает букет и попадает в вашу базу${d.bonus ? `, а за отзыв получает ${d.bonus} бонусов` : ""}. 4–5 звёзд появляются в приложении после вашей проверки, и человеку предлагаем повторить отзыв в 2ГИС. 1–3 звезды не публикуются — сразу приходят вам в чат.</p>
      ${!d.enabled ? `<p class="err" style="font-size:13px">Отзывы выключены во вкладке «Бонусы».</p>` : ""}
      <div class="src-card">
        <div class="src-h"><b>QR для вкладыша в букет</b></div>
        <div class="src-stats"><span><b>${d.fromCard.customers}</b> пришло по QR</span><span><b>${d.fromCard.orders}</b> заказов</span><span><b>${rub(d.fromCard.revenue)}</b></span></div>
        ${pfList(d.links, d.link).length ? qrBlocks(d.links, d.link, "otzyv") : `<p class="muted">QR появится, когда приложение подключат к боту.</p>`}
      </div>
      ${owner ? `<details class="history" style="margin-top:10px"><summary>Ссылка на отзывы в 2ГИС${d.link2gis ? "" : " — не указана"}</summary>
        <form data-form="review2gis" style="margin-top:8px"><input class="input" name="review2gis" value="${esc(d.custom2gis)}" placeholder="${esc(d.link2gis || "https://2gis.ru/…/firm/…/tab/reviews")}">
        <p class="muted" style="font-size:12px;margin:6px 2px 0">${!d.custom2gis && d.link2gis ? "Сейчас берём из адреса в 2ГИС автоматически. " : ""}Размер бонуса за отзыв — во вкладке «Бонусы».</p>
        <button class="btn soft block" type="submit" style="margin-top:8px">Сохранить ссылку</button></form></details>` : ""}
      <div class="admin-tabs" style="margin-top:16px">${Object.entries(groups).map(([k, t]) => `<button class="chip" aria-pressed="${f === k}" data-action="rvFilter" data-f="${k}">${t} · ${cnt(k)}</button>`).join("")}</div>
      ${list.map((r) => `<div class="order">
        <div class="h"><span>${starLine(r.rating)} ${esc(r.name)}</span><span class="status">${RV_STATUS[r.status] || r.status}</span></div>
        <div class="muted" style="font-size:12.5px">${dt(r.at)}${r.username ? " · @" + esc(r.username) : ""}${r.phone ? " · " + esc(r.phone) : ""}${r.orderId ? " · заказ №" + r.orderId : ""}${r.bonus ? ` · +${r.bonus} бонусов` : ""}</div>
        ${r.text ? `<p style="margin:8px 0">${esc(r.text)}</p>` : `<p class="muted" style="margin:8px 0">(без текста)</p>`}
        ${r.photos && r.photos.length ? `<div class="order-pics">${r.photos.map((u) => `<a href="${esc(u)}" data-ext>${imgTag(u, 240, "")}</a>`).join("")}</div>` : ""}
        ${r.reply && state.admin.replyId !== r.id ? `<div class="rc-reply"><b>Ваш ответ:</b> ${esc(r.reply)}</div>` : ""}
        ${state.admin.replyId === r.id ? `<form data-form="rvReply" data-id="${esc(r.id)}" style="margin-top:8px"><textarea class="input" name="reply" maxlength="1000" placeholder="Спасибо, что выбрали нас!">${esc(r.reply || "")}</textarea>
          <button class="btn small" type="submit" style="margin-top:6px">Сохранить ответ</button></form>` : ""}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          ${r.status !== "approved" ? `<button class="btn small" data-action="rvSet" data-id="${esc(r.id)}" data-s="approved">Опубликовать</button>` : `<button class="btn ghost small" data-action="rvSet" data-id="${esc(r.id)}" data-s="hidden">Скрыть</button>`}
          ${r.phone ? `<a class="btn soft small" href="tel:${esc(r.phone)}">Позвонить</a>` : ""}
          <button class="btn ghost small" data-action="rvReply" data-id="${esc(r.id)}">${r.reply ? "Изменить ответ" : "Ответить"}</button>
          <button class="btn ghost small" data-action="rvDel" data-id="${esc(r.id)}">Удалить</button>
        </div></div>`).join("") || `<p class="muted">${f === "pending" ? "Новых отзывов нет." : f === "bad" ? "Недовольных нет 🎉" : "Пока пусто."}</p>`}`;
  }
  /** QR images need the admin's signature header, so they are fetched and inlined. */
  async function fillQr() {
    for (const img of $app.querySelectorAll("img[data-qr-text]:not([src^=blob])")) {
      try {
        const r = await fetch(`/api/admin/qr?text=${encodeURIComponent(img.dataset.qrText)}`, { headers: { "X-Init-Data": INIT_DATA } });
        const url = URL.createObjectURL(await r.blob());
        img.src = url;
        for (const a of $app.querySelectorAll("a[data-qr-dl]")) if (a.dataset.qrDl === img.dataset.qrText) a.href = url;
      } catch (e) { /* ignore */ }
    }
  }
  const FEATURE_NAMES = { customers: "Клиентская база", bonuses: "Бонусы", levels: "Уровни (Бронза, Серебро, Золото)", burn: "Сгорание бонусов", dates: "Важные даты и напоминания", repeat: "Повтор заказа", referral: "Приведи друга", broadcasts: "Рассылки", payments: "Оплата в приложении", welcome: "Приветственный подарок новым", hint: "Кнопка «Намекнуть»", share: "Кнопка «Поделиться»", giftcard: "Цифровая открытка получателю", sources: "Ссылки и QR-коды для рекламы", reviews: "Отзывы (вкладыш с QR в букет)", reviewAsk: "Просить отзыв на следующий день после заказа" };
  function adminLoyalty(d) {
    const L = d.loyaltyResolved, P = d.paymentsResolved;
    return `<form data-form="loyalty">
      <h2 class="h2" style="font-size:22px;margin-top:6px">Функции</h2>
      ${Object.entries(FEATURE_NAMES).filter(([k]) => k !== "payments" || d.onlinePayAllowed !== false).map(([k, t]) => `<label class="toggle-row"><span>${t}</span><input type="checkbox" name="f_${k}" ${L.features[k] ? "checked" : ""}></label>`).join("")}
      <h2 class="h2" style="font-size:22px">Бонусы</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Оплата бонусами, до % заказа</span><input class="input" name="maxPayPercent" type="number" min="0" max="100" value="${L.maxPayPercent}"></label>
        <label class="field"><span>Бонусы действуют, дней</span><input class="input" name="burnDays" type="number" min="7" max="3650" value="${L.burnDays}"></label>
        <label class="field"><span>Напомнить о сгорании за, дней</span><input class="input" name="burnRemindDays" type="number" min="1" max="30" value="${L.burnRemindDays}"></label>
        <label class="field"><span>Напомнить о дате за, дней</span><input class="input" name="datesRemindDays" type="number" min="1" max="14" value="${L.datesRemindDays}"></label>
      </div>
      <h2 class="h2" style="font-size:22px">Уровни</h2>
      ${L.levels.map((lv, i) => `<div style="display:grid;grid-template-columns:1fr 100px 70px;gap:8px;margin-top:8px"><input class="input" name="lv_name_${i}" value="${esc(lv.name)}" aria-label="Название"><input class="input" name="lv_from_${i}" type="number" min="0" value="${lv.from}" aria-label="От суммы, ₽" ${i === 0 ? "readonly" : ""}><input class="input" name="lv_pct_${i}" type="number" min="0" max="50" value="${lv.percent}" aria-label="%"></div>`).join("")}
      <p class="muted" style="font-size:12.5px">Название · от суммы выполненных заказов, ₽ · процент бонусами</p>
      <h2 class="h2" style="font-size:22px">Подарки новым</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Приветственный, бонусов</span><input class="input" name="welcomeBonus" type="number" min="0" value="${L.welcomeBonus}"></label>
        <label class="field"><span>Получателю открытки, бонусов</span><input class="input" name="giftBonus" type="number" min="0" value="${L.giftBonus}"></label>
        <label class="field"><span>За отзыв, бонусов</span><input class="input" name="reviewBonus" type="number" min="0" value="${L.reviewBonus}"></label>
      </div>
      <h2 class="h2" style="font-size:22px">Приведи друга</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Другу, бонусов</span><input class="input" name="friendBonus" type="number" min="0" value="${L.referral.friendBonus}"></label>
        <label class="field"><span>Пригласившему, бонусов</span><input class="input" name="referrerBonus" type="number" min="0" value="${L.referral.referrerBonus}"></label>
      </div>
      ${d.onlinePayAllowed === false ? "" : `<h2 class="h2" style="font-size:22px">Оплата в приложении</h2>
      <label class="toggle-row"><span>Принимать оплату онлайн</span><input type="checkbox" name="payEnabled" ${P.enabled ? "checked" : ""}></label>
      <div class="seg" style="margin-top:10px"><button type="button" data-action="payProvider" data-p="demo" aria-pressed="${P.provider === "demo"}">Демо</button><button type="button" data-action="payProvider" data-p="yookassa" aria-pressed="${P.provider === "yookassa"}">ЮKassa</button></div>
      <input type="hidden" name="provider" value="${esc(P.provider)}">
      <p class="muted" style="font-size:12.5px;margin-top:8px">${P.provider === "demo" ? "Демо: оплата без настоящих денег — чтобы показать, как это работает." : d.env.yookassa ? "ЮKassa подключена. Деньги приходят прямо на счёт магазина. Адрес для уведомлений в кабинете ЮKassa: …/api/pay/yookassa" : "ЮKassa не подключена: ключи магазина (YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY) добавляются в настройки сервера."}</p>`}
      <button class="btn block" type="submit" style="margin-top:16px">Сохранить</button></form>
      <p class="muted" style="font-size:12.5px;margin-top:12px">Оплата переводом на карту — во вкладке «💳 Оплата».</p>`;
  }
  function adminStaff(d) {
    const dt = (iso) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    return `<p class="muted" style="font-size:13.5px;margin-top:0"><b>Владелец</b> — полный доступ: заявки, товары, оплата (карта), настройки, сотрудники. <b>Менеджер</b> — заявки, клиенты и товары; карту и настройки не видит. Заявки приходят в чат с ботом обоим.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" data-action="staffInvite" data-role="owner">+ Владельца</button><button class="btn soft" data-action="staffInvite" data-role="manager">+ Менеджера</button></div>
      ${state.admin.inviteLink ? `<div class="info-card" style="margin-top:12px"><p><b>Ссылка-приглашение готова${state.admin.inviteRole === "owner" ? " — роль: владелец" : " — роль: менеджер"}</b></p>
        <p class="muted" style="font-size:13px;margin-top:4px">Отправьте её сотруднику. Он откроет её и нажмёт «Старт» — и сразу станет менеджером. Ссылка одноразовая, действует сутки.</p>
        ${pfList(state.admin.inviteLinks, state.admin.inviteLink).length > 1 ? `<p class="muted" style="font-size:13px;margin-top:4px">Отправьте ту ссылку, в каком мессенджере сотрудник будет принимать заявки.</p>` : ""}
        ${pfList(state.admin.inviteLinks, state.admin.inviteLink).map(([pf, link]) => `${pf ? `<div style="font-weight:600;margin-top:10px">${PF_LABEL[pf] || pf}</div>` : ""}<div class="src-link" style="margin-top:6px">${esc(link)}</div>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn small" data-action="shareInvite" data-link="${esc(link)}">Отправить</button><button class="btn soft small" data-action="copyText" data-text="${esc(link)}">Скопировать</button></div>`).join("")}</div>` : ""}
      <h2 class="h2" style="font-size:22px">Кто имеет доступ</h2>
      ${d.owners.map((o) => `<div class="cust-row"><span class="av">${esc((o.name || "?").slice(0, 1))}</span><span class="mid"><b>${esc(o.name)}</b><small>${o.username ? "@" + esc(o.username) : "ID " + esc(String(o.id))}${o.platform && (d.platforms || []).length > 1 ? " · " + (PF_LABEL[o.platform] || o.platform) : ""}</small></span><span class="rt"><span class="seg-badge seg-regular">Владелец</span></span></div>`).join("")}
      ${d.staff.map((m) => `<div class="cust-row"><span class="av">${esc((m.name || "?").slice(0, 1))}</span><span class="mid"><b>${esc(m.name)}</b><small>${m.username ? "@" + esc(m.username) + " · " : ""}${m.role === "owner" ? "владелец" : "менеджер"} с ${ddmm(m.addedAt)}${m.platform && (d.platforms || []).length > 1 ? " · " + (PF_LABEL[m.platform] || m.platform) : ""}</small>
        <label class="check" style="margin:6px 0 0;font-size:12.5px"><input type="checkbox" data-action="staffNotify" data-id="${esc(String(m.id))}" ${m.notify !== false ? "checked" : ""}>Получает заявки в чат</label></span>
        <span class="rt">${m.role === "owner" ? `<span class="seg-badge seg-regular" style="display:block;margin-bottom:6px">Владелец</span>` : ""}<button class="btn ghost small" data-action="staffRemove" data-id="${esc(String(m.id))}" data-name="${esc(m.name)}">Убрать</button></span></div>`).join("") || `<p class="muted">Менеджеров пока нет.</p>`}
      ${d.invites.length ? `<h2 class="h2" style="font-size:22px">Неиспользованные приглашения</h2>${d.invites.map((x) => `<div class="addon"><span class="t">${x.role === "owner" ? "Владелец" : "Менеджер"} · до ${dt(x.expiresAt)}</span><span class="p">${pfList(x.links, x.link).map(([pf, link]) => `<button class="btn ghost small" data-action="copyText" data-text="${esc(link)}">${pf ? PF_LABEL[pf] || pf : "Скопировать"}</button> `).join("")}<button class="icon-x" data-action="inviteDel" data-code="${esc(x.code)}" aria-label="Отменить">×</button></span></div>`).join("")}` : ""}`;
  }
  function adminTransfer(d) {
    const T = d.transferResolved || {};
    return `<form data-form="transfer" style="margin-top:8px">
      <h2 class="h2" style="font-size:22px">Оплата переводом на карту</h2>
      <p class="muted" style="font-size:13px;margin:-4px 0 6px">Без банка и договоров: клиент переводит на вашу карту или по СБП и нажимает «Я оплатил», вам приходит уведомление, вы проверяете поступление и жмёте «Оплата получена». Реквизиты можно поменять здесь в любой момент.</p>
      <label class="toggle-row"><span>Принимать оплату переводом</span><input type="checkbox" name="tEnabled" ${T.enabled ? "checked" : ""}></label>
      <div class="field"><span>Когда клиент платит</span>
        <div class="seg"><button type="button" data-action="tMode" data-m="now" aria-pressed="${T.mode !== "after"}">Сразу после заказа</button><button type="button" data-action="tMode" data-m="after" aria-pressed="${T.mode === "after"}">После подтверждения</button></div>
        <input type="hidden" name="tMode" value="${T.mode === "after" ? "after" : "now"}">
        <div class="muted" style="font-size:12.5px;margin-top:6px">«Сразу» — реквизиты видны сразу после оформления, удобно для ночных заказов. «После подтверждения» — реквизиты уйдут клиенту в чат, когда нажмёте «Подтвердить».</div></div>
      <label class="field"><span>Номер карты</span><input class="input" name="tCard" inputmode="numeric" value="${esc(T.card || "")}" placeholder="2200 0000 0000 0000"></label>
      <label class="field"><span>Телефон для СБП</span><input class="input" name="tPhone" type="tel" value="${esc(T.phone || "")}" placeholder="+7 900 000-00-00"></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field"><span>Банк</span><input class="input" name="tBank" value="${esc(T.bank || "")}" placeholder="Т-Банк"></label>
        <label class="field"><span>Получатель</span><input class="input" name="tHolder" value="${esc(T.holder || "")}" placeholder="Имя и первая буква фамилии"></label></div>
      <label class="field"><span>Подсказка клиенту (необязательно)</span><input class="input" name="tNote" value="${esc(T.note || "")}" maxlength="200" placeholder="Например: в комментарии к переводу укажите номер заказа"></label>
      ${d.paymentsResolved && d.paymentsResolved.enabled && d.loyaltyResolved.features.payments ? `<p class="err" style="font-size:12.5px">Сейчас включена онлайн-оплата — пока она включена, перевод не показывается.</p>` : ""}
      <button class="btn block" type="submit" style="margin-top:14px">Сохранить оплату переводом</button></form>`;
  }

  /* ---------------- router ---------------- */
  function parseRoute() {
    const h = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = h.split("?");
    const parts = path.split("/").filter(Boolean);
    const query = Object.fromEntries(new URLSearchParams(qs || ""));
    return { parts, query };
  }
  let lastPath = "";
  function render() {
    const { parts, query } = parseRoute();
    const [a, b, c] = parts;
    let html = "", tab = "home", root = true;
    // keep bonuses and orders fresh when the customer comes back to the home screen or the profile
    if ((!a || a === "profile") && state.profile && Date.now() - (state.profileAt || 0) > 10e3) setTimeout(loadProfile);
    if (!a) html = viewHome();
    else if (a === "catalog") { html = viewCatalog(b || "all", query); tab = "catalog"; }
    else if (a === "p") { html = viewProduct(b); tab = "catalog"; root = false; }
    else if (a === "cart") { html = viewCart(); tab = "cart"; }
    else if (a === "checkout") { html = viewCheckout(); tab = "cart"; root = false; }
    else if (a === "done") { html = viewDone(b, query); tab = "cart"; }
    else if (a === "pay") { html = viewPay(b); tab = "cart"; root = false; }
    else if (a === "transfer") { html = viewTransfer(b); tab = "profile"; root = false; }
    else if (a === "gift") { html = viewGift(b); tab = "home"; }
    else if (a === "profile") { html = viewProfile(); tab = "profile"; }
    else if (a === "about") { html = viewAbout(); tab = "profile"; root = false; }
    else if (a === "contacts") { html = viewContacts(); tab = "contacts"; }
    else if (a === "reviews") { html = viewReviews(); tab = "contacts"; root = false; }
    else if (a === "review") { html = viewReviewForm(); tab = "home"; }
    else if (a === "admin") { html = viewAdmin(b === "edit" ? "edit" : b || "orders", c); tab = ""; root = b !== "edit" && b !== "customer"; }
    else html = viewHome();
    $app.innerHTML = html;
    document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-current", t.dataset.tab === tab ? "page" : "false"));
    // top-right: admin gear for admins, search otherwise
    const tr = document.getElementById("topRight");
    if (state.me.isAdmin) {
      tr.setAttribute("aria-label", "Управление"); tr.dataset.to = "#/admin/orders";
      tr.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`;
    }
    const path = parts.join("/");
    if (path !== lastPath) { window.scrollTo(0, 0); lastPath = path; if (a === "p") track("view", b); }
    if (host && host.BackButton) { try { root ? host.BackButton.hide() : host.BackButton.show(); } catch (e) {} }
    const af = $app.querySelector("[autofocus]"); if (af) af.focus();
    bindGallery();
    if ($app.querySelector("img[data-qr-text]")) fillQr();
  }
  function bindGallery() {
    const g = $app.querySelector("[data-gallery]");
    if (!g) return;
    const dots = $app.querySelectorAll(".dots i");
    g.addEventListener("scroll", () => {
      const i = Math.round(g.scrollLeft / g.clientWidth);
      dots.forEach((d, k) => d.classList.toggle("on", k === i));
    }, { passive: true });
  }

  /* ---------------- events ---------------- */
  document.addEventListener("click", async (ev) => {
    const ext = ev.target.closest("a[data-ext]");
    if (ext && host) { ev.preventDefault(); const u = ext.href; if (tg) { /^https:\/\/t\.me\//.test(u) ? tg.openTelegramLink(u) : tg.openLink(u); } else { try { mx.openLink(u); } catch (e) { window.open(u, "_blank"); } } return; }
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const act = el.dataset.action;
    const ds = el.dataset;
    if (act === "openChat") {
      const u = state.profile && state.profile.chatLink;
      state.saveChatHidden = true;
      if (u) { try { mx.openMaxLink ? mx.openMaxLink(u) : mx.openLink(u); } catch (e) { window.open(u, "_blank"); } }
      render(); return;
    }
    if (act === "go") { if (ds.to.includes("search=1") || ds.to.startsWith("#/catalog/")) state.search = ""; if (location.hash === ds.to) render(); else location.hash = ds.to; return; }
    if (act === "clearSearch") { state.search = ""; return; }
    if (act === "quickAdd") {
      ev.preventDefault();
      const p = productById(ds.id);
      if (p.chocolateChoices) { location.hash = "#/p/" + p.id; return; }
      addToCart(p.id, 1, []); return;
    }
    if (act === "choc") {
      const c = ds.choc, max = +ds.max;
      if (pdpChoc.includes(c)) pdpChoc = pdpChoc.filter((x) => x !== c);
      else { if (pdpChoc.length >= max) pdpChoc.shift(); pdpChoc.push(c); }
      haptic(); render(); return;
    }
    if (act === "pdpQty") { pdpQty = Math.max(1, Math.min(99, pdpQty + +ds.d)); const p = productById(parseRoute().parts[1]); document.getElementById("pdpQty").textContent = pdpQty; document.getElementById("pdpSum").textContent = rub(p.price * pdpQty); return; }
    if (act === "pdpAdd") { addToCart(ds.id, pdpQty, pdpChoc.slice()); pdpQty = 1; pdpChoc = []; render(); return; }
    if (act === "lineQty") {
      const l = state.cart.lines[+ds.i]; l.qty += +ds.d;
      if (l.qty <= 0) state.cart.lines.splice(+ds.i, 1);
      saveCart(); render(); return;
    }
    if (act === "addonQty") {
      const q = (state.cart.addons[ds.id] || 0) + +ds.d;
      if (q <= 0) delete state.cart.addons[ds.id]; else state.cart.addons[ds.id] = Math.min(20, q);
      saveCart(); render(); return;
    }
    if (act === "applyPromo") {
      const code = state.promo.code.trim();
      if (!code) return;
      try {
        const r = window.__MOCK ? mockPromo(code) : await api("/api/promo", { method: "POST", body: { code } });
        state.promo = { code, percent: r.ok ? r.percent : 0, message: r.message };
      } catch (e) { state.promo.message = e.message; state.promo.percent = 0; }
      render(); return;
    }
    if (act === "method") { initCheckout().method = ds.m; fixSlot(); render(); return; }
    if (act === "zone") { const c = initCheckout(); c.zoneId = ds.id; delete c.errors.zone; fixSlot(); haptic(); render(); return; }
    if (act === "openTransfer") { state.transfer = null; return; }
    if (act === "transferDone") {
      const t = state.transfer; if (!t) return;
      t.sending = true; render();
      try { state.transfer = await api(`/api/orders/${ds.id}/transfer`, { method: "POST" }); haptic("ok"); loadProfile(); location.hash = `#/done/${ds.id}?claimed=1`; }
      catch (e) { t.sending = false; render(); toast(e.message); }
      return;
    }
    if (act === "orderPaid") {
      const go = () => adminCall(`/api/admin/orders/${ds.id}`, "PATCH", { paid: true }, "orders").then((r) => r && toast("Отмечено: оплата получена"));
      const q = `Деньги за заказ №${ds.id} пришли? Клиенту придёт сообщение «Оплата получена».`;
      if (tg && tg.showConfirm) tg.showConfirm(q, (yes) => yes && go()); else if (window.confirm(q)) go();
      return;
    }
    if (act === "staffInvite") {
      const r = await adminCall("/api/admin/staff/invite", "POST", { role: ds.role }, null);
      if (r) { state.admin.inviteLink = r.link; state.admin.inviteLinks = r.links; state.admin.inviteRole = ds.role; state.admin.data = r; state.admin.tab = "staff"; render(); }
      return;
    }
    if (act === "shareInvite") return shareLink(`Приглашение в управление ${state.catalog.settings.brand}: откройте ссылку и нажмите «Старт»`, ds.link || state.admin.inviteLink);
    if (act === "staffNotify") { await adminCall(`/api/admin/staff/${ds.id}`, "PATCH", { notify: el.checked }, "staff"); return; }
    if (act === "staffRemove") {
      const go = () => adminCall(`/api/admin/staff/${ds.id}`, "DELETE", null, "staff").then((r) => r && toast("Доступ закрыт"));
      const q = `Убрать ${ds.name} из сотрудников? Доступ к управлению и заявкам пропадёт сразу.`;
      if (tg && tg.showConfirm) tg.showConfirm(q, (yes) => yes && go()); else if (window.confirm(q)) go();
      return;
    }
    if (act === "inviteDel") { await adminCall(`/api/admin/staff/invite/${ds.code}`, "DELETE", null, "staff"); return; }
    if (act === "addZone") { $app.querySelector("[data-zones]").insertAdjacentHTML("beforeend", zoneRow()); const r = $app.querySelectorAll(".zone-row"); r[r.length - 1].querySelector("input").focus(); return; }
    if (act === "delZone") { el.closest(".zone-row").remove(); return; }
    if (act === "photoDel") { el.closest(".photo-tile").remove(); return; }
    if (act === "photoLeft") { const t = el.closest(".photo-tile"); const prev = t.previousElementSibling; if (prev && prev.classList.contains("photo-tile")) t.parentNode.insertBefore(t, prev); return; }
    if (act === "addPhotoLink") {
      const inp = $app.querySelector("[data-photo-link]"), u = inp.value.trim();
      if (!/^https:\/\//.test(u)) return toast("Нужна ссылка, которая начинается с https://");
      $app.querySelector("[data-photos] .photo-add").insertAdjacentHTML("beforebegin", photoTile(u)); inp.value = ""; return;
    }
    if (act === "tMode") { const f = el.closest("form"); f.tMode.value = ds.m; f.querySelectorAll("[data-action=tMode]").forEach((b) => b.setAttribute("aria-pressed", b === el)); return; }
    if (act === "slot") { initCheckout().time = ds.t; delete state.checkout.errors.time; render(); return; }
    if (act === "shareContact") {
      const setPhone = (phone) => { if (phone) { phone = String(phone); state.checkout.phone = (phone.startsWith("+") ? "" : "+") + phone; render(); } };
      if (tg) tg.requestContact((ok, res) => ok && setPhone(res && res.responseUnsafe && res.responseUnsafe.contact && res.responseUnsafe.contact.phone_number));
      else Promise.resolve(mx.requestContact()).then((r) => setPhone(r && (r.phone || r.phone_number))).catch(() => {});
      return;
    }
    if (act === "submitOrder") return submitOrder();
    if (act === "repeatOrder") {
      const o = state.profile && state.profile.orders.find((x) => String(x.id) === ds.id);
      if (!o) return;
      let n = 0;
      for (const l of o.lines) { const p = productById(l.id); if (p && !p.hidden) { const key = l.id + "|" + (l.choc || []).join(","); const ex = state.cart.lines.find((x) => x.id + "|" + (x.choc || []).join(",") === key); if (ex) ex.qty = Math.min(99, ex.qty + l.qty); else state.cart.lines.push({ id: String(l.id), qty: l.qty, choc: l.choc || [] }); n += l.qty; } }
      saveCart(); haptic();
      toast(n ? "Заказ добавлен в корзину" : "Этих товаров сейчас нет в наличии");
      if (n) location.hash = "#/cart";
      return;
    }
    if (act === "shareRef" || act === "copyRef") {
      const link = state.profile.refLink, L = LOY();
      const text = `Дарю ${L.referral.friendBonus} бонусов на первый заказ в ${state.catalog.settings.brand} ${state.catalog.settings.emoji || "🍓"}`;
      if (act === "shareRef") {
        try {
          if (mx && mx.shareMaxContent) { await mx.shareMaxContent({ text, link }); return; }
          if (tg) { tg.openTelegramLink("https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(text)); return; }
          if (navigator.share) { await navigator.share({ text, url: link }); return; }
        } catch (e) { /* fall back to copy */ }
      }
      try { await navigator.clipboard.writeText(link); toast("Ссылка скопирована"); } catch (e) { toast(link); }
      return;
    }
    if (act === "delDate") { try { state.profile = await api(`/api/profile/dates/${ds.id}`, { method: "DELETE" }); render(); } catch (e) { toast(e.message); } return; }
    if (act === "toggleConsent") { try { state.profile = await api("/api/profile", { method: "PUT", body: { consent: el.checked } }); toast(el.checked ? "Будем присылать акции и напоминания" : "Рассылки отключены"); } catch (e) { toast(e.message); } return; }
    if (act === "demoPay" || act === "demoSbp") {
      const pay = state.payment; if (!pay) return;
      pay.sending = true; render();
      await new Promise((r) => setTimeout(r, 900));
      try { await api("/api/pay/demo", { method: "POST", body: { orderId: pay.id, token: pay.token } }); state.payment = null; haptic("ok"); loadProfile(); location.hash = `#/done/${pay.id}?paid=1`; }
      catch (e) { pay.sending = false; render(); toast(e.message); }
      return;
    }
    if (act === "retryPay") {
      try { const r = await api(`/api/orders/${ds.id}/pay`, { method: "POST" }); state.payment = Object.assign({ id: r.id }, r.pay); location.hash = "#/pay/" + r.id; render(); } catch (e) { toast(e.message); }
      return;
    }
    if (act === "hint") {
      const p = productById(ds.id);
      return shareLink(`Намекаю 😉 Очень хочу такой подарок: «${p.title}»`, appLink("h_" + p.id));
    }
    if (act === "shareProduct") {
      const p = productById(ds.id);
      return shareLink(`Смотри, какая красота: «${p.title}» в ${state.catalog.settings.brand} ${state.catalog.settings.emoji || "🍓"}`, appLink("p_" + p.id));
    }
    if (act === "sendGift") {
      const link = ds.link || state.lastGiftLink;
      return shareLink(`🎁 Для тебя подарок! Открой открытку:`, link);
    }
    if (act === "welcomeOk") {
      state.profile.welcome = null; render();
      api("/api/profile", { method: "PUT", body: { welcomeSeen: true } }).catch(() => {});
      return;
    }
    if (act === "addSource") {
      const f = el.closest("form"), title = f.stitle.value.trim();
      if (!title) return toast("Назовите источник, например «Авито»");
      const list = (state.admin.data.sources || []).map((x) => ({ title: x.title, slug: x.slug }));
      list.push({ title, slug: slugify(title, list) });
      if (await adminCall("/api/admin/sources", "PUT", { sources: list }, "promo")) toast("Ссылка создана");
      return;
    }
    if (act === "delSource") {
      const list = (state.admin.data.sources || []).filter((x) => x.slug !== ds.slug).map((x) => ({ title: x.title, slug: x.slug }));
      if (window.confirm("Удалить ссылку? Статистика по ней пропадёт из списка.")) await adminCall("/api/admin/sources", "PUT", { sources: list }, "promo");
      return;
    }
    if (act === "rvStar") { const f = rvForm(); f.rating = +ds.n; f.err = ""; haptic(); render(); return; }
    if (act === "rvPhotoDel") { rvForm().photos.splice(+ds.i, 1); render(); return; }
    if (act === "rv2gis") {
      const f = rvForm(), link = f.done && f.done.link2gis;
      if (!link) return;
      if (f.text) { try { await navigator.clipboard.writeText(f.text); toast("Текст скопирован — вставьте его в 2ГИС"); } catch (e) { /* the person will type it */ } }
      openExternal(link); return;
    }
    if (act === "rvFilter") { state.admin.rvFilter = ds.f; render(); return; }
    if (act === "rvSet") { if (await adminCall(`/api/admin/reviews/${ds.id}`, "PATCH", { status: ds.s }, "reviews")) toast(ds.s === "approved" ? "Отзыв опубликован" : "Отзыв скрыт"); state.reviewsList = null; return; }
    if (act === "rvReply") { state.admin.replyId = state.admin.replyId === ds.id ? null : ds.id; render(); return; }
    if (act === "rvDel") {
      const go = () => adminCall(`/api/admin/reviews/${ds.id}`, "DELETE", null, "reviews").then((r) => { if (r) { toast("Отзыв удалён"); state.reviewsList = null; } });
      const q = "Удалить отзыв насовсем?";
      if (tg && tg.showConfirm) tg.showConfirm(q, (yes) => yes && go()); else if (window.confirm(q)) go();
      return;
    }
    if (act === "copyText") { try { await navigator.clipboard.writeText(ds.text); toast("Скопировано"); } catch (e) { toast(ds.text); } return; }
    if (act === "custSeg") { state.admin.segment = ds.seg; await loadAdmin("customers"); return; }
    if (act === "bSeg") { state.admin.bseg = ds.seg; render(); return; }
    if (act === "payProvider") { const f = el.closest("form"); f.provider.value = ds.p; f.querySelectorAll("[data-action=payProvider]").forEach((b) => b.setAttribute("aria-pressed", b === el)); return; }
    // admin
    if (act === "adminTab") { location.hash = "#/admin/" + ds.tab; return; }
    if (act === "orderStatus") { await adminCall(`/api/admin/orders/${ds.id}`, "PATCH", { status: ds.s }, "orders"); return; }
    if (act === "move") { await adminCall(`/api/admin/move/${ds.coll}/${ds.id}`, "POST", { dir: +ds.dir }, state.admin.tab); return; }
    if (act === "toggleHidden") {
      const item = state.admin.data[ds.coll].find((x) => String(x.id) === ds.id);
      await adminCall(`/api/admin/item/${ds.coll}/${ds.id}`, "PUT", { hidden: !item.hidden }, state.admin.tab); return;
    }
    if (act === "addCategory") { await adminCall(`/api/admin/item/categories`, "POST", { title: "Новая категория" }, "categories"); return; }
    if (act === "deleteProduct") {
      const go = () => adminCall(`/api/admin/item/products/${ds.id}`, "DELETE", null, "products").then(() => (location.hash = "#/admin/products"));
      const q = "Удалить товар без возможности восстановления? Можно вместо этого скрыть его.";
      if (tg && tg.showConfirm) tg.showConfirm(q, (yes) => yes && go());
      else if (window.confirm(q)) go();
      return;
    }
    if (act === "importSite") {
      el.disabled = true; el.textContent = "Обновляем…";
      try { const r = await api("/api/admin/import", { method: "POST" }); toast(`Готово: обновлено ${r.updated}, новых ${r.added}`); await refreshCatalog(); loadAdmin("products"); }
      catch (e) { toast(e.message); el.disabled = false; el.textContent = "Обновить с сайта"; }
      return;
    }
    if (act === "backupNow") {
      state.admin.backupBusy = true; render();
      try { const r = await api("/api/admin/backup", { method: "POST" }); state.admin.backup = r.status; toast(r.sentTo ? "Копия готова — отправили вам в чат" : r.error ? "Копия сохранена на сервере, но не отправлена: " + r.error : "Копия сохранена на сервере"); }
      catch (e) { toast(e.message); }
      state.admin.backupBusy = false; render(); return;
    }
    if (act === "testNotify") { try { await api("/api/admin/test-notify", { method: "POST" }); toast("Тестовая заявка отправлена"); } catch (e) { toast(e.message); } return; }
  });

  document.addEventListener("input", (ev) => {
    const k = ev.target.dataset.input;
    if (!k) return;
    const v = ev.target.type === "checkbox" ? ev.target.checked : ev.target.value;
    if (k === "search") {
      state.search = v;
      clearTimeout(window.__st); window.__st = setTimeout(() => { const pos = ev.target.selectionStart; render(); const s = $app.querySelector('[data-input="search"]'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }, 250);
      return;
    }
    if (k === "adminSearch") { state.admin.search = v; clearTimeout(window.__st); window.__st = setTimeout(() => { render(); const s = $app.querySelector('[data-input="adminSearch"]'); s.focus(); s.setSelectionRange(v.length, v.length); }, 250); return; }
    if (k === "cardText") { state.cart.cardText = v; saveCart(); return; }
    if (k === "custSearch") { state.admin.cq = v; clearTimeout(window.__cs); window.__cs = setTimeout(async () => { await loadAdmin("customers"); const s = $app.querySelector('[data-input="custSearch"]'); if (s) { s.focus(); s.setSelectionRange(v.length, v.length); } }, 350); return; }
    if (k === "promo") { state.promo.code = v; return; }
    if (k === "rvText") { rvForm().text = v; return; }
    if (k === "rvConsent") { rvForm().consent = v; return; }
    if (k.startsWith("co.")) {
      const f = k.slice(3);
      initCheckout()[f] = v;
      if (state.checkout.errors[f]) { delete state.checkout.errors[f]; }
      if (f === "date") { state.checkout.time = ""; fixSlot(); render(); }
      if (f === "consent" || f === "useBonus" || f === "marketing" || f === "isGift") render();
    }
  });

  document.addEventListener("change", async (ev) => {
    const t = ev.target;
    if (t.dataset.reviewUpload !== undefined) {
      const file = t.files && t.files[0]; t.value = "";
      if (!file) return;
      toast("Загружаем фото…");
      try { const url = await uploadReviewPhoto(file); const f = rvForm(); if (f.photos.length < 3) f.photos.push(url); render(); } catch (e) { toast(e.message); }
      return;
    }
    if (t.dataset.upload !== undefined || t.dataset.uploadTo) {
      const files = [...(t.files || [])].slice(0, 10);
      t.value = "";
      const add = t.dataset.uploadTo ? null : $app.querySelector("[data-photos] .photo-add");
      for (const file of files) {
        const ph = document.createElement("div"); ph.className = "photo-tile loading"; ph.innerHTML = "<span>Загружаем…</span>";
        if (add) add.before(ph); else toast("Загружаем фото…");
        try {
          const url = await uploadPhoto(file);
          if (add) ph.outerHTML = photoTile(url);
          else {
            const f = t.closest("form"); f.elements[t.dataset.uploadTo].value = url;
            const pv = f.querySelector("[data-banner-preview]"); if (pv) pv.innerHTML = imgTag(url, 240, "");
            toast("Фото загружено — нажмите «Сохранить настройки»");
          }
        } catch (e) { ph.remove(); toast(e.message); }
      }
      return;
    }
    if (t.dataset.rename) await adminCall(`/api/admin/item/categories/${t.dataset.rename}`, "PUT", { title: t.value.trim() }, "categories");
    if (t.dataset.addonPrice) await adminCall(`/api/admin/item/addons/${t.dataset.addonPrice}`, "PUT", { price: Math.max(0, parseInt(t.value, 10) || 0) }, "extras");
  });

  document.addEventListener("submit", async (ev) => {
    const f = ev.target;
    if (!f.dataset.form) return;
    ev.preventDefault();
    const fd = new FormData(f);
    if (f.dataset.form === "product") {
      const body = {
        title: fd.get("title").trim(), price: parseInt(fd.get("price"), 10) || 0,
        oldPrice: parseInt(fd.get("oldPrice"), 10) || null, short: fd.get("short").trim(), intro: fd.get("intro").trim(),
        details: lines(fd.get("details")), images: [...f.querySelectorAll("[data-photos] .photo-tile[data-url]")].map((x) => x.dataset.url), cats: fd.getAll("cats"),
        chocolateChoices: Math.max(0, Math.min(6, parseInt(fd.get("chocolateChoices"), 10) || 0)), hidden: fd.get("hidden") === "on",
      };
      const id = f.dataset.id;
      const r = await adminCall(id ? `/api/admin/item/products/${id}` : `/api/admin/item/products`, id ? "PUT" : "POST", body, null);
      if (r) { toast(id ? "Сохранено" : "Товар создан"); location.hash = "#/admin/products"; }
    }
    if (f.dataset.form === "settings") {
      const body = {
        banner: { title: fd.get("banner.title"), text: fd.get("banner.text"), image: fd.get("banner.image") },
        phone: fd.get("phone"), address: fd.get("address"), hours: fd.get("hours"),
        timeSlots: fd.get("timeSlots").split(",").map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s)),
        managerChatIds: fd.get("managerChatIds").split(",").map((s) => s.trim()).filter(Boolean),
        about: lines(fd.get("about")), delivery: lines(fd.get("delivery")), successText: fd.get("successText"),
      };
      if (await adminCall(`/api/admin/settings`, "PUT", body, "settings")) toast("Настройки сохранены");
    }
    if (f.dataset.form === "date") {
      const md = String(fd.get("month")).padStart(2, "0") + "-" + String(fd.get("day")).padStart(2, "0");
      try { state.profile = await api("/api/profile/dates", { method: "POST", body: { title: fd.get("title"), md } }); toast("Напомним заранее 🎂"); render(); } catch (e) { toast(e.message); }
      return;
    }
    if (f.dataset.form === "review") {
      const r = rvForm();
      if (!r.rating) { r.err = "Поставьте оценку — нажмите на звезду"; render(); return; }
      if (r.rating <= 3 && r.text.trim().length < 3) { r.err = "Расскажите, пожалуйста, что не понравилось — мы обязательно разберёмся"; render(); return; }
      r.sending = true; r.err = ""; render();
      try { r.done = await api("/api/reviews", { method: "POST", body: { rating: r.rating, text: r.text, photos: r.photos, consent: r.consent } }); haptic("ok"); loadProfile(); }
      catch (e) { r.err = e.message; }
      r.sending = false; render(); window.scrollTo(0, 0); return;
    }
    if (f.dataset.form === "review2gis") { if (await adminCall("/api/admin/settings", "PUT", { review2gis: fd.get("review2gis").trim() }, "reviews")) toast("Ссылка сохранена"); return; }
    if (f.dataset.form === "rvReply") { state.admin.replyId = null; if (await adminCall(`/api/admin/reviews/${f.dataset.id}`, "PATCH", { reply: fd.get("reply") }, "reviews")) toast("Ответ сохранён — его увидят под отзывом"); state.reviewsList = null; return; }
    if (f.dataset.form === "custNote") { if (await adminCall(`/api/admin/customers/${f.dataset.id}`, "PATCH", { note: fd.get("note") }, "customer/" + f.dataset.id)) toast("Заметка сохранена"); return; }
    if (f.dataset.form === "custBonus") {
      const delta = parseInt(fd.get("delta"), 10) || 0;
      if (!delta) return toast("Укажите количество бонусов");
      if (await adminCall(`/api/admin/customers/${f.dataset.id}`, "PATCH", { bonusDelta: delta, comment: fd.get("comment") }, "customer/" + f.dataset.id)) toast(delta > 0 ? "Бонусы начислены" : "Бонусы списаны");
      return;
    }
    if (f.dataset.form === "broadcast") {
      const seg = state.admin.bseg || "all";
      if (!window.confirm("Отправить рассылку?")) return;
      const r = await adminCall("/api/admin/broadcast", "POST", { segment: seg, text: fd.get("text"), button: fd.get("button") === "on" }, null);
      if (r) { toast(`Отправляем ${r.count} клиентам`); setTimeout(() => loadAdmin("broadcast"), 1500); }
      return;
    }
    if (f.dataset.form === "loyalty") {
      const features = {}; Object.keys(FEATURE_NAMES).forEach((k) => (features[k] = fd.get("f_" + k) === "on"));
      const levels = []; for (let i = 0; fd.has("lv_name_" + i); i++) levels.push({ name: fd.get("lv_name_" + i), from: +fd.get("lv_from_" + i) || 0, percent: +fd.get("lv_pct_" + i) || 0 });
      const body = {
        loyalty: { features, maxPayPercent: +fd.get("maxPayPercent"), burnDays: +fd.get("burnDays"), burnRemindDays: +fd.get("burnRemindDays"), datesRemindDays: +fd.get("datesRemindDays"), levels,
          referral: { friendBonus: +fd.get("friendBonus"), referrerBonus: +fd.get("referrerBonus") }, welcomeBonus: +fd.get("welcomeBonus"), giftBonus: +fd.get("giftBonus"), reviewBonus: +fd.get("reviewBonus") },
        payments: fd.has("provider") ? { enabled: fd.get("payEnabled") === "on", provider: fd.get("provider") } : undefined,
      };
      if (await adminCall("/api/admin/settings", "PUT", body, "loyalty")) { toast("Сохранено"); loadProfile(); }
      return;
    }
    if (f.dataset.form === "zones") {
      const zones = [...f.querySelectorAll(".zone-row")].map((r) => ({ id: r.dataset.zid, name: r.querySelector("[name=zname]").value.trim(), price: +r.querySelector("[name=zprice]").value || 0,
        freeFrom: +r.querySelector("[name=zfree]").value || 0, from: +r.querySelector("[name=zfrom]").value || 0, to: +r.querySelector("[name=zto]").value || 0 })).filter((z) => z.name);
      if (await adminCall("/api/admin/settings", "PUT", { zones }, "settings")) toast(zones.length ? "Районы сохранены" : "Районы убраны");
      return;
    }
    if (f.dataset.form === "transfer") {
      const body = { transfer: { enabled: fd.get("tEnabled") === "on", mode: fd.get("tMode"), card: fd.get("tCard"), phone: fd.get("tPhone"), bank: fd.get("tBank"), holder: fd.get("tHolder"), note: fd.get("tNote") } };
      if (await adminCall("/api/admin/settings", "PUT", body, "loyalty")) toast("Оплата переводом сохранена");
      return;
    }
    if (f.dataset.form === "promos") {
      const promos = [];
      for (let i = 0; fd.has("code_" + i); i++) {
        const code = fd.get("code_" + i).trim();
        if (code) promos.push({ code, percent: +fd.get("percent_" + i) || 0, active: fd.get("active_" + i) === "on", firstOrderOnly: fd.get("first_" + i) === "1" });
      }
      if (fd.get("code_new").trim()) promos.push({ code: fd.get("code_new").trim(), percent: +fd.get("percent_new") || 5, active: true, firstOrderOnly: false });
      if (await adminCall(`/api/admin/promos`, "PUT", { promos }, "extras")) toast("Промокоды сохранены");
    }
  });
  const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);

  async function adminCall(path, method, body, reloadTab) {
    try {
      const r = await api(path, { method, body });
      await refreshCatalog();
      if (reloadTab) await loadAdmin(reloadTab);
      return r || true;
    } catch (e) { toast(e.message); return null; }
  }
  async function refreshCatalog() { if (!window.__MOCK) state.catalog = await api("/api/catalog"); }

  /** After the method, zone or date changes, drop a chosen time the courier can no longer make. */
  function fixSlot() {
    const c = state.checkout;
    if (c && c.time && slotsFor(c.date, c).some((x) => x.s === c.time && x.disabled)) c.time = "";
  }
  function validate(c) {
    const e = {};
    if (c.name.trim().length < 2) e.name = "Укажите имя, чтобы менеджер знал, как к вам обращаться";
    const digits = c.phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 12) e.phone = "Проверьте номер: нужно 10–11 цифр, например +7 900 000-00-00";
    if (c.method === "delivery" && zones().length && !zoneById(c.zoneId)) e.zone = "Выберите район — от него зависят цена и время доставки";
    if (c.method === "delivery" && c.address.trim().length < 5) e.address = "Укажите улицу и дом для курьера";
    if (!c.time) e.time = "Выберите время готовности";
    if (!c.consent) e.consent = "Без согласия мы не сможем принять заявку";
    return e;
  }
  async function submitOrder() {
    const c = initCheckout();
    c.errors = validate(c);
    if (Object.keys(c.errors).length) { render(); const firstErr = $app.querySelector(".invalid, .err"); firstErr && firstErr.scrollIntoView({ block: "center", behavior: "smooth" }); try { host && host.HapticFeedback.notificationOccurred("error"); } catch (e) {} return; }
    c.sending = true; render();
    try {
      const body = {
        cart: state.cart, promoCode: state.promo.percent ? state.promo.code : "",
        customer: { name: c.name.trim(), phone: c.phone.trim(), date: c.date, time: c.time, method: c.method, address: c.address.trim(), zoneId: c.method === "delivery" ? c.zoneId || "" : "", comment: c.comment.trim() },
        useBonus: !!c.useBonus, consent: !!c.marketing,
        gift: c.isGift ? { to: (c.giftTo || "").trim(), text: (c.giftText || "").trim() } : undefined,
      };
      const r = window.__MOCK ? { id: 1024 } : await api("/api/orders", { method: "POST", body });
      store("sr_contact", { name: c.name, phone: c.phone, address: c.address, zoneId: c.zoneId || "" });
      state.cart = { lines: [], addons: {}, cardText: "" }; saveCart();
      state.promo = { code: "", percent: 0, message: "" };
      state.checkout = null;
      haptic("ok");
      loadProfile();
      state.lastGiftLink = r.giftLink || "";
      if (r.pay) { state.payment = Object.assign({ id: r.id }, r.pay); location.hash = "#/pay/" + r.id; }
      else if (r.transfer) { state.transfer = r.transfer; location.hash = "#/transfer/" + r.id; }
      else { if (r.payError) toast(r.payError); location.hash = "#/done/" + r.id + (r.transferAfter ? "?after=1" : ""); }
    } catch (e) { c.sending = false; c.errors = { form: e.message }; render(); }
  }

  function mockPromo(code) {
    const p = P.findPromo(state.catalog, code);
    return p ? { ok: true, percent: p.percent, message: `Скидка ${p.percent}% применена` } : { ok: false, message: "Такого промокода нет" };
  }

  /* ---------------- boot ---------------- */
  function canShareContact() {
    if (tg) return !!tg.requestContact;
    // MAX: phone request works in the iOS/Android apps, not in web/desktop
    return !!(mx && mx.requestContact && /^(ios|android)$/.test(String(mx.platform || "")));
  }

  async function boot() {
    if (mx) {
      try { mx.ready && mx.ready(); } catch (e) {}
      const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
      const applyTheme = () => { document.documentElement.dataset.theme = mq && mq.matches ? "dark" : "light"; };
      applyTheme(); mq && mq.addEventListener && mq.addEventListener("change", applyTheme);
      try { mx.BackButton.onClick(() => history.length > 1 ? history.back() : (location.hash = "#/")); } catch (e) {}
    }
    if (tg) {
      tg.ready(); tg.expand();
      try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
      const applyTheme = () => {
        document.documentElement.dataset.theme = tg.colorScheme === "dark" ? "dark" : "light";
        const bg = getComputedStyle(document.body).backgroundColor;
        try { tg.setHeaderColor(bg); tg.setBackgroundColor(bg); tg.setBottomBarColor && tg.setBottomBarColor(bg); } catch (e) {}
      };
      applyTheme(); tg.onEvent("themeChanged", applyTheme);
      tg.BackButton.onClick(() => history.length > 1 ? history.back() : (location.hash = "#/"));
    }
    try {
      state.catalog = window.__CATALOG || (await api("/api/catalog"));
      if (window.__MOCK) state.me = { isAdmin: false };
      else api("/api/me").then((m) => {
        state.me = m;
        state.start = m.start || {};
        const fresh = !location.hash.startsWith("#/");
        if (fresh && state.start.paid) location.hash = `#/done/${state.start.paid}?paid=1`;
        else if (fresh && state.start.gift) location.hash = "#/gift/" + state.start.gift;
        else if (fresh && state.start.productId) location.hash = "#/p/" + state.start.productId;
        else if (fresh && state.start.review) location.hash = "#/review";
        render(); loadProfile();
      }).catch(() => {});
    } catch (e) {
      $app.innerHTML = `<div class="page empty"><h1 class="display">Не загрузилось</h1><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Обновить</button></div>`;
      return;
    }
    const S = state.catalog.settings;
    if (S.brand) document.title = S.brand;
    if (S.theme) document.documentElement.dataset.brand = S.theme;
    const mono = document.querySelector(".monogram");
    if (mono && (S.logoMark || S.monogram)) {
      mono.innerHTML = LOGO_MARKS[S.logoMark] || `${esc(S.monogram[0])}<i></i>${esc(S.monogram[1])}`;
      mono.setAttribute("aria-label", S.brand + " — на главную");
    }
    // flower shops: a flower instead of the strawberry on the «Каталог» tab
    const catTab = document.querySelector('.tab[data-tab="catalog"] svg');
    if (S.catalogIcon === "flower" && catTab) catTab.innerHTML = '<path d="M7 4.5l2.5 2L12 3.5l2.5 3 2.5-2V9a5 5 0 0 1-10 0z"/><path d="M12 14v7M12 18.5c-1.8-2-4-2.2-5-1.6 1.4 1.5 3.4 2.1 5 1.6M12 17c1.4-1.6 3.4-1.8 4.4-1.3-1.2 1.3-2.9 1.8-4.4 1.3"/>';
    const tel = S.phone.replace(/[^\d+]/g, "");
    document.getElementById("topLeft").href = "tel:" + tel;
    updateBadge();
    if (!window.__MOCK) track("visit");
    window.addEventListener("hashchange", render);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.profile) loadProfile(); });
    render();
  }
  boot();
});
