"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBot } = require("../server/telegram");

test("bot: /start sends the open-catalog button, /id returns chat id, menu button set", async () => {
  const calls = [];
  let polled = 0;
  const realFetch = global.fetch;
  let bot;
  global.fetch = async (url, init) => {
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    let result = true;
    if (method === "getUpdates") {
      polled++;
      if (polled === 1) result = [
        { update_id: 1, message: { text: "/start", chat: { id: 77 }, from: { id: 77 } } },
        { update_id: 2, message: { text: "/id", chat: { id: 77 }, from: { id: 77 } } },
      ];
      else { bot.stop(); result = []; }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  try {
    bot = createBot({ token: "T", webAppUrl: "https://app.example", log: { error() {} } });
    await bot.startPolling({ isAdmin: (id) => id === 77, onStart: () => "\nOWNER" });
  } finally { global.fetch = realFetch; }
  const menu = calls.find((c) => c.method === "setChatMenuButton");
  assert.equal(menu.body.menu_button.web_app.url, "https://app.example");
  const sends = calls.filter((c) => c.method === "sendMessage");
  assert.equal(sends[0].body.reply_markup.inline_keyboard[0][0].web_app.url, "https://app.example");
  assert.match(sends[0].body.text, /OWNER$/);
  assert.match(sends[1].body.text, /<code>77<\/code>/);
  assert.match(sends[1].body.text, /Настройки/);
  assert.equal(calls.filter((c) => c.method === "getUpdates")[1].body.offset, 3);
});
