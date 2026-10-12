"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateInitData, signInitData, createBot } = require("../server/max");

const TOKEN = "max-test-token-123";

test("max initData: plain, WebAppData-wrapped and full fragment are accepted; tampered rejected", () => {
  const user = { id: 9001, first_name: "Илья", username: "ilya" };
  const raw = signInitData(user, TOKEN);
  assert.equal(validateInitData(raw, TOKEN).id, 9001);
  // Bridge may hand over the whole URL fragment
  const frag = "#WebAppData=" + encodeURIComponent(raw) + "&WebAppPlatform=ios&WebAppVersion=26.2.8";
  assert.equal(validateInitData(frag, TOKEN).id, 9001);
  const frag2 = "WebAppData=" + raw + "&WebAppPlatform=web&WebAppVersion=26.2.8";
  assert.equal(validateInitData(frag2, TOKEN).id, 9001);
  assert.equal(validateInitData(raw.replace("9001", "9002"), TOKEN), null);
  assert.equal(validateInitData(raw, "other"), null);
  assert.equal(validateInitData("", TOKEN), null);
  const old = signInitData(user, TOKEN, Math.floor(Date.now() / 1000) - 2 * 86400);
  assert.equal(validateInitData(old, TOKEN), null);
});

function fakeApi(script) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    return script(method, path, body, calls);
  };
  return { calls, request };
}

test("max bot: bot_started → greeting with open_app button; /id → user id; marker advances", async () => {
  let polls = 0, bot;
  const api = fakeApi((method, path) => {
    if (path === "/me") return { user_id: 1, username: "cr_demo_bot", name: "Демо" };
    if (path.startsWith("/updates")) {
      polls++;
      if (polls === 1) return { marker: 55, updates: [
        { update_type: "bot_started", timestamp: 1, chat_id: 700, user: { user_id: 77, first_name: "Аня" } },
        { update_type: "message_created", timestamp: 2, message: { sender: { user_id: 77, first_name: "Аня" }, recipient: { chat_id: 700, chat_type: "dialog" }, body: { mid: "m1", seq: 1, text: "/id" } } },
        { update_type: "message_created", timestamp: 3, message: { sender: { user_id: 78, first_name: "Боб" }, recipient: { chat_id: 701, chat_type: "dialog" }, body: { mid: "m2", seq: 2, text: "/start" } } },
      ] };
      bot.stop();
      return { marker: 56, updates: [] };
    }
    return { message: { body: { mid: "x" } } };
  });
  bot = createBot({ token: TOKEN, request: api.request, log: { error() {}, log() {} } });
  await bot.startPolling({
    isAdmin: (id) => id === 77,
    onStart: (from) => (from.id === 77 ? "\nOWNER" : ""),
    greeting: () => "Привет из демо",
  });
  const sends = api.calls.filter((c) => c.method === "POST" && c.path.startsWith("/messages"));
  assert.equal(sends.length, 3);
  assert.match(sends[0].path, /user_id=77/);
  assert.match(sends[0].body.text, /^Привет из демо[\s\S]*OWNER$/);
  assert.equal(sends[0].body.format, "html");
  const btn = sends[0].body.attachments[0];
  assert.equal(btn.type, "inline_keyboard");
  assert.deepEqual(btn.payload.buttons[0][0], { type: "open_app", text: "Открыть каталог", web_app: "cr_demo_bot" });
  assert.match(sends[1].body.text, /77/);
  assert.match(sends[1].body.text, /Настройки/);
  assert.match(sends[2].path, /user_id=78/);
  const polls2 = api.calls.filter((c) => c.path.startsWith("/updates"));
  assert.match(polls2[1].path, /marker=55/);
  assert.match(polls2[0].path, /types=message_created%2Cbot_started/);
});

test("max bot: sendMessage to a user vs a group chat, html format", async () => {
  const api = fakeApi(() => ({ message: {} }));
  const bot = createBot({ token: TOKEN, request: api.request, log: { error() {} } });
  await bot.sendMessage("123", "<b>Заявка</b>");
  await bot.sendMessage("-456", "в группу");
  assert.match(api.calls[0].path, /^\/messages\?user_id=123/);
  assert.equal(api.calls[0].body.format, "html");
  assert.match(api.calls[1].path, /^\/messages\?chat_id=-456/);
});

test("max bot: API errors are reported, not swallowed", async () => {
  const api = fakeApi(() => { throw new Error("MAX POST /messages: 401 verify.token"); });
  const bot = createBot({ token: TOKEN, request: api.request, log: { error() {} } });
  await assert.rejects(() => bot.sendMessage("1", "x"), /401/);
});

test("max bot: ?start=<payload> from bot_started reaches onStart and the open_app button", async () => {
  let got = null;
  let bot;
  const api = fakeApi((method, p) => {
    if (p === "/me") return { user_id: 1, username: "cr_demo_bot" };
    if (p.startsWith("/updates")) {
      bot.stop();
      return { marker: 2, updates: [
        { update_type: "bot_started", timestamp: 1, chat_id: 700, user: { user_id: 90, first_name: "Друг" }, payload: "h_123-r_abcd1234" },
        { update_type: "message_created", timestamp: 2, message: { sender: { user_id: 91, first_name: "Ещё" }, recipient: { chat_id: 701, chat_type: "dialog" }, body: { mid: "m", seq: 1, text: "/start p_9<x>" } } },
      ] };
    }
    return { message: {} };
  });
  bot = createBot({ token: TOKEN, request: api.request, log: { error() {}, log() {} } });
  const seen = [];
  await bot.startPolling({ onStart: (from, payload) => { seen.push([from.id, payload]); return from.id === 90 ? { text: "", greeting: "Намёк!", button: "Посмотреть подарок" } : ""; } });
  assert.deepEqual(seen, [[90, "h_123-r_abcd1234"], [91, "p_9x"]]);
  const sends = api.calls.filter((c) => c.method === "POST" && c.path.startsWith("/messages"));
  assert.equal(sends[0].body.text, "Намёк!");
  assert.deepEqual(sends[0].body.attachments[0].payload.buttons[0][0], { type: "open_app", text: "Посмотреть подарок", web_app: "cr_demo_bot", payload: "h_123-r_abcd1234" });
  assert.equal(sends[1].body.attachments[0].payload.buttons[0][0].payload, "p_9x");
});
