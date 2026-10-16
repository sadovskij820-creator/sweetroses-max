// Browser check of reviews (QR card in a bouquet → «Как вам букет?»). Usage: node mock/e2e-reviews.js
const { chromium } = require(process.env.PW || '/opt/npm-tools/node_modules/playwright');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gag-e2e-'));
  const sent = [], photos = [];
  const bot = { sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); }, sendPhotos: async (chat, urls, caption) => { photos.push({ chat, urls, caption }); }, setWebAppUrl() {}, getUsername: () => 'gagulya_flowers_bot' };
  const app = createApp({ messenger: 'max', botToken: TOKEN, adminIds: '', dataDir, bot, seedFile: path.join(__dirname, '..', 'seed', 'gagulya.seed.json'), log: { error: console.error, log() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  app.claimOwner({ id: 77 });
  const S = app.store.getCatalog().settings;
  S.transfer = { enabled: true, mode: 'now', card: '2200 7000 1234 5678', phone: '+7 900 000-11-22', bank: 'Т-Банк', holder: 'Иван Г.', note: '' };
  S.webAppUrl = 'https://gagulya.example.amvera.tech';
  app.store.setCatalog(app.store.getCatalog());

  const launch = (id, sp) => '#WebAppData=' + encodeURIComponent(max.signInitData({ id, first_name: id === 77 ? 'Владелец' : 'Анна', username: 'u' + id }, TOKEN, undefined, sp ? { start_param: sp } : {})) + '&WebAppPlatform=android&WebAppVersion=26.2.8';
  const b = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const mk = async (scheme) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: scheme || 'light' });
    await ctx.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.origin === base) return route.continue();
      if (u.hostname === 'st.max.ru') return route.fulfill({ body: BRIDGE_STUB, contentType: 'text/javascript' });
      return route.abort();
    });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    return ctx;
  };
  const ctx = await mk();
  const shots = path.join(__dirname, 'shots-reviews'); fs.mkdirSync(shots, { recursive: true });
  const errs = [];
  const page = async (c) => { const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text()) && errs.push(m.text())); return p; };
  const p = await page(ctx);
  const snap = async (pg, n, full) => { await pg.waitForTimeout(400); await pg.screenshot({ path: path.join(shots, n + '.png'), fullPage: !!full }); };

  S.map2gis = 'https://2gis.ru/irkutsk/firm/70000001097370571';
  app.store.setCatalog(app.store.getCatalog());
  // 1) a happy customer scans the QR on the card
  await p.goto(base + '/' + launch(7, 'rv_1-s_otzyv')); await p.waitForSelector('text=Как вам букет?');
  console.log('opened by QR:', await p.evaluate(() => location.hash));
  await snap(p, '01-form');
  await p.click('.star >> nth=4');
  await p.fill('textarea[name=text]', 'Очень свежие розы, красиво упаковали и привезли вовремя!');
  await p.check('[data-input=rvConsent]');
  await snap(p, '02-form-filled');
  await p.click('text=Отправить отзыв'); await p.waitForSelector('text=Спасибо за отзыв!');
  await snap(p, '03-done-good');
  await p.click('[data-action=rv2gis]'); await p.waitForTimeout(200);
  console.log('2GIS opened:', await p.evaluate(() => window.__opened), '| clipboard:', await p.evaluate(() => navigator.clipboard.readText()));
  // 2) an unhappy customer
  const p2 = await page(ctx);
  await p2.goto(base + '/' + launch(8, 'rv_1-s_otzyv')); await p2.waitForSelector('text=Как вам букет?');
  await p2.click('.star >> nth=1'); await p2.click('text=Отправить отзыв');
  console.log('empty bad review error:', await p2.locator('.err').innerText());
  await snap(p2, '04-bad-needs-text');
  await p2.fill('textarea[name=text]', 'Привезли на час позже, чем договаривались');
  await p2.click('text=Отправить отзыв'); await p2.waitForSelector('text=Спасибо, что рассказали честно');
  await snap(p2, '05-done-bad');
  console.log('managers got:', sent.map((m) => m.text.split('\n')[0]).join(' | '));
  // 3) the owner approves the good one
  const p3 = await page(ctx);
  await p3.goto(base + '/' + launch(77)); await p3.waitForSelector('.hero');
  await p3.goto(base + '/#/admin/reviews'); await p3.waitForSelector('text=QR для вкладыша');
  await p3.waitForTimeout(600);
  await snap(p3, '06-admin', true);
  await p3.click('text=Опубликовать'); await p3.waitForTimeout(500);
  await p3.click('[data-action=rvFilter][data-f=bad]'); await p3.waitForTimeout(200);
  await snap(p3, '07-admin-bad', true);
  // 4) the published review on the home page and in «Отзывы»
  await p.goto(base + '/#/'); await p.reload(); await p.waitForSelector('.hero'); await p.waitForTimeout(500);
  const block = await p.locator('.review-card').count();
  console.log('reviews on home:', block);
  await p.locator('text=Все отзывы').scrollIntoViewIfNeeded(); await snap(p, '08-home-reviews');
  await p.click('text=Все отзывы'); await p.waitForSelector('h1:has-text("Отзывы")'); await snap(p, '09-reviews');
  console.log('JS errors:', errs.length ? errs : 'none');
  await b.close(); app.server.close();
})().catch((e) => { console.error(e); process.exit(1); });
