"use strict";
/**
 * Online payment for orders.
 *  - "demo": no real money — the app shows a test card form, used to show clients how it works.
 *  - "yookassa": ЮKassa API v3 (https://yookassa.ru/developers/api). The shop's own contract and keys,
 *    money goes straight to the shop. Keys come only from environment variables, never from the admin UI.
 */
const crypto = require("crypto");
const https = require("https");

function demoToken(secret, orderId) {
  return crypto.createHmac("sha256", "demo-pay:" + secret).update(String(orderId)).digest("hex").slice(0, 32);
}

function yookassaRequest({ shopId, secretKey }) {
  const auth = "Basic " + Buffer.from(`${shopId}:${secretKey}`).toString("base64");
  return (method, path, body, idemKey) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: "api.yookassa.ru", path: "/v3" + path, method, timeout: 30e3,
      headers: Object.assign({ Authorization: auth, Accept: "application/json" }, data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}, idemKey ? { "Idempotence-Key": idemKey } : {}),
    }, (res) => {
      let buf = ""; res.setEncoding("utf8");
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = {}; try { json = buf ? JSON.parse(buf) : {}; } catch (e) { /* keep */ }
        if (res.statusCode >= 400) return reject(new Error(`ЮKassa ${res.statusCode}: ${json.description || json.code || ""}`.trim()));
        resolve(json);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function createPayments({ provider = "demo", shopId = "", secretKey = "", demoSecret = "", request } = {}) {
  const ykCall = provider === "yookassa" ? request || yookassaRequest({ shopId, secretKey }) : null;
  const rub = (n) => (Math.round(n * 100) / 100).toFixed(2);

  /** Returns { paymentId, url | demoToken }. */
  async function create(order, { amount, returnUrl, description }) {
    if (provider === "demo") {
      return { paymentId: "demo_" + order.id, demoToken: demoToken(demoSecret, order.id) };
    }
    if (!shopId || !secretKey) throw new Error("ЮKassa не подключена: нужны YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY");
    const p = await ykCall("POST", "/payments", {
      amount: { value: rub(amount), currency: "RUB" },
      capture: true,
      confirmation: { type: "redirect", return_url: returnUrl },
      description: String(description || `Заказ №${order.id}`).slice(0, 128),
      metadata: { orderId: String(order.id) },
    }, `order-${order.id}-${order.payAttempt || 1}`);
    return { paymentId: p.id, url: p.confirmation && p.confirmation.confirmation_url };
  }

  /** Never trust a webhook body: re-read the payment from ЮKassa and check order id and amount. */
  async function verify(paymentId, order, amount) {
    if (provider !== "yookassa") return false;
    const p = await ykCall("GET", "/payments/" + encodeURIComponent(paymentId));
    return p.status === "succeeded" && p.paid === true && p.metadata && String(p.metadata.orderId) === String(order.id) && p.amount && p.amount.value === rub(amount) && p.amount.currency === "RUB";
  }

  const checkDemo = (orderId, token) => provider === "demo" && typeof token === "string" && token.length === 32 && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(demoToken(demoSecret, orderId)));

  return { provider, create, verify, checkDemo, configured: provider === "demo" || !!(shopId && secretKey) };
}

module.exports = { createPayments, demoToken };
