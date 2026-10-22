"use strict";
const fs = require("fs");
const path = require("path");

/** Tiny JSON-file store. All writes are atomic (write temp file, then rename). */
function createStore(dataDir, seedFile) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = (name) => path.join(dataDir, name + ".json");

  function read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), "utf8")); }
    catch (e) { return fallback; }
  }
  function write(name, data) {
    const tmp = file(name) + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file(name));
  }

  if (!fs.existsSync(file("catalog"))) {
    write("catalog", JSON.parse(fs.readFileSync(seedFile, "utf8")));
  }

  let catalog = read("catalog");
  let orders = read("orders", { lastId: 1000, list: [] });
  let stats = read("stats", { days: {}, products: {} });
  let customers = read("customers", { list: {} });
  let broadcasts = read("broadcasts", { list: [] });
  let reviews = read("reviews", { list: [] });
  let statsDirty = false;
  /* 22.10.2026 load test: rewriting the whole customers file on EVERY opening of the shop (3000 customers ≈ 2.5 MB)
     made it slow at 50+ people at once. A visit (last seen, name) is now saved within 2 s together with others;
     bonuses, orders and anything that matters are still saved at once (saveCustomers). */
  let custDirty = false;
  const timer = setInterval(() => { if (statsDirty) { statsDirty = false; write("stats", stats); } }, 5000);
  timer.unref();
  const custTimer = setInterval(() => { if (custDirty) { custDirty = false; write("customers", customers); } }, 2000);
  custTimer.unref();

  return {
    getCatalog: () => catalog,
    setCatalog(c) { catalog = c; write("catalog", c); },
    getOrders: () => orders,
    addOrder(o) { orders.lastId += 1; o.id = orders.lastId; orders.list.push(o); write("orders", orders); return o; },
    saveOrders() { write("orders", orders); },
    getCustomers: () => customers,
    saveCustomers() { custDirty = false; write("customers", customers); },
    saveCustomersSoon() { custDirty = true; },
    getBroadcasts: () => broadcasts,
    saveBroadcasts() { write("broadcasts", broadcasts); },
    getReviews: () => reviews,
    saveReviews() { write("reviews", reviews); },
    getStats: () => stats,
    touchStats() { statsDirty = true; },
    flush() { if (statsDirty) { statsDirty = false; write("stats", stats); } if (custDirty) { custDirty = false; write("customers", customers); } },
  };
}

module.exports = { createStore };
