// Full browser run of the loyalty build on a MAX Bridge stub. Usage: node mock/e2e-loyalty.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const { createApp } = require('../server/index');
const max = require('../server/max');

const TOKEN = 'max-e2e-token';
const BRIDGE_STUB = fs.readFileSync(path.join(__dirname, 'e2e-max.js'), 'utf8').match(/const BRIDGE_STUB = `([\s\S]*?)`;/)[1]
  .replace("requestContact:", "shareMaxContent: function(o){ window.__shared = o; return Promise.resolve({ status: 'shared' }); }, requestContact:");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-loy-'));
  const sent = [];
  const bot = { sendMessage: async (chat, text, ex) => { sent.push({ chat: String(chat), text, ex }); }, setWebAppUrl() {}, getUsername: () => 'cr_demo_bot', openButton: (t) => [[{ type: 'open_app', text: t, web_app: 'cr_demo_bot' }]] };
  const app = createApp({ messenger: 'max', botToken: TOKEN, adminIds: '', dataDir, bot, log: { error: console.error, log() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.claimOwner({ id: 77 });
  // demo payments on
  const s = app.store.getCatalog().settings; s.payments = { enabled: true, provider: 'demo' }; app.store.setCatalog(app.store.getCatalog());

  const launch = (id, sp) => '#WebAppData=' + encodeURIComponent(max.signInitData({ id, first_name: { 77: 'Илья', 10: 'Марина', 11: 'Анна' }[id] || 'Гость', username: 'u' + id }, TOKEN, Math.floor(Date.now() / 1000), sp ? { start_param: sp } : {})) + '&WebAppPlatform=android&WebAppVersion=26.2.8';
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const shots = path.join(__dirname, 'shots-loyalty'); fs.mkdirSync(shots, { recursive: true });
  const errs = [];
  async function page() {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await ctx.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin === base) return route.continue();
      if (u.hostname === 'st.max.ru') return route.fulfill({ body: BRIDGE_STUB, contentType: 'text/javascript' });
      if (u.hostname.endsWith('tildacdn.com')) { const f = path.join(__dirname, 'img', u.pathname.split('/').pop()); return fs.existsSync(f) ? route.fulfill({ path: f, contentType: 'image/jpeg' }) : route.fulfill({ status: 404 }); }
      return route.abort();
    });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    p.on('dialog', (d) => d.accept());
    return p;
  }
  const snap = async (p, n, full) => { await p.waitForTimeout(400); await p.screenshot({ path: path.join(shots, n + '.png'), fullPage: !!full }); };

  // 1. Марина opens the app, gets her referral link
  const m = await page();
  await m.goto(base + '/' + launch(10)); await m.waitForSelector('.hero');
  await m.goto(base + '/#/profile'); await m.waitForSelector('[data-action=shareRef]');
  await m.click('[data-action=shareRef]'); await m.waitForTimeout(200);
  const shared = await m.evaluate(() => window.__shared);
  console.log('shared link:', shared && shared.link);
  const ref = shared.link.split('startapp=')[1];

  // 2. Анна opens by Марина's link → 300 bonuses
  const a = await page();
  await a.goto(base + '/' + launch(11, ref)); await a.waitForSelector('.loyal-card');
  console.log('Anna balance on home:', (await a.locator('.lc-bal b').textContent()).trim());
  await snap(a, '01-home-bonus');
  // profile: add an important date
  await a.goto(base + '/#/profile'); await a.waitForSelector('form[data-form=date]');
  await a.fill('form[data-form=date] [name=title]', 'ДР мамы');
  await a.selectOption('form[data-form=date] [name=day]', '12'); await a.selectOption('form[data-form=date] [name=month]', '3');
  await a.click('form[data-form=date] button[type=submit]'); await a.waitForSelector('.date-row');
  await snap(a, '02-profile', true);
  // order with bonuses + demo payment
  await a.goto(base + '/#/p/503533995202'); await a.click('text=Руби'); await a.click('[data-action=pdpAdd]');
  await a.goto(base + '/#/checkout'); await a.waitForSelector('[data-input="co.name"]');
  await a.fill('[data-input="co.phone"]', '+7 900 111-22-33');
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Irkutsk' }).format(new Date(Date.now() + 864e5));
  await a.fill('[data-input="co.date"]', tomorrow); await a.dispatchEvent('[data-input="co.date"]', 'input');
  await a.click('[data-action=slot][data-t="14:00"]');
  await a.check('[data-input="co.useBonus"]'); await a.check('[data-input="co.consent"]'); await a.check('[data-input="co.marketing"]');
  console.log('to pay:', (await a.locator('.summary .total .price').textContent()).trim(), '| button:', (await a.locator('[data-action=submitOrder]').textContent()).trim());
  await snap(a, '03-checkout-bonus', true);
  await a.click('[data-action=submitOrder]'); await a.waitForSelector('.pay-card');
  await snap(a, '04-demo-pay');
  console.log('manager notified before payment:', sent.some((x) => x.chat === '77' && /Новая заявка/.test(x.text)));
  await a.click('[data-action=demoPay]'); await a.waitForSelector('.success-mark', { timeout: 8000 });
  console.log('done title:', (await a.locator('h1').textContent()).trim());
  await snap(a, '05-paid');
  const toOwner = sent.find((x) => x.chat === '77' && /Новая заявка/.test(x.text));
  console.log('owner message:', toOwner && toOwner.text.replace(/\n/g, ' | ').slice(0, 220));

  // 3. Owner: mark done → bonuses; customers; broadcast; loyalty settings
  const o = await page();
  await o.goto(base + '/' + launch(77)); await o.waitForSelector('.hero');
  await o.goto(base + '/#/admin/orders'); await o.waitForSelector('.order');
  await snap(o, '06-admin-orders');
  await o.click('[data-action=orderStatus][data-s=done]'); await o.waitForTimeout(500);
  console.log('Anna told about bonuses:', sent.some((x) => x.chat === '11' && /Начислено/.test(x.text)));
  console.log('Marina rewarded:', sent.some((x) => x.chat === '10' && /друг/i.test(x.text)));
  await o.goto(base + '/#/admin/customers'); await o.waitForSelector('.cust-row');
  await snap(o, '07-admin-customers');
  await o.click('.cust-row >> text=Анна'); await o.waitForSelector('form[data-form=custBonus]');
  await o.fill('form[data-form=custBonus] [name=delta]', '200'); await o.fill('form[data-form=custBonus] [name=comment]', 'Комплимент от мастерской');
  await o.click('form[data-form=custBonus] button[type=submit]'); await o.waitForTimeout(500);
  await snap(o, '08-admin-customer', true);
  await o.goto(base + '/#/admin/broadcast'); await o.waitForSelector('form[data-form=broadcast]');
  await o.fill('form[data-form=broadcast] [name=text]', 'К 8 Марта — наборы со скидкой 10%! Успейте заказать заранее 🌷');
  await snap(o, '09-admin-broadcast');
  await o.click('form[data-form=broadcast] button[type=submit]'); await o.waitForTimeout(800);
  console.log('broadcast delivered to Anna (consent):', sent.some((x) => x.chat === '11' && /8 Марта/.test(x.text)), '| to Marina (no consent):', sent.some((x) => x.chat === '10' && /8 Марта/.test(x.text)));
  await o.goto(base + '/#/admin/loyalty'); await o.waitForSelector('form[data-form=loyalty]');
  await snap(o, '10-admin-loyalty', true);

  // 4. Anna sees new balance and repeat
  {
  const a2 = await page(); await a2.goto(base + '/' + launch(11)); await a2.waitForSelector('.loyal-card'); const a = a2;
  await a.waitForTimeout(500);
  { const L = require('../server/loyalty'); const c = app.customers.get(11); console.log('server balance:', L.balance(c), JSON.stringify(c.history.slice(0,4))); }
  console.log('Anna balance after done + gift:', (await a.locator('.lc-bal b').textContent()).trim());
  await a.click('[data-action=repeatOrder]'); await a.waitForSelector('text=Оформить заказ');
  console.log('repeat → cart items:', await a.locator('.cart-line, .line').count());
  await snap(a, '11-repeat-cart');
  }
  // jobs: date reminder
  const md = new Date(Date.now() + 3 * 864e5);
  console.log('page errors:', errs.length ? errs : 'none');
  await b.close(); app.server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
