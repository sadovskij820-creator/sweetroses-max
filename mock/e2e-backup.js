// Browser check of «Резервные копии» in the admin. Usage: node mock/e2e-backup.js
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
  const docs = [];
  const bot = { sendDocument: async (chat, buf, name, caption) => { docs.push({ chat, name, size: buf.length }); }, sendMessage: async (chat, text) => { sent.push({ chat: String(chat), text }); }, sendPhotos: async (chat, urls, caption) => { photos.push({ chat, urls, caption }); }, setWebAppUrl() {}, getUsername: () => 'gagulya_flowers_bot' };
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
  const shots = path.join(__dirname, 'shots-backup'); fs.mkdirSync(shots, { recursive: true });
  const errs = [];
  const page = async (c) => { const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text()) && errs.push(m.text())); return p; };
  const p = await page(ctx);
  const snap = async (pg, n, full) => { await pg.waitForTimeout(400); await pg.screenshot({ path: path.join(shots, n + '.png'), fullPage: !!full }); };

  await p.goto(base + '/' + launch(77)); await p.waitForSelector('.hero');
  await p.goto(base + '/#/admin/settings'); await p.waitForSelector('text=Резервные копии'); await p.waitForTimeout(500);
  await p.locator('text=Резервные копии').scrollIntoViewIfNeeded(); await snap(p, '01-before');
  await p.click('[data-action=backupNow]'); await p.waitForSelector('text=отправлена в чат'); await p.waitForTimeout(300);
  await p.locator('text=Резервные копии').scrollIntoViewIfNeeded(); await snap(p, '02-after');
  console.log('sent:', JSON.stringify(docs));
  console.log('JS errors:', errs.length ? errs : 'none');
  await b.close(); app.server.close();
})().catch((e) => { console.error(e); process.exit(1); });
