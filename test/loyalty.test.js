"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../server/loyalty");

const DAY = 864e5;
const S = L.defaultLoyalty();
const t0 = new Date("2026-10-07T03:00:00Z");

test("bonus lots: add, balance, FIFO spend by earliest expiry, expire", () => {
  const c = L.newCustomer({ id: 1, first_name: "А" }, t0);
  L.addBonus(c, 100, "order", { now: t0, days: 10 });
  L.addBonus(c, 50, "friend", { now: t0, days: 5 });
  assert.equal(L.balance(c, t0), 150);
  assert.equal(L.spendBonus(c, 70, { now: t0, orderId: 1001 }), 70);
  // the 50-lot expiring first is used first
  assert.deepEqual(c.lots.map((l) => l.left), [80, 0]);
  assert.equal(L.spendBonus(c, 1000, { now: t0 }), 80, "cannot spend more than balance");
  L.addBonus(c, 30, "order", { now: t0, days: 2 });
  assert.equal(L.expireLots(c, new Date(t0.getTime() + 3 * DAY)), 30);
  assert.equal(L.balance(c, new Date(t0.getTime() + 3 * DAY)), 0);
  assert.ok(c.history.some((h) => h.kind === "burn" && h.delta === -30));
});

test("burning soon reports the nearest expiry within the window", () => {
  const c = L.newCustomer({ id: 2 }, t0);
  L.addBonus(c, 40, "order", { now: t0, days: 5 });
  L.addBonus(c, 60, "order", { now: t0, days: 40 });
  const b = L.burningSoon(c, t0, 7);
  assert.equal(b.amount, 40);
  assert.equal(b.lots.length, 1);
  assert.equal(L.burningSoon(c, t0, 3), null);
});

test("levels by spent sum, with next-level hint", () => {
  assert.equal(L.levelFor(S, 0).name, "Бронза");
  assert.equal(L.levelFor(S, 0).percent, 5);
  const silver = L.levelFor(S, 20000);
  assert.equal(silver.name, "Серебро");
  assert.equal(silver.next.name, "Золото");
  assert.equal(silver.next.remaining, 20000);
  assert.equal(L.levelFor(S, 50000).next, null);
  const off = { ...S, features: { ...S.features, levels: false } };
  assert.equal(L.levelFor(off, 50000).percent, 5, "levels off → base percent");
});

test("max bonus payable: limited by balance and percent of the order", () => {
  assert.equal(L.maxPayable(S, 1000, 3200), 960);
  assert.equal(L.maxPayable(S, 100, 3200), 100);
  assert.equal(L.maxPayable({ ...S, features: { ...S.features, bonuses: false } }, 100, 3200), 0);
});

test("accrual on done uses level before the order; reverse accrual; referral reward once", () => {
  const db = { list: {} };
  const ref = L.touchCustomer(db, { id: 10, first_name: "Реф" }, { now: t0, settings: S });
  const friend = L.touchCustomer(db, { id: 11, first_name: "Друг" }, { now: t0, settings: S, startParam: "ref_" + ref.refCode });
  assert.equal(friend.referredBy, "10");
  assert.equal(L.balance(friend, t0), 300, "friend gets welcome bonus");
  const self = L.touchCustomer(db, { id: 12 }, { now: t0, settings: S, startParam: "ref_" + "nope" });
  assert.equal(self.referredBy, null);
  const again = L.touchCustomer(db, { id: 10 }, { now: t0, settings: S, startParam: "ref_" + ref.refCode });
  assert.equal(again.referredBy, null, "cannot refer yourself");

  const order = { id: 2001, totals: { total: 3000 }, bonusUsed: 300 };
  const res = L.onOrderDone(db, friend, order, { settings: S, spentBefore: 0, now: t0 });
  assert.equal(res.accrued, Math.floor((3000 - 300) * 0.05));
  assert.equal(order.bonusAccrued, res.accrued);
  assert.equal(res.referrerRewarded, "10");
  assert.equal(L.balance(db.list["10"], t0), S.welcomeBonus + 300);
  const res2 = L.onOrderDone(db, friend, { id: 2002, totals: { total: 1000 }, bonusUsed: 0 }, { settings: S, spentBefore: 2700, now: t0 });
  assert.equal(res2.referrerRewarded, null, "referrer rewarded only once");
  L.onOrderUndone(friend, order, { now: t0 });
  assert.equal(order.bonusAccrued, 0);
});

