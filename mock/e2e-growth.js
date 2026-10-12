// Browser run of growth features on a MAX Bridge stub. Usage: node mock/e2e-growth.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const { createApp } = require('../server/index');
const max = require('../server/max');

const TOKEN = 'max-e2e-token';
const BRIDGE_STUB = fs.readFileSync(path.join(__dirname, 'e2e-max.js'), 'utf8').match(/const BRIDGE_STUB = `([\s\S]*?)`;/)[1]
  .replace("requestContact:", "shareMaxContent: function(o){ window.__shared = o; return Promise.resolve({ status: 'shared' }); }, requestContact:");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-gr-'));
  const sent = [];
  const bot = { sendMessage: async (chat, text, ex) => { sent.push({ chat: String(chat), text, ex }); }, setWebAppUrl() {}, getUsername: () => 'cr_demo_bot', openButton: (t) => [[{ type: 'open_app', text: t, web_app: 'cr_demo_bot' }]] };
  const app = createApp({ messenger: 'max', botToken: TOKEN, adminIds: '', dataDir, bot, log: { error: console.error, log() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.claimOwner({ id: 77 });
  app.store.getCatalog().settings.payments = { enabled: false, provider: 'demo' };
  const names = { 77: 'Илья', 1: 'Анна', 2: 'Олег', 3: 'Маша', 4: 'Света' };
  const launch = (id, sp) => '#WebAppData=' + encodeURIComponent(max.signInitData({ id, first_name: names[id], username: 'u' + id }, TOKEN, Math.floor(Date.now() / 1000), sp ? { start_param: sp } : {})) + '&WebAppPlatform=android&WebAppVersion=26.2.8';
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const shots = path.join(__dirname, 'shots-growth'); fs.mkdirSync(shots, { recursive: true });
  const errs = [];
  async function page() {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await ctx.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin === base || u.protocol === 'blob:') return route.continue();
      if (u.hostname === 'st.max.ru') return route.fulfill({ body: BRIDGE_STUB, contentType: 'text/javascript' });
      if (u.hostname.endsWith('tildacdn.com')) { const f = path.join(__dirname, 'img', u.pathname.split('/').pop()); return fs.existsSync(f) ? route.fulfill({ path: f, contentType: 'image/jpeg' }) : route.fulfill({ status: 404 }); }
      return route.abort();
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    p.on('dialog', (d) => d.accept());
    return p;
  }
  const snap = async (p, n, full) => { await p.waitForTimeout(450); await p.screenshot({ path: path.join(shots, n + '.png'), fullPage: !!full }); };
  const PID = '503533995202';

  // Анна: welcome gift, then hints a product
  const a = await page();
  await a.goto(base + '/' + launch(1)); await a.waitForSelector('.welcome-card');
  console.log('welcome:', (await a.locator('.welcome-card b').first().textContent()).trim());
  await snap(a, '01-welcome');
  await a.click('[data-action=welcomeOk]'); await a.waitForTimeout(200);
  console.log('welcome hidden after OK:', await a.locator('.welcome-card').count() === 0);
  await a.goto(base + '/#/p/' + PID); await a.waitForSelector('[data-action=hint]');
  await a.locator('[data-action=hint]').scrollIntoViewIfNeeded(); await snap(a, '02-product-share');
  await a.click('[data-action=hint]'); await a.waitForTimeout(200);
  const hint = await a.evaluate(() => window.__shared);
  console.log('hint text:', hint.text, '| link:', hint.link);

  // Олег opens the hint → product with banner, gets friend's bonus, orders as a gift
  const sp = hint.link.split('startapp=')[1];
  const o = await page();
  await o.goto(base + '/' + launch(2, sp)); await o.waitForSelector('.hint-banner');
  console.log('hint banner:', (await o.locator('.hint-banner').textContent()).trim());
  await snap(o, '03-hint-opened');
  await o.click('[data-action=pdpAdd]');
  await o.goto(base + '/#/checkout'); await o.waitForSelector('[data-input="co.name"]');
  await o.fill('[data-input="co.phone"]', '+7 900 222-33-44');
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Irkutsk' }).format(new Date(Date.now() + 864e5));
  await o.fill('[data-input="co.date"]', tomorrow); await o.dispatchEvent('[data-input="co.date"]', 'input');
  await o.click('[data-action=slot][data-t="14:00"]');
  await o.check('[data-input="co.isGift"]'); await o.fill('[data-input="co.giftTo"]', 'Ане'); await o.fill('[data-input="co.giftText"]', 'Намёк понят 😉 С любовью!');
  await o.check('[data-input="co.consent"]');
  await snap(o, '04-checkout-gift', true);
  await o.click('[data-action=submitOrder]'); await o.waitForSelector('[data-action=sendGift]');
  await snap(o, '05-done-gift');
  await o.click('[data-action=sendGift]'); await o.waitForTimeout(200);
  const gift = await o.evaluate(() => window.__shared);
  console.log('gift link:', gift.link);

  // Маша (new person) opens the gift card
  const m = await page();
  await m.goto(base + '/' + launch(3, gift.link.split('startapp=')[1])); await m.waitForSelector('.gift-card');
  console.log('gift card:', (await m.locator('.gift-card').innerText()).replace(/\n+/g, ' | '));
  await snap(m, '06-gift-card');

  // Owner: sources + QR
  const w = await page();
  await w.goto(base + '/' + launch(77)); await w.waitForSelector('.hero');
  await w.goto(base + '/#/admin/promo'); await w.waitForSelector('[data-action=addSource]');
  await w.fill('[name=stitle]', 'Наклейка на коробке'); await w.click('[data-action=addSource]');
  await w.waitForSelector('.src-card');
  const link = await w.locator('.src-link').first().textContent();
  console.log('source link:', link);
  const s4 = await page(); await s4.goto(base + '/' + launch(4, link.split('startapp=')[1])); await s4.waitForSelector('.hero');
  await w.goto(base + '/#/admin/orders'); await w.goto(base + '/#/admin/promo'); await w.waitForSelector('.src-card img[src^=blob]');
  console.log('source stats:', (await w.locator('.src-stats').first().innerText()).replace(/\n/g, ' '));
  await snap(w, '07-admin-sources', true);
  console.log('Anna (referrer) customer source of Oleg:', app.customers.get(2).source, '| referredBy:', app.customers.get(2).referredBy);
  console.log('page errors:', errs.length ? errs : 'none');
  await b.close(); app.server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
