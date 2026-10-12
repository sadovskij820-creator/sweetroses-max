/* Shared pricing logic — used by the browser (window.SRPricing) and the server (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SRPricing = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function normCode(code) {
    return String(code || "").trim().toUpperCase().replace(/Ё/g, "Е");
  }

  function findPromo(catalog, code) {
    const c = normCode(code);
    if (!c) return null;
    return (catalog.promos || []).find((p) => p.active !== false && normCode(p.code) === c) || null;
  }

  /**
   * cart: { lines: [{ id, qty, choc: [] }], addons: { [addonId]: qty }, cardText }
   * opts: { promoCode, isFirstOrder }  (isFirstOrder undefined = unknown → assume eligible)
   */
  function computeTotals(catalog, cart, opts) {
    opts = opts || {};
    const products = new Map((catalog.products || []).map((p) => [String(p.id), p]));
    const addonsById = new Map((catalog.addons || []).map((a) => [a.id, a]));
    const errors = [];
    const lines = [];
    for (const l of (cart && cart.lines) || []) {
      const p = products.get(String(l.id));
      const qty = Math.max(0, Math.min(99, parseInt(l.qty, 10) || 0));
      if (!p || p.hidden) { errors.push("Товар больше недоступен: " + (p ? p.title : l.id)); continue; }
      if (!qty) continue;
      const choc = Array.isArray(l.choc) ? l.choc.filter((c) => (catalog.chocolates || []).includes(c)).slice(0, p.chocolateChoices || 0) : [];
      lines.push({ id: String(p.id), title: p.title, qty, price: p.price, sum: p.price * qty, choc, image: (p.images || [])[0] || "" });
    }
    const addons = [];
    const ca = (cart && cart.addons) || {};
    for (const id of Object.keys(ca)) {
      const a = addonsById.get(id);
      const qty = Math.max(0, Math.min(99, parseInt(ca[id], 10) || 0));
      if (!a || a.hidden || !qty) continue;
      addons.push({ id: a.id, title: a.title, qty, price: a.price, sum: a.price * qty });
    }
    const subtotal = lines.reduce((s, l) => s + l.sum, 0) + addons.reduce((s, a) => s + a.sum, 0);
    let discount = 0;
    let promo = null;
    let promoError = null;
    if (opts.promoCode) {
      const p = findPromo(catalog, opts.promoCode);
      if (!p) promoError = "Такого промокода нет";
      else if (p.firstOrderOnly && opts.isFirstOrder === false) promoError = "Промокод действует только на первый заказ";
      else {
        promo = { code: p.code, percent: p.percent };
        discount = Math.round((subtotal * p.percent) / 100);
      }
    }
    return { lines, addons, subtotal, discount, total: subtotal - discount, promo, promoError, errors };
  }

  function formatRub(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";
  }

  return { computeTotals, findPromo, normCode, formatRub };
});
