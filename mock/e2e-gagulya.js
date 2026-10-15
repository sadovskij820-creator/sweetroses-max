// Browser check of the Gagulya build (black-and-white brand, delivery zones, payment by transfer). Usage: node mock/e2e-gagulya.js
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

  const launch = (id) => '#WebAppData=' + encodeURIComponent(max.signInitData({ id, first_name: id === 77 ? 'Владелец' : 'Анна', username: 'u' + id }, TOKEN)) + '&WebAppPlatform=android&WebAppVersion=26.2.8';
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
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
  const shots = path.join(__dirname, 'shots-gagulya'); fs.mkdirSync(shots, { recursive: true });
  const errs = [];
  const page = async (c) => { const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text()) && errs.push(m.text())); return p; };
  const p = await page(ctx);
  const snap = async (pg, n, full) => { await pg.waitForTimeout(400); await pg.screenshot({ path: path.join(shots, n + '.png'), fullPage: !!full }); };

  await p.goto(base + '/' + launch(7)); await p.waitForSelector('.hero');
  console.log('brand:', await p.title(), '| theme:', await p.evaluate(() => document.documentElement.dataset.brand), '| monogram:', await p.locator('.monogram').innerText());
  await snap(p, '01-home');
  await p.click('.card [data-action=quickAdd] >> nth=0');
  await p.goto(base + '/#/cart'); await p.waitForSelector('text=Оформить заказ');
  console.log('cart delivery note:', (await p.locator('.summary .r >> nth=1').innerText()).replace(/\s+/g, ' '));
  await p.click('text=Оформить заказ'); await p.waitForSelector('[data-input="co.name"]');
  await p.fill('[data-input="co.phone"]', '+7 900 111-22-33');
  await p.click('[data-action=method][data-m=delivery]');
  await p.waitForSelector('.zones');
  console.log('zones shown:', await p.locator('.zone b').allInnerTexts());
  await p.click('[data-action=zone] >> text=Ленинский');
  await p.fill('[data-input="co.address"]', 'ул. Ленина, 1, кв. 5');
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Irkutsk' }).format(new Date(Date.now() + 864e5));
  await p.fill('[data-input="co.date"]', tomorrow); await p.dispatchEvent('[data-input="co.date"]', 'input');
  await p.click('[data-action=slot][data-t="14:00"]'); await p.check('[data-input="co.consent"]');
  console.log('total line:', (await p.locator('.summary .r.total').innerText()).replace(/\s+/g, ' '));
  console.log('button:', (await p.locator('[data-action=submitOrder]').innerText()).trim());
  await p.locator('.zones').scrollIntoViewIfNeeded(); await snap(p, '02-checkout-zones');
  await p.locator('.summary').scrollIntoViewIfNeeded(); await snap(p, '03-checkout-total');
  await p.click('[data-action=submitOrder]'); await p.waitForSelector('.req-row');
  console.log('transfer screen sum:', await p.locator('.pay-sum').innerText());
  await snap(p, '04-transfer');
  await p.click('.req-row >> nth=0 >> text=Копировать');
  console.log('copied:', await p.evaluate(() => navigator.clipboard.readText()));
  await p.click('[data-action=transferDone]'); await p.waitForSelector('.success-mark');
  await snap(p, '05-done-claimed');
  await p.goto(base + '/#/profile'); await p.waitForSelector('text=Мои заказы'); await p.waitForTimeout(500);
  console.log('profile order:', (await p.locator('.order >> nth=0').innerText()).replace(/\s+/g, ' ').slice(0, 120));
  await new Promise((r) => setTimeout(r, 100));
  console.log('owner messages:', sent.filter((s) => s.chat === '77').map((s) => s.text.split('\n')[0]));
  console.log('photos to owner:', photos.map((x) => x.urls.length + ' фото: ' + x.caption));

  // owner: orders with photo, payment badge, «Оплата получена»
  const p2 = await page(ctx);
  await p2.goto(base + '/' + launch(77)); await p2.waitForSelector('.hero');
  await p2.waitForFunction(() => document.getElementById('topRight').getAttribute('aria-label') === 'Управление', null, { timeout: 5000 });
  await p2.goto(base + '/#/admin/orders'); await p2.waitForSelector('.order-pics');
  console.log('admin badge:', await p2.locator('.pay-badge').innerText());
  await snap(p2, '06-admin-order');
  p2.once('dialog', (d) => d.accept());
  await p2.click('[data-action=orderPaid]'); await p2.waitForSelector('.pay-badge.ok');
  console.log('after confirm:', await p2.locator('.pay-badge').innerText());
  await new Promise((r) => setTimeout(r, 100));
  console.log('customer told:', sent.filter((s) => s.chat === '7').map((s) => s.text.split('\n')[0]));
  // owner edits zones
  await p2.goto(base + '/#/admin/settings'); await p2.waitForSelector('form[data-form=zones]');
  await snap(p2, '07-admin-zones');
  await p2.click('[data-action=addZone]');
  const last = p2.locator('.zone-row').last();
  await last.locator('[name=zname]').fill('Солнечный'); await last.locator('[name=zprice]').fill('450'); await last.locator('[name=zfrom]').fill('50'); await last.locator('[name=zto]').fill('70');
  await p2.locator('.zone-row').first().locator('[data-action=delZone]').click();
  await p2.click('text=Сохранить районы'); await p2.waitForTimeout(600);
  console.log('zones saved:', app.store.getCatalog().settings.zones.map((z) => `${z.name} ${z.price}₽ ${z.from}-${z.to}`));
  // owner adds a photo from the phone gallery to a product
  await p2.goto(base + '/#/admin/edit/g2'); await p2.waitForSelector('[data-photos]');
  await p2.setInputFiles('[data-upload]', [path.join(__dirname, '..', 'public', 'demo', 'gagulya-5.jpg'), path.join(__dirname, '..', 'public', 'demo', 'gagulya-7.jpg')]);
  await p2.waitForFunction(() => document.querySelectorAll('[data-photos] .photo-tile[data-url^="/u/"]').length === 2, null, { timeout: 8000 });
  await p2.click('[data-photos] .photo-tile >> nth=2 >> [data-action=photoLeft]');
  await p2.click('[data-photos] .photo-tile >> nth=1 >> [data-action=photoDel]');
  await p2.locator('[data-photos]').scrollIntoViewIfNeeded(); await snap(p2, '11-admin-photos');
  await p2.click('text=Сохранить изменения'); await p2.waitForTimeout(700);
  const g2 = app.store.getCatalog().products.find((x) => x.id === 'g2');
  console.log('product photos after upload:', g2.images);
  console.log('uploaded file served:', (await fetch(base + g2.images[1])).status);
  // owner edits card
  await p2.goto(base + '/#/admin/pay'); await p2.waitForSelector('form[data-form=transfer]');
  console.log('owner tabs:', (await p2.locator('.admin-tabs .chip').allInnerTexts()).join(' | '));
  await snap(p2, '08-admin-transfer');
  await p2.fill('[name=tCard]', '5536 9100 0000 0000'); await p2.click('[data-action=tMode][data-m=after]');
  await p2.click('text=Сохранить оплату переводом'); await p2.waitForTimeout(600);
  console.log('transfer saved:', JSON.stringify(app.store.getCatalog().settings.transfer));

  // staff: invite a manager
  await p2.goto(base + '/#/admin/staff'); await p2.waitForSelector('[data-action=staffInvite]');
  await p2.click('[data-action=staffInvite]'); await p2.waitForSelector('.src-link');
  const link = await p2.locator('.src-link').innerText();
  console.log('invite link:', link);
  console.log('accept:', app.onBotStart({ id: 55, first_name: 'Маша' }, link.split('start=')[1]).text.trim().split('\n')[0]);
  await p2.goto(base + '/#/admin/orders'); await p2.goto(base + '/#/admin/staff'); await p2.waitForSelector('[data-action=staffRemove]');
  await snap(p2, '12-admin-staff');
  // the manager sees fewer tabs
  const pm = await page(ctx);
  await pm.goto(base + '/' + launch(55)); await pm.waitForSelector('.hero');
  await pm.waitForFunction(() => document.getElementById('topRight').getAttribute('aria-label') === 'Управление', null, { timeout: 5000 });
  await pm.goto(base + '/#/admin/orders'); await pm.waitForSelector('.admin-tabs');
  console.log('manager tabs:', (await pm.locator('.admin-tabs .chip').allInnerTexts()).join(' | '));
  // dark theme
  const ctxD = await mk('dark');
  const p3 = await page(ctxD);
  await p3.goto(base + '/' + launch(8)); await p3.waitForSelector('.hero');
  await snap(p3, '09-home-dark');
  await p3.goto(base + '/#/catalog/all'); await p3.waitForSelector('.card'); await snap(p3, '10-catalog-dark');

  console.log('page errors:', errs.length ? errs : 'none');
  await b.close(); app.server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
