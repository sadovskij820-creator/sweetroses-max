"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPayments } = require("../server/payments");

test("demo payments: token checks out only for its order", async () => {
  const p = createPayments({ provider: "demo", demoSecret: "s" });
  const r = await p.create({ id: 1001 }, { amount: 100 });
  assert.ok(p.checkDemo(1001, r.demoToken));
  assert.equal(p.checkDemo(1002, r.demoToken), false);
  assert.equal(p.checkDemo(1001, "x".repeat(32)), false);
});

test("yookassa: creates redirect payment with idempotence key and verifies by re-reading", async () => {
  const calls = [];
  const request = async (method, path, body, idem) => {
    calls.push({ method, path, body, idem });
    if (method === "POST") return { id: "pay_1", confirmation: { confirmation_url: "https://yoomoney.ru/checkout/x" } };
    return { id: "pay_1", status: "succeeded", paid: true, amount: { value: "2900.00", currency: "RUB" }, metadata: { orderId: "1001" } };
  };
  const p = createPayments({ provider: "yookassa", shopId: "1", secretKey: "k", request });
  const r = await p.create({ id: 1001 }, { amount: 2900, returnUrl: "https://max.ru/bot?startapp=paid_1001" });
  assert.equal(r.url, "https://yoomoney.ru/checkout/x");
  assert.equal(calls[0].body.amount.value, "2900.00");
  assert.equal(calls[0].body.confirmation.return_url, "https://max.ru/bot?startapp=paid_1001");
  assert.equal(calls[0].idem, "order-1001-1");
  assert.equal(await p.verify("pay_1", { id: 1001 }, 2900), true);
  assert.equal(await p.verify("pay_1", { id: 1002 }, 2900), false, "other order");
  assert.equal(await p.verify("pay_1", { id: 1001 }, 3000), false, "other amount");
});

test("yookassa without keys refuses to create a payment", async () => {
  const p = createPayments({ provider: "yookassa" });
  assert.equal(p.configured, false);
  await assert.rejects(() => p.create({ id: 1 }, { amount: 1 }), /YOOKASSA_SHOP_ID/);
});