test("important dates are due exactly N days before, once a year, across year end", () => {
  const c = L.newCustomer({ id: 3 }, t0);
  L.addDate(c, { title: "ДР мамы", md: "01-02" });
  L.addDate(c, { title: "Годовщина", md: "10-10" });
  assert.equal(L.dueDates(c, "2026-10-07", 3).map((d) => d.title).join(), "Годовщина");
  assert.equal(L.dueDates(c, "2026-12-30", 3).map((d) => d.title).join(), "ДР мамы");
  assert.equal(L.dueDates(c, "2026-10-06", 3).length, 0);
  assert.throws(() => L.addDate(c, { title: "x", md: "13-40" }), /дату/);
});

test("segments", () => {
  const now = t0;
  assert.equal(L.segmentOf({ count: 3, doneCount: 3, lastOrderAt: now.toISOString() }, { createdAt: now.toISOString() }, now), "regular");
  assert.equal(L.segmentOf({ count: 1, doneCount: 1, lastOrderAt: new Date(now - 90 * DAY).toISOString() }, { createdAt: new Date(now - 100 * DAY).toISOString() }, now), "sleeping");
  assert.equal(L.segmentOf({ count: 0, doneCount: 0, lastOrderAt: null }, { createdAt: now.toISOString() }, now), "new");
  assert.ok(L.inSegment("all", "sleeping"));
});

test("start params: product, hint, ref, source, gift, legacy ref_ and paid_", () => {
  assert.deepEqual(L.parseStart("h_503533995202-r_7b903663"), { hint: "503533995202", ref: "7b903663" });
  assert.deepEqual(L.parseStart("p_m1x-r_7b903663-s_avito"), { product: "m1x", ref: "7b903663", source: "avito" });
  assert.deepEqual(L.parseStart("ref_7b903663"), { ref: "7b903663" });
  assert.deepEqual(L.parseStart("g_0a1b2c3d4e"), { gift: "0a1b2c3d4e" });
  assert.deepEqual(L.parseStart("paid_1001"), { paid: "1001" });
  assert.deepEqual(L.parseStart("s_box-qr"), { source: "box" });
  assert.deepEqual(L.parseStart(""), {});
});

test("new customers: welcome bonus, gift bonus, friend bonus — one of them; source remembered", () => {
  const db = { list: {} };
  const owner = L.touchCustomer(db, { id: 1 }, { now: t0, settings: S });
  assert.equal(L.balance(owner, t0), S.welcomeBonus, "plain newcomer gets welcome bonus");
  assert.equal(owner.welcome.amount, S.welcomeBonus);
  const viaGift = L.touchCustomer(db, { id: 2 }, { now: t0, settings: S, startParam: "g_0a1b2c3d4e", giftExists: (id) => id === "0a1b2c3d4e" });
  assert.equal(L.balance(viaGift, t0), S.giftBonus);
  assert.equal(viaGift.source, "gift");
  const viaFriend = L.touchCustomer(db, { id: 3 }, { now: t0, settings: S, startParam: "h_123-r_" + owner.refCode });
  assert.equal(L.balance(viaFriend, t0), S.referral.friendBonus);
  assert.equal(viaFriend.referredBy, "1");
  const viaQr = L.touchCustomer(db, { id: 4 }, { now: t0, settings: S, startParam: "s_box" });
  assert.equal(viaQr.source, "box");
  const off = { ...S, features: { ...S.features, welcome: false } };
  assert.equal(L.balance(L.touchCustomer(db, { id: 5 }, { now: t0, settings: off }), t0), 0);
  // existing customer is not re-attributed
  L.touchCustomer(db, { id: 4 }, { now: t0, settings: S, startParam: "s_avito-r_" + owner.refCode });
  assert.equal(db.list["4"].source, "box");
  assert.equal(db.list["4"].referredBy, null);
});
