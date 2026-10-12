const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', 'public');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'catalog.seed.json')));
const theme = process.argv[2] || 'light';
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(([c, t]) => { window.__CATALOG = c; window.__MOCK = true; document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = t; }); }, [catalog, theme]);
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'app.local') {
      const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
      return fs.existsSync(f) ? route.fulfill({ path: f }) : route.fulfill({ status: 404 });
    }
    if (u.hostname.endsWith('tildacdn.com')) {
      const name = u.pathname.split('/').pop();
      const f = path.join(__dirname, 'img', name);
      return fs.existsSync(f) ? route.fulfill({ path: f, contentType: 'image/jpeg' }) : route.fulfill({ status: 404 });
    }
    return route.abort();
  });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
  const shot = async (name, hash, before) => {
    await p.goto('http://app.local/' + hash); await p.waitForTimeout(500);
    if (before) await before(); await p.waitForTimeout(400);
    await p.screenshot({ path: `mock/shots/${theme}-${name}.png` });
  };
  await shot('1-home', '#/');
  await shot('2-home-gifts', '#/', () => p.evaluate(() => window.scrollTo(0, document.querySelector('.h2:nth-of-type(2)') ? document.querySelectorAll('.h2')[1].offsetTop - 80 : 900)));
  await shot('3-catalog', '#/catalog/chocolate');
  await shot('4-product', '#/p/503533995202', async () => { await p.click('text=Руби'); await p.click('text=Белый'); });
  await shot('5-cart', '#/p/503533995202', async () => {
    await p.click('text=Молочный'); await p.click('[data-action=pdpAdd]');
    await p.evaluate(() => location.hash = '#/p/255677953192'); await p.waitForTimeout(300); await p.click('[data-action=pdpAdd]');
    await p.evaluate(() => location.hash = '#/cart'); await p.waitForTimeout(300);
    await p.click('[data-action=addonQty][data-id=card]'); await p.fill('[data-input=cardText]', 'С днём рождения, мама!');
    await p.fill('[data-input=promo]', 'клубника'); await p.click('[data-action=applyPromo]');
  });
  await shot('6-checkout', '#/checkout', async () => { await p.click('[data-m=delivery]'); });
  console.log('errors:', errs);
  await b.close();
})();
