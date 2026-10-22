"use strict";
// 22.10.2026 load test: an opening of the shop must not rewrite the whole customers file each time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../server/store");

const SEED = path.join(__dirname, "..", "seed", "gagulya.seed.json");

test("a visit is saved later in one go; bonuses/orders (saveCustomers) and flush save at once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-"));
  const store = createStore(dir, SEED);
  const file = path.join(dir, "customers.json");
  store.getCustomers().list["1"] = { id: "1", name: "Анна" };
  store.saveCustomers();
  const before = fs.readFileSync(file, "utf8");
  store.getCustomers().list["1"].lastSeenAt = "2026-10-22T10:00:00Z";
  store.saveCustomersSoon();
  assert.equal(fs.readFileSync(file, "utf8"), before, "not written on every opening");
  store.flush();
  assert.match(fs.readFileSync(file, "utf8"), /2026-10-22T10:00:00Z/, "flush (before a backup or a stop) writes it");
  store.getCustomers().list["1"].balance = 200;
  store.saveCustomers();
  assert.match(fs.readFileSync(file, "utf8"), /"balance": 200/, "money is written at once");
});
