# Собирает плоскую версию проекта (все файлы в одной папке) для загрузки через веб-интерфейс хостинга.
import os, re, shutil, json, sys
src = os.path.dirname(os.path.abspath(__file__)); out = sys.argv[1]
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
def rd(p): return open(os.path.join(src, p), encoding='utf-8').read()
def wr(n, s): open(os.path.join(out, n), 'w', encoding='utf-8').write(s)
for f in ['store.js', 'stats.js', 'tilda.js', 'telegram.js', 'max.js', 'loyalty.js', 'payments.js', 'importer.js', 'backup.js']: wr(f, rd('server/' + f))
wr('qrcode.js', rd('server/vendor/qrcode.js'))
wr('orders.js', rd('server/orders.js').replace('require("../public/pricing.js")', 'require("./pricing.js")'))
idx = rd('server/index.js')
idx = idx.replace('require("../public/pricing.js")', 'require("./pricing.js")').replace('require("./vendor/qrcode.js")', 'require("./qrcode.js")')
idx = idx.replace('path.join(__dirname, "..", ".env")', 'path.join(__dirname, ".env")')
idx = idx.replace('publicDir: path.join(__dirname, "..", "public")', 'publicDir: __dirname')
import re as _re
idx, n = _re.subn(r'seedFile: opts\.seedFile \?\? path\.join\(__dirname, "\.\.", "seed", .*?\),\n', 'seedFile: opts.seedFile ?? path.join(__dirname, "catalog.seed.json"),\n', idx)
assert n == 1, "seedFile line not found"
idx = idx.replace('path.join(__dirname, "..", "data")', 'path.join(__dirname, "data")')
# only browser files may be served from the flat folder
idx = idx.replace('    if (!file.startsWith(config.publicDir) ||', '    if (!/^\\/(index\\.html|app\\.js|pricing\\.js|styles\\.css|fonts\\.css|[a-z0-9-]+\\.woff2|demo-[a-z0-9-]+\\.jpg)$/.test(rel) || !file.startsWith(config.publicDir) ||')
# demo pictures (/demo/x.jpg) lie next to index.js as demo-x.jpg
idx = idx.replace('    if (rel === "/" || rel === "") rel = "/index.html";', '    if (rel === "/" || rel === "") rel = "/index.html";\n    rel = rel.replace(/^\\/demo\\/([a-z0-9-]+\\.jpg)$/, "/demo-$1");')
assert 'demo-$1' in idx
assert 'index\\.html|app' in idx and 'publicDir: __dirname' in idx and '"./pricing.js"' in idx
wr('index.js', idx)
for f in ['app.js', 'pricing.js', 'styles.css']: wr(f, rd('public/' + f))
wr('index.html', rd('public/index.html').replace('href="fonts/fonts.css"', 'href="fonts.css"'))
wr('fonts.css', rd('public/fonts/fonts.css'))
for f in os.listdir(os.path.join(src, 'public/fonts')):
    if f.endswith('.woff2'): shutil.copy(os.path.join(src, 'public/fonts', f), out)
SEED = os.environ.get('SEED', 'catalog')  # SEED=gagulya → shop Gagulya Flowers
seed = json.loads(rd('seed/' + SEED + '.seed.json'))
if os.path.isdir(os.path.join(src, 'public/demo')) and SEED != 'catalog':
    for f in os.listdir(os.path.join(src, 'public/demo')): shutil.copy(os.path.join(src, 'public/demo', f), os.path.join(out, 'demo-' + f))
seed['settings']['ownerIds'] = [int(x) for x in os.environ.get('OWNER_IDS', '').split(',') if x]
if os.path.exists(os.path.join(src, 'certs')):
    for f in os.listdir(os.path.join(src, 'certs')): shutil.copy(os.path.join(src, 'certs', f), out)
imp = os.path.join(src, 'seed', SEED + '.import.json')
if SEED != 'catalog' and os.path.exists(imp):
    shutil.copy(imp, os.path.join(out, 'catalog.import.json'))
    for f in json.load(open(imp, encoding='utf-8')).get('products', []):
        for ph in f.get('photos', []): shutil.copy(os.path.join(src, 'seed', 'import', ph), os.path.join(out, ph))
json.dump(seed, open(os.path.join(out, 'catalog.seed.json'), 'w', encoding='utf-8'), ensure_ascii=False)
pk = json.loads(rd('package.json')); pk['main'] = 'index.js'; pk['scripts'] = {'start': 'node index.js'}
wr('package.json', json.dumps(pk, ensure_ascii=False, indent=2))
wr('amvera.yml', 'meta:\n  environment: node\n  toolchain:\n    name: npm\n    version: 20\n\nrun:\n  scriptName: index.js\n  containerPort: 3000\n  persistenceMount: /data\n')
print(sorted(os.listdir(out)))
