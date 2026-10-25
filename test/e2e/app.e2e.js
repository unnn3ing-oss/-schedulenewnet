// 端到端：node test/e2e/app.e2e.js（不屬於 npm test；需要 playwright 與 Chromium）
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const SHOTS = process.env.SHOT_DIR || os.tmpdir();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = path.join(WEB, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(WEB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

let passed = 0;
const ok = (name) => { passed++; console.log('  ok -', name); };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}/index.html`;
  const ext = path.join(ROOT, 'extension');
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'snn-e2e-')), {
    headless: false, viewport: { width: 1280, height: 800 },
    args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox']
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(url);

  // 1 外掛狀態
  await page.waitForFunction(() => /外掛已連線/.test(document.getElementById('extText').textContent), null, { timeout: 15000 });
  ok('狀態標籤顯示外掛已連線：' + await page.textContent('#extText'));

  // 2 開彈窗
  await page.click('#newBtn');
  assert(await page.isVisible('#modal'));
  ok('開啟新增發文彈窗');

  // 3 版型與畫布尺寸
  const size = () => page.evaluate(() => [document.getElementById('editorCanvas').width, document.getElementById('editorCanvas').height]);
  assert.deepStrictEqual(await size(), [1080, 1080]);
  await page.click('[data-tpl="newsnet_intl"]');
  assert.deepStrictEqual(await size(), [1200, 675]);
  ok('國際＋ → 1200×675');
  const counter = await page.textContent('#lines .line:first-child .cnt');
  assert.match(counter, /\/10$/);
  await page.click('[data-tpl="newsnet_news"]');
  assert.deepStrictEqual(await size(), [1080, 1080]);
  ok('新聞 → 1080×1080');

  // 4 上傳照片、貼圖、馬賽克
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  await page.click('.fx-mosaic-tile');
  await page.click('.fx-sticker-tile >> nth=1');
  assert.strictEqual(await page.locator('.fx-item').count(), 2);
  ok('上傳照片、加貼圖與馬賽克');
  // 滾輪縮放不出錯、貼圖拖曳
  const box = await page.locator('.fx-sticker').first().boundingBox().catch(() => null);
  const st = page.locator('.fx-item.fx-sticker');
  const b = await st.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2 + 30, { steps: 4 }); await page.mouse.up();
  const b2 = await st.boundingBox();
  assert(Math.abs(b2.x - b.x - 40) < 3, '貼圖可拖曳 ' + JSON.stringify([b, b2]));
  await page.mouse.wheel(0, -300);
  ok('貼圖拖曳、滾輪縮放');

  // 5 匯出
  const dims = () => page.evaluate(async () => {
    const blob = await Editor.exportBlob();
    const bmp = await createImageBitmap(blob);
    return { w: bmp.width, h: bmp.height, type: blob.type };
  });
  assert.deepStrictEqual(await dims(), { w: 1080, h: 1080, type: 'image/jpeg' });
  await page.click('[data-tpl="newsnet_intl"]');
  assert.deepStrictEqual(await dims(), { w: 1200, h: 675, type: 'image/jpeg' });
  ok('exportBlob：1080×1080 與 1200×675，JPEG');
  await page.click('[data-tpl="newsnet_news"]');

  // 6 字數計數
  await page.fill('#lines .ln >> nth=0', '一二三四五六七八九十一二三四五');
  assert(!(await page.locator('#lines .line').first().getAttribute('class')).includes('over'));
  await page.fill('#lines .ln >> nth=0', '一二三四五六七八九十一二三四五六');
  assert((await page.locator('#lines .line').first().getAttribute('class')).includes('over'));
  assert.match(await page.textContent('#lines .line:first-child .cnt'), /16\/15/);
  await page.fill('#lines .ln >> nth=0', 'abcdefghijklmnopqrstuvwxyzabcd');   // 30 個半形 = 15
  assert(!(await page.locator('#lines .line').first().getAttribute('class')).includes('over'));
  ok('字數計數：16 全形字超過 15 變紅，半形 0.5');

  // 7 快速帶入（網路被擋，只測錯誤路徑）
  await page.fill('#url', 'https://news.tvbs.com.tw/life/3012345');
  await page.press('#url', 'Enter');
  await page.waitForFunction(() => /bad/.test(document.getElementById('urlHint').className), null, { timeout: 60000 });
  console.log('    帶入錯誤訊息：' + await page.textContent('#urlHint'));
  assert.strictEqual(await page.evaluate(() => App.state.articleId), '3012345');
  ok('快速帶入錯誤路徑顯示友善訊息、article_id 已解析');
  const rej = await page.evaluate(async () => [
    (await Ext.fetchImage('https://example.com/a.jpg')).error,
    (await Ext.fetchImage('http://img.tvbs.com.tw/a.jpg')).error,
    (await Ext.fetchImage('https://evil-tvbs.com.tw/a.jpg')).error,
    (await Ext.fetchImage('https://tvbs.com.tw.evil.com/a.jpg')).error
  ]);
  assert.deepStrictEqual(rej, ['host_not_allowed', 'host_not_allowed', 'host_not_allowed', 'host_not_allowed']);
  ok('fetchImage 拒絕非 tvbs.com.tw／非 https');

  // 8 截圖（桌面）
  await page.fill('#caption', '北北基桃明天照常上班上課！\n#颱風 #停班停課');
  await page.fill('#lines .ln >> nth=0', '颱風假最新！北北基桃');
  await page.fill('#lines .ln >> nth=1', '明天照常上班上課');
  await page.click('.pg >> nth=0 >> button >> nth=0');
  await page.click('.pg >> nth=2 >> button >> nth=0');
  await page.click('.pg >> nth=2 >> .pg-mode');
  await page.click('#modeMenu [data-m="sched"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, 'prA-desktop.png') });
  assert(await page.locator('#sendBtn').isDisabled());
  ok('粉專切換、排程選單；全部送出為停用；已截圖 prA-desktop.png');
  await page.keyboard.press('Escape');   // 先關時間視窗

  // 9 Esc 確認
  await page.keyboard.press('Escape');
  assert(await page.isVisible('#confirm'));
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.getElementById('confirm').contains(document.activeElement)), '焦點鎖在確認視窗');
  await page.keyboard.press('Escape');
  assert(!(await page.isVisible('#confirm')) && await page.isVisible('#modal'));
  await page.keyboard.press('Escape');
  await page.click('#cfLeave');
  assert(!(await page.isVisible('#modal')));
  ok('有內容時 Esc 先確認；焦點鎖定；放棄後關閉並清空');
  await page.click('#newBtn');
  assert.strictEqual(await page.inputValue('#url'), '');
  await page.keyboard.press('Escape');
  assert(!(await page.isVisible('#modal')), '沒有內容時 Esc 直接關閉');
  ok('沒有內容 Esc 直接關閉');

  // 10 純文字底圖
  await page.click('#newBtn');
  await page.click('[data-mode="text"]');
  assert(await page.isVisible('#textCanvas') && !(await page.isVisible('#editorCanvas')));
  assert.strictEqual(await page.locator('.sw').count(), 7);
  const px = () => page.evaluate(() => [...document.getElementById('textCanvas').getContext('2d').getImageData(3, 3, 1, 1).data].slice(0, 3).join(','));
  const before = await px();
  await page.locator('.sw >> nth=3').click();
  const after = await px();
  assert.notStrictEqual(before, after);
  assert.strictEqual(await page.getAttribute('.sw >> nth=3', 'aria-checked'), 'true');
  ok('純文字底圖：7 色票、切換改變底色（' + before + ' → ' + after + '）');
  await page.keyboard.press('Escape');

  // 11 手機
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#newBtn');
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg')).catch(() => {});
  await page.click('[data-mode="frame"]');
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  await page.click('.fx-sticker-tile >> nth=0');
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, getComputedStyle(document.getElementById('url')).fontSize, document.getElementById('modal').getBoundingClientRect().width]);
  assert.strictEqual(sw[0], sw[1], '沒有橫向捲動');
  assert.strictEqual(sw[2], '16px');
  assert.strictEqual(sw[3], 390);
  await page.evaluate(() => { document.querySelector('.m-body').scrollTop = 0; });
  await page.screenshot({ path: path.join(SHOTS, 'prA-mobile.png') });
  ok('手機：全螢幕、無橫向捲動、輸入 16px；已截圖 prA-mobile.png');

  assert.deepStrictEqual(errors, [], '頁面錯誤：' + errors.join('\n'));
  ok('沒有 page error / console error');
  await ctx.close(); server.close();
  console.log(`\n${passed} checks passed`);
})().catch(async e => { console.error('FAIL', e); server.close(); process.exit(1); });
