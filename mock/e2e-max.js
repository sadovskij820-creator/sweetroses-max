// Browser check of the MAX build: real server + a stub of MAX Bridge (st.max.ru is not reachable from the sandbox).
// Usage: node mock/e2e-max.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const { createApp } = require('../server/index');
const max = require('../server/max');

const TOKEN = 'max-e2e-token';
const BRIDGE_STUB = `(function(){
  var h = location.hash.replace(/^#/, ''); var i = h.indexOf('WebAppData=');
  var raw = i < 0 ? '' : h.slice(i + 11).split('&WebAppPlatform=')[0];
  raw = decodeURIComponent(raw);
  var p = new URLSearchParams(raw); var user = null; try { user = JSON.parse(p.get('user')); } catch (e) {}
  var back = []; window.__backVisible = false; window.__ready = false;
  window.WebApp = { initData: raw, initDataUnsafe: { user: user, start_param: p.get('start_param') }, platform: 'android', version: '26.2.8',
    ready: function(){ window.__ready = true; },
    BackButton: { show: function(){ window.__backVisible = true; }, hide: function(){ window.__backVisible = false; }, onClick: function(f){ back.push(f); } },
    HapticFeedback: { impactOccurred: function(){}, notificationOccurred: function(){}, selectionChanged: function(){} },
    openLink: function(u){ window.__opened = u; },
    requestContact: function(){ return Promise.resolve({ phone: '79001112233' }); } };
})();`;

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-e2e-'));
  const sent = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); }, setWebAppUrl() {} };
  const app = createApp({ messenger: 'max', botToken: TOKEN, adminIds: '', dataDir, bot, log: { error: console.error, log() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.store.getCatalog().settings.payments = { enabled: false, provider: 'demo' };
  console.log('owner claim:', app.claimOwner({ id: 77 }) ? 'ok' : 'FAIL');

  const launch = (id) => '#WebAppData=' + encodeURIComponent(max.signInitData({ id, first_name: id === 77 ? 'Илья' : 'Анна', username: 'u' + id }, TOKEN)) + '&WebAppPlatform=android&WebAppVersion=26.2.8';
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.origin === base) return route.continue();
    if (u.hostname === 'st.max.ru') return route.fulfill({ body: BRIDGE_STUB, contentType: 'text/javascript' });
    if (u.hostname.endsWith('tildacdn.com')) { const f = path.join(__dirname, 'img', u.pathname.split('/').pop()); return fs.existsSync(f) ? route.fulfill({ path: f, contentType: 'image/jpeg' }) : route.fulfill({ status: 404 }); }
    return route.abort();
  });
  const shots = path.join(__dirname, 'shots-max'); fs.mkdirSync(shots, { recursive: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  const snap = async (n) => { await p.waitForTimeout(350); await p.screenshot({ path: path.join(shots, n + '.png') }); };

  // customer opens the app from MAX
  await p.goto(base + '/' + launch(7)); await p.waitForSelector('.hero');
  console.log('bridge ready() called:', await p.evaluate(() => window.__ready));
  console.log('demo note:', await p.locator('.demo-note').textContent());
  await snap('01-home');
  await p.goto(base + '/#/p/503533995202'); await p.waitForSelector('[data-action=pdpAdd]');
  console.log('back button on product page:', await p.evaluate(() => window.__backVisible));
  await p.click('text=Руби'); await p.click('[data-action=pdpAdd]');
  await p.goto(base + '/#/cart'); await p.waitForSelector('text=Оформить заказ'); await snap('02-cart');
  await p.click('text=Оформить заказ'); await p.waitForSelector('[data-input="co.name"]');
  console.log('name prefilled from MAX:', await p.inputValue('[data-input="co.name"]'));
  const shareBtn = p.locator('[data-action=shareContact]');
  console.log('share button text:', (await shareBtn.textContent()).trim());
  await shareBtn.click(); await p.waitForTimeout(200);
  console.log('phone from MAX:', await p.inputValue('[data-input="co.phone"]'));
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Irkutsk' }).format(new Date(Date.now() + 864e5));
  await p.fill('[data-input="co.date"]', tomorrow); await p.dispatchEvent('[data-input="co.date"]', 'input');
  await p.click('[data-action=slot][data-t="14:00"]'); await p.check('[data-input="co.consent"]');
  await snap('03-checkout');
  await p.click('[data-action=submitOrder]'); await p.waitForSelector('.success-mark'); await snap('04-done');
  await new Promise((r) => setTimeout(r, 100));
  const toOwner = sent.find((s) => s.chat === '77'), toCustomer = sent.find((s) => s.chat === '7');
  console.log('owner got order in MAX:', !!toOwner, toOwner && toOwner.text.split('\n')[0]);
  console.log('owner message has MAX contact:', toOwner && /MAX: <a href="https:\/\/max\.ru\/u7">/.test(toOwner.text));
  console.log('customer got confirmation:', !!toCustomer);

  // owner opens the app: sees the gear and the order
  const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push(e.message));
  await p2.goto(base + '/' + launch(77)); await p2.waitForSelector('.hero');
  await p2.waitForFunction(() => document.getElementById('topRight').getAttribute('aria-label') === 'Управление', null, { timeout: 5000 });
  await p2.goto(base + '/#/admin/orders'); await p2.waitForSelector('.order');
  await p2.waitForTimeout(350); await p2.screenshot({ path: path.join(shots, '05-admin-orders.png') });
  await p2.goto(base + '/#/admin/settings'); await p2.waitForSelector('form[data-form=settings]');
  console.log('settings label mentions MAX:', /ID в MAX/.test(await p2.content()));
  await p2.waitForTimeout(350); await p2.screenshot({ path: path.join(shots, '06-admin-settings.png') });

  // dark theme follows the phone setting
  const ctxD = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await ctxD.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.origin === base) return route.continue(); if (u.hostname === 'st.max.ru') return route.fulfill({ body: BRIDGE_STUB, contentType: 'text/javascript' }); if (u.hostname.endsWith('tildacdn.com')) { const f = path.join(__dirname, 'img', u.pathname.split('/').pop()); return fs.existsSync(f) ? route.fulfill({ path: f, contentType: 'image/jpeg' }) : route.fulfill({ status: 404 }); } return route.abort(); });
  const p3 = await ctxD.newPage();
  await p3.goto(base + '/' + launch(8)); await p3.waitForSelector('.hero');
  console.log('dark theme:', await p3.evaluate(() => document.documentElement.dataset.theme));
  await p3.waitForTimeout(350); await p3.screenshot({ path: path.join(shots, '07-home-dark.png') });

  console.log('page errors:', errs.length ? errs : 'none');
  await b.close(); app.server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
