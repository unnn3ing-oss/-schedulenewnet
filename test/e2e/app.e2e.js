// 端到端：node test/e2e/app.e2e.js（不屬於 npm test；需要 playwright 與 Chromium）
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const SHOTS = process.env.SHOT_DIR || os.tmpdir();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ttf': 'font/ttf' };
const TITLE3 = '金鐘61／《飢餓》10週年大禮！\n峮峮驚喜合體遭催回歸\n蔡黃汝羞謝「好友」閃瞎全場';
// 畫布上某點的顏色（預覽畫布或匯出的 JPEG）
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= (tol || 24));
const BLUE = [0, 56, 148], PINK = [253, 183, 242];   // frames/news.png、ent.png 右上角
async function previewPx(page, x, y) {
  return page.evaluate(([x, y]) => [...document.getElementById('editorCanvas').getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3), [x, y]);
}
async function exportInfo(page, pts) {
  return page.evaluate(async pts => {
    const blob = await Editor.exportBlob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let h = 0; for (const b of buf) h = (h * 31 + b) >>> 0;
    return { w: bmp.width, h: bmp.height, type: blob.type, hash: h, px: pts.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3)) };
  }, pts);
}
// 每行字數在框外右側、和該行對齊（誤差 2px 內）
async function counterGeom(page) {
  return page.evaluate(() => {
    const ta = document.getElementById('title'), cs = getComputedStyle(ta), r = ta.getBoundingClientRect();
    const lh = parseFloat(cs.lineHeight), top0 = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) - ta.scrollTop;
    return [...document.querySelectorAll('#titleCnts span')].map((s, i) => {
      const b = s.getBoundingClientRect();
      return { i, text: s.textContent, over: s.classList.contains('over'), dy: Math.abs((b.top + b.height / 2) - (top0 + i * lh + lh / 2)), outside: b.left >= r.right };
    });
  });
}

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

  // 3 版型只有新聞（藍框）／娛樂（粉框），預設藍框；畫布一律 1080×1080
  const size = () => page.evaluate(() => [document.getElementById('editorCanvas').width, document.getElementById('editorCanvas').height]);
  assert.deepStrictEqual(await size(), [1080, 1080]);
  assert.deepStrictEqual(await page.$$eval('#frameSwitch button', bs => bs.map(b => b.textContent)), ['新聞（藍框）', '娛樂（粉框）']);
  assert.strictEqual(await page.textContent('#frameSwitch .active'), '新聞（藍框）');
  assert.strictEqual(await page.locator('[data-tpl], #guides, #guideToggle, #addLineBtn, #cardText, #lines').count(), 0, '舊的五種版型、標題區參考線、分行輸入都拿掉了');
  assert(near(await previewPx(page, 1060, 20), BLUE), '預覽右上角是藍框');
  await page.click('[data-frame="ent"]');
  assert(near(await previewPx(page, 1060, 20), PINK), '切粉框 → 預覽右上角變粉紅');
  assert.deepStrictEqual(await size(), [1080, 1080]);
  await page.click('[data-frame="news"]');
  assert(near(await previewPx(page, 1060, 20), BLUE));
  ok('藍框／粉框切換預覽疊圖，畫布維持 1080×1080');

  // UX 規範：沒照片時照片相關按鈕直接隱藏；送出鈕是主色且沒勾粉專時有提示；AI 兩顆分主副；按下去有縮放回饋
  for (const id of ['#clearImgBtn', '#previewBtn', '#fxBtn']) assert(await page.isHidden(id), id + ' 沒照片時隱藏');
  assert(await page.isVisible('#pickBtn'));
  assert.match(await page.getAttribute('#sendBtn', 'class'), /\bprimary\b/);
  assert(await page.locator('#sendBtn').isDisabled());
  assert(await page.isVisible('#sendTip'), '沒勾粉專時說明為什麼不能送');
  assert.doesNotMatch(await page.getAttribute('#aiGenBtn', 'class'), /ghost/);
  assert.match(await page.getAttribute('#aiFixBtn', 'class'), /\bghost\b/);
  const pressed = await page.evaluate(() => [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => /\.btn:active/.test(r.selectorText || '') && /scale/.test(r.cssText)); } catch (e) { return false; } }));
  assert(pressed, '.btn:active 有按壓縮放');
  ok('沒照片隱藏照片工具、送出鈕主色＋提示、AI 主副按鈕、按壓回饋');

  // 4 上傳照片、貼圖、馬賽克
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  for (const id of ['#clearImgBtn', '#previewBtn', '#fxBtn']) assert(await page.isVisible(id), id + ' 有照片才出現');
  assert(await page.isHidden('#fxBar'), 'T寶／馬賽克平常收起來');
  await page.click('#fxBtn');
  await page.click('.fx-mosaic-tile');
  assert(await page.isHidden('#fxBar'), '加一個就收起來');
  await page.click('#fxBtn');
  await page.keyboard.press('Escape');
  assert(await page.isHidden('#fxBar') && await page.isVisible('#modal'), 'Esc 只收起貼圖列，不關新增發文');
  await page.click('#fxBtn');
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

  // 5 匯出（上傳圖床的圖）：不含疊圖、不含標題
  await page.fill('#title', TITLE3);
  await page.evaluate(() => document.fonts.load('67px "WHZ-Heavy"'));
  assert(await page.evaluate(() => document.fonts.check('67px "WHZ-Heavy"')), 'WHZ-Heavy 字型已載入');
  const PTS = [[1060, 20], [540, 880]];
  const ex1 = await exportInfo(page, PTS);
  assert.deepStrictEqual([ex1.w, ex1.h, ex1.type], [1080, 1080, 'image/jpeg']);
  const pv = await previewPx(page, 1060, 20);
  assert(near(pv, BLUE), '預覽右上角有藍框 ' + pv);
  assert(!near(ex1.px[0], BLUE, 40) && !near(ex1.px[0], PINK, 40), '匯出的圖右上角沒有邊框 logo ' + ex1.px[0]);
  await page.click('[data-frame="ent"]');
  const ex2 = await exportInfo(page, PTS);
  await page.fill('#title', '');
  const ex3 = await exportInfo(page, PTS);
  assert.strictEqual(ex1.hash, ex2.hash, '換框不影響匯出的圖');
  assert.strictEqual(ex1.hash, ex3.hash, '標題不影響匯出的圖（匯出不含標題）');
  await page.click('[data-frame="news"]');
  ok('exportBlob：1080×1080 JPEG，沒有疊圖、沒有標題（右上角 ' + ex1.px[0] + '，預覽 ' + pv + '）');

  // 6 標題：一個輸入框；每行字數在框外右側、和該行對齊，超過變紅；第 4 行起一律紅
  assert.strictEqual(await page.locator('textarea#title').count(), 1);
  await page.fill('#title', '一二三四五六七八九十一二三四五');
  let g = await counterGeom(page);
  assert.deepStrictEqual(g.map(x => [x.text, x.over]), [['15/15', false]]);
  await page.fill('#title', '一二三四五六七八九十一二三四五六\nabcdefghijklmnopqrstuvwxyzabcd\n短\n第四行');   // 第 2 行 30 個半形 = 15
  g = await counterGeom(page);
  assert.deepStrictEqual(g.map(x => [x.text, x.over]), [['16/15', true], ['15/15', false], ['1/15', false], ['3/—', true]]);
  assert(g.every(x => x.dy <= 2 && x.outside), '計數和各行對齊、在框外 ' + JSON.stringify(g));
  assert.strictEqual(await page.getAttribute('#title', 'aria-invalid'), 'true');
  await page.fill('#title', '第一行\n\n第三行');   // 中間空行：計數留白，下一行仍算第 2 行
  g = await counterGeom(page);
  assert.deepStrictEqual(g.map(x => x.text), ['3/15', '', '3/15']);
  assert(g.every(x => x.dy <= 2));
  assert.deepStrictEqual(await page.evaluate(() => App.getLines()), ['第一行', '第三行']);
  ok('單一標題框：每行字數在框外對齊、超過 15 變紅、半形 0.5、第 4 行標紅');

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
  const rejArt = await page.evaluate(async () => [
    (await Ext.fetchArticle('https://example.com/news/1')).error,
    (await Ext.fetchArticle('http://news.tvbs.com.tw/life/3012345')).error,
    (await Ext.fetchArticle('https://evil-tvbs.com.tw/life/1')).error,
    (await Ext.fetchArticle('https://news.tvbs.com.tw.evil.com/life/1')).error,
    (await Ext.fetchArticle('https://digi-social-post.tvbs.ai/ip/newsnet/page_meta?url=x')).error,
    (await Ext.fetchArticle('javascript:alert(1)')).error
  ]);
  assert.deepStrictEqual(rejArt, Array(6).fill('host_not_allowed'));
  ok('fetchArticle 拒絕非 tvbs.com.tw／非 https（也不能拿來打後端）');

  // 8 截圖（桌面）
  await page.fill('#caption', '北北基桃明天照常上班上課！\n#颱風 #停班停課');
  await page.fill('#title', '颱風假最新！北北基桃\n明天照常上班上課');
  await page.click('.pg >> nth=0 >> button >> nth=0');
  await page.click('.pg >> nth=2 >> button >> nth=0');
  await page.click('.pg >> nth=2 >> .pg-mode');
  await page.click('#modeMenu [data-m="sched"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, 'prA-desktop.png') });
  assert(!(await page.locator('#sendBtn').isDisabled()));
  assert.strictEqual(await page.textContent('#sendBtn'), '全部送出（2 台）');
  ok('粉專切換、排程選單；全部送出顯示台數；已截圖 prA-desktop.png');
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

  // 10 純文字底圖：右欄（網址、標題、小編文）兩種模式共用，切換不清內容
  await page.click('#newBtn');
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  await page.fill('#title', TITLE3);
  await page.fill('#caption', '金鐘 61 頒獎典禮 #金鐘61');
  await page.evaluate(() => document.fonts.load('67px "WHZ-Heavy"'));
  await page.waitForTimeout(100);
  await page.evaluate(() => { document.querySelector('.m-body').scrollTop = 0; });
  await page.screenshot({ path: path.join(SHOTS, 'prB2-desktop-news.png') });
  await page.click('[data-frame="ent"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'prB2-desktop-ent.png') });
  await page.click('[data-frame="news"]');
  ok('已截圖 prB2-desktop-news.png、prB2-desktop-ent.png');
  const order = () => page.evaluate(() => [...document.querySelectorAll('.m-right input, .m-right textarea')].filter(e => e.offsetParent).map(e => e.id));
  const frameOrder = await order();
  await page.click('[data-mode="text"]');
  assert(await page.isVisible('#textCanvas') && !(await page.isVisible('#editorCanvas')));
  assert.deepStrictEqual(await order(), frameOrder, '右欄順序相同');
  assert.deepStrictEqual(frameOrder, ['url', 'title', 'caption', 'rdOn', 'slug']);
  assert.strictEqual(await page.inputValue('#title'), TITLE3);
  assert.strictEqual(await page.inputValue('#caption'), '金鐘 61 頒獎典禮 #金鐘61');
  assert.strictEqual(await page.evaluate(() => App.currentInput().cardText), TITLE3, '卡面文字＝標題（同樣分行）');
  await page.screenshot({ path: path.join(SHOTS, 'prB2-text.png') });
  await page.fill('#title', TITLE3 + '！');
  await page.click('[data-mode="frame"]');
  assert.strictEqual(await page.inputValue('#title'), TITLE3 + '！');
  assert.strictEqual(await page.inputValue('#caption'), '金鐘 61 頒獎典禮 #金鐘61');
  await page.click('[data-mode="text"]');
  ok('切換作圖框／純文字底圖：標題與小編文共用、順序相同；已截圖 prB2-text.png');
  assert.strictEqual(await page.locator('.sw').count(), 26);
  const px = () => page.evaluate(() => [...document.getElementById('textCanvas').getContext('2d').getImageData(3, 3, 1, 1).data].slice(0, 3).join(','));
  const before = await px();
  await page.locator('.sw >> nth=3').click();
  const after = await px();
  assert.notStrictEqual(before, after);
  assert.strictEqual(await page.getAttribute('.sw >> nth=3', 'aria-checked'), 'true');
  ok('純文字底圖：26 色票（含 QPT 預設色）、切換改變底色（' + before + ' → ' + after + '）');
  const swRow = () => page.evaluate(() => { const s = document.getElementById('swatches'), tops = new Set([...s.children].map(b => b.offsetTop));
    return { rows: tops.size, overflow: s.scrollWidth > s.clientWidth, left: s.scrollLeft, pageX: document.documentElement.scrollWidth > window.innerWidth }; });
  const r0 = await swRow();
  assert.strictEqual(r0.rows, 1, '色票只排一行'); assert(r0.overflow, '超出的色票要能左右滑'); assert(!r0.pageX, '整頁不出現水平捲軸');
  await page.locator('.sw >> nth=25').click();
  assert.strictEqual(await page.getAttribute('.sw >> nth=25', 'aria-checked'), 'true');
  assert((await swRow()).left > 0, '點最後一色後色票列已捲動');
  ok('色票單行、超出可左右滑，整頁不水平捲動');
  await page.keyboard.press('Escape');
  await page.click('#cfLeave');

  // 11 手機
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#newBtn');
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg')).catch(() => {});
  await page.click('[data-mode="frame"]');
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  await page.click('#fxBtn'); await page.click('.fx-sticker-tile >> nth=0');
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth, getComputedStyle(document.getElementById('url')).fontSize, document.getElementById('modal').getBoundingClientRect().width]);
  assert.strictEqual(sw[0], sw[1], '沒有橫向捲動');
  assert.strictEqual(sw[2], '16px');
  assert.strictEqual(sw[3], 390);
  await page.evaluate(() => { document.querySelector('.m-body').scrollTop = 0; });
  await page.screenshot({ path: path.join(SHOTS, 'prA-mobile.png') });
  await page.fill('#title', TITLE3);
  await page.waitForTimeout(100);
  const mg = await counterGeom(page);
  assert(mg.length === 3 && mg.every(x => x.dy <= 2 && x.outside && !x.over), '手機：計數對齊 ' + JSON.stringify(mg));
  assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: path.join(SHOTS, 'prB2-mobile.png'), fullPage: false });
  await page.evaluate(() => document.getElementById('title').scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: path.join(SHOTS, 'prB2-mobile-title.png') });
  ok('手機：全螢幕、無橫向捲動、輸入 16px、標題計數對齊；已截圖 prA-mobile.png、prB2-mobile*.png');

  assert.deepStrictEqual(errors, [], '頁面錯誤：' + errors.join('\n'));
  ok('沒有 page error / console error');
  await ctx.close();

  await prB(`http://localhost:${server.address().port}`);
  await prC(`http://localhost:${server.address().port}`);
  await fillBothModes(`http://localhost:${server.address().port}`);
  await captionFlow(`http://localhost:${server.address().port}`);
  await installGuide(`http://localhost:${server.address().port}`);
  server.close();
  console.log(`\n${passed} checks passed`);
})().catch(async e => { console.error('FAIL', e); server.close(); process.exit(1); });

// ===== PR B：模擬外掛（postMessage 協定）與圖床 Worker，不連外 =====
// 只在頁面內模擬 bridge.js 的回應；真正的外掛白名單另見 extension/background.js。
const IMG_BASE = 'https://snn-images.19jpz-3.workers.dev';
const MOCK_BRIDGE = () => {
  const calls = window.__calls = [];
  window.__mock = { guardLevel: 'red', failOnce: { weather: 1 } };
  const picture = (w, h, label) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#0d2b6b'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center'; g.fillText(label, w / 2, h / 2);
    return c.toDataURL('image/png');
  };
  // 類似 TVBS 的文章頁（og:title 帶站名、figcaption（圖／TVBS）、#hashtag 連結）；9990002 是沒有圖說與 hashtag 的版本
  const ARTICLE = bare => `<!doctype html><html><head><title>蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始｜TVBS新聞網</title>
<meta property="og:title" content="蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始｜TVBS新聞網">
<meta property="og:image" content="https://cc.tvbs.com.tw/img/a.jpg"></head><body><article><h1>標題</h1>
${bare ? '<p>內文</p>' : `<figure><img src="https://cc.tvbs.com.tw/img/a.jpg?w=800"><figcaption>蔡英文現身造勢場合。（圖／TVBS）</figcaption></figure>
<p>內文（記者王小明／台北報導）</p><div class="tags"><a href="/tag/沈伯洋">#沈伯洋</a><a href="/tag/蔡英文">#蔡英文</a><a href="/tag/認知作戰">#認知作戰</a><a href="/tag/賴清德">#賴清德</a></div>`}
</article></body></html>`;
  const json = (status, obj, type) => ({ ok: true, data: { status, contentType: type || 'application/json', text: typeof obj === 'string' ? obj : JSON.stringify(obj) } });
  function respond(op, p) {
    if (op === 'ping') return { ok: true, version: '0.6.0' };
    if (op === 'cookies') return { ok: true, data: [{ name: 'queen_session', sameSite: 'lax', httpOnly: true, expires: new Date(Date.now() + 5 * 864e5).toISOString() }] };
    if (op === 'fetchImage') return { ok: true, data: { image: picture(1200, 675, '文章主圖（模擬）') } };
    if (op === 'fetchArticle') {
      calls.push({ op, url: p.url });
      if (window.__mock.oldExt) return { ok: false, error: 'unknown_op' };   // 0.5.0 以前的外掛
      return { ok: true, data: { html: ARTICLE(/9990002/.test(p.url)), url: p.url } };
    }
    if (op !== 'call') return { ok: false, error: 'unknown_op' };
    calls.push({ path: p.path, method: p.method, body: p.body });
    if (/^\/page_meta\?.*9990001/.test(p.path)) return json(200, { title: '主圖帶入測試', image: 'https://news-images.tvbs.com.tw/a.jpg' });
    if (/^\/page_meta\?/.test(p.path)) return json(200, { title: '蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始', description: '摘要' });
    if (p.path === '/guard/check') return json(200, { level: window.__mock.guardLevel, check_id: 'chk-1', reasons: ['標題用語較聳動'] });
    if (/^\/render/.test(p.path) && window.__mock.renderFail) return json(500, { detail: '產圖失敗（模擬）' });
    if (p.path === '/render') return { ok: true, data: { status: 200, contentType: 'image/png', image: picture(540, 540, '後端套版（模擬）') } };
    if (p.path === '/render_text_card') return { ok: true, data: { status: 200, contentType: 'image/png', image: picture(540, 540, '純文字（模擬）') } };
    if (p.path === '/ai_caption') return json(200, p.body.mode === 'generate' ? { versions: [window.__mock.aiText || 'AI 產生的小編文 #颱風'], hashtags: window.__mock.aiTags || ['颱風', '沈伯洋'], usedArticle: false, note: '' } : { text: p.body.text.replace('上般', '上班') });
    if (p.path === '/publish' || p.path === '/schedule') {
      const code = p.body.page;
      if (window.__mock.failOnce[code] > 0) {
        window.__mock.failOnce[code]--;
        return json(502, '<!doctype html><html><body><h1>502 Bad Gateway</h1>' + 'x'.repeat(3000) + '</body></html>', 'text/html');
      }
      return json(200, p.path === '/publish' ? { post_url: 'https://www.facebook.com/123_' + code, post_id: '123_' + code } : { message: '已排程' });
    }
    return json(404, { detail: 'not found' });
  }
  window.addEventListener('message', e => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'snn-web') return;
    const res = respond(d.op, d.payload || {});
    const slow = d.op === 'call' && /^\/render/.test((d.payload || {}).path || '') && window.__mock.renderDelay;
    setTimeout(() => window.postMessage(Object.assign({ source: 'snn-ext', nonce: d.nonce }, res), location.origin), slow || 40);
  });
};

// 模擬圖床 Worker（/login、/upload），回傳計數
async function mockWorker(ctx, origin) {
  const worker = { logins: 0, uploads: 0, auths: [], rundown: [] };
  await ctx.route(IMG_BASE + '/**', async route => {
    const req = route.request(), u = new URL(req.url());
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Vary': 'Origin' };
    const send = (status, obj) => route.fulfill({ status, headers: Object.assign({ 'Content-Type': 'application/json;charset=utf-8' }, cors), body: JSON.stringify(obj) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/login') {
      worker.logins++;
      const b = JSON.parse(req.postData() || '{}');
      if (b.password !== 'right-password') return send(200, { ok: false, code: 'unauthorized', error: '密碼不正確或登入已過期。' });
      return send(200, { ok: true, data: { session: 'sess-1', exp: Math.floor(Date.now() / 1000) + 43200, ttl: 43200 } });
    }
    if (u.pathname === '/upload') {
      worker.auths.push(req.headers().authorization);
      if (req.headers().authorization !== 'Bearer sess-1') return send(401, { ok: false, code: 'unauthorized', error: '密碼不正確或登入已過期。' });
      worker.uploads++;
      return send(200, { ok: true, data: { url: `${IMG_BASE}/i/${String(worker.uploads).repeat(32)}.jpg`, key: 'k', expiresAt: new Date(Date.now() + 3 * 864e5).toISOString() } });
    }
    if (u.pathname === '/rundown') {
      if (req.headers().authorization !== 'Bearer sess-1') return send(401, { ok: false, code: 'unauthorized', error: '密碼不正確或登入已過期。' });
      const b = JSON.parse(req.postData() || '{}'); worker.rundown.push(b);
      return send(200, { ok: true, data: b.action === 'ping' ? { title: 'FB RUNDOWN(2026)', sheets: ['2026/10', '2026/09'] }
        : { results: b.entries.map((e, i) => (i === 0 ? { ok: true, page: e.page, status: 'write', cell: '2026/10!AB107', time: e.time } : { ok: false, page: e.page, error: '08:00 時段在這天已經排滿' })) } });
    }
    return send(404, { ok: false, code: 'not_found' });
  });
  return worker;
}

async function prB(origin) {
  console.log('\n  PR B（模擬外掛與圖床）');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(MOCK_BRIDGE);
  const worker = await mockWorker(ctx, origin);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /登入剩/.test(document.getElementById('extText').textContent));
  assert.strictEqual(await page.textContent('#imgText'), '圖床未登入');
  ok('模擬外掛連線、圖床未登入');

  const calls = () => page.evaluate(() => window.__calls);
  const sends = async () => (await calls()).filter(c => c.path === '/publish' || c.path === '/schedule');

  // 填內容
  await page.click('#newBtn');
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  await page.fill('#url', 'https://news.tvbs.com.tw/life/3012345');
  // 快速帶入：標題照 QPT breakTitle 分行，一行一句填進標題框
  await page.click('#fillBtn');
  await page.waitForFunction(() => /已帶入標題/.test(document.getElementById('urlHint').textContent));
  const broke = await page.evaluate(() => Rules.breakTitle('蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始'));
  assert.strictEqual(broke.length, 3);
  assert.strictEqual(await page.inputValue('#title'), broke.join('\n'));
  assert.strictEqual(await page.locator('#titleCnts span').count(), 3);
  assert.deepStrictEqual(await page.evaluate(() => App.getLines()), broke);
  ok('快速帶入：標題以 breakTitle 分行填入單一標題框（' + broke.join('／') + '）');
  await page.fill('#title', '颱風假最新！北北基桃\n明天照常上班上課');

  // AI 小編文
  assert.strictEqual(await page.inputValue('#caption'), '【颱風假最新！北北基桃 明天照常上班上課】\n（圖／TVBS）\n#沈伯洋 #蔡英文 #賴清德', '帶入的小編文跟著改過的標題');
  await page.click('#aiGenBtn');
  await page.waitForFunction(() => document.getElementById('caption').value === 'AI 產生的小編文 #颱風\n【颱風假最新！北北基桃 明天照常上班上課】\n（圖／TVBS）\n#沈伯洋 #蔡英文 #賴清德');
  await page.fill('#caption', '北北基桃明天照常上般上課！\n#颱風 #停班停課');
  await page.click('#aiFixBtn');
  await page.waitForFunction(() => /上班上課/.test(document.getElementById('caption').value));
  const ai = (await calls()).filter(c => c.path === '/ai_caption').map(c => c.body);
  assert.deepStrictEqual(ai[0], { ip: 'newsnet', mode: 'generate', title: '颱風假最新！北北基桃明天照常上班上課', summary: '摘要' });
  assert.deepStrictEqual(ai[1].titles, ['颱風假最新！北北基桃', '明天照常上班上課']);
  assert.strictEqual(ai[1].mode, 'proofread');
  ok('AI 產生＋校錯字填入小編文');

  // 粉專：新聞立即、少康排程、氣象立即
  const pg = i => page.locator('.pg').nth(i);
  await pg(0).locator('button').first().click();
  await pg(2).locator('button').first().click();
  await pg(5).locator('button').first().click();
  assert.strictEqual(await page.textContent('#sendBtn'), '全部送出（3 台）');
  await pg(2).locator('.pg-mode').click();
  await page.click('#modeMenu [data-m="sched"]');
  assert(await page.isVisible('#timePop'));
  const today = await page.evaluate(() => Sched.fmtDateInput(Sched.defaultAt(new Date())));   // 今天（23:30 以後預填會跨到明天）
  assert.strictEqual(await page.inputValue('#tpDate'), today, '日期預設今天');
  await page.fill('#tpDate', await page.evaluate(() => Sched.fmtDateInput(new Date())));
  // 不合法：今天 00:00 → 標紅
  await page.fill('#tpTime', '');
  await page.type('#tpTime', '0000');
  assert.match(await page.textContent('#tpHint'), /至少要比現在晚 20 分鐘/);
  assert.strictEqual(await page.getAttribute('#tpTime', 'aria-invalid'), 'true');
  await page.keyboard.press('Enter');
  assert(await page.isVisible('#timePop'), '不合法按 Enter 不關閉');
  // 改明天，打 2130 → 21:30
  const tomorrow = await page.evaluate(() => Sched.fmtDateInput(new Date(Date.now() + 864e5)));
  await page.fill('#tpDate', tomorrow);
  await page.fill('#tpTime', '');
  await page.type('#tpTime', '2130');
  assert.strictEqual(await page.inputValue('#tpTime'), '21:30');
  assert.strictEqual(await page.getAttribute('#tpTime', 'aria-invalid'), 'false');
  await page.keyboard.press('ArrowUp');
  assert.strictEqual(await page.inputValue('#tpTime'), '21:40');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  assert.strictEqual(await page.inputValue('#tpTime'), '21:20');
  await page.keyboard.press('ArrowUp');
  assert.strictEqual(await page.inputValue('#tpTime'), '21:30');
  assert.match(await pg(2).locator('.pg-mode').textContent(), /排程 \d+\/\d+ 21:30/);
  await page.screenshot({ path: path.join(SHOTS, 'prB-timepicker.png') });
  await page.keyboard.press('Enter');
  assert(!(await page.isVisible('#timePop')));
  ok('排程：日期預設今天、2130→21:30、↑↓ ±10 分、太早標紅；已截圖 prB-timepicker.png');

  // 後端預覽：先跳圖床登入；密碼錯 → 提示；對 → 上傳一次並顯示後端圖
  await page.click('#previewBtn');
  await page.waitForSelector('#imgLogin:not([hidden])');
  await page.fill('#ilPass', 'wrong');
  await page.click('#ilGo');
  await page.waitForFunction(() => /密碼不正確/.test(document.getElementById('ilHint').textContent));
  await page.fill('#ilPass', 'right-password');
  await page.click('#ilGo');
  await page.waitForSelector('#bePrevImg:not([hidden])');
  assert.strictEqual(worker.uploads, 1);
  assert.strictEqual(await page.textContent('#imgText'), '圖床已登入');
  const stored = await page.evaluate(() => localStorage.getItem('snn.imghost.v1'));
  assert(!/right-password/.test(stored), '不存密碼');
  const render = (await calls()).find(c => c.path === '/render').body;
  assert.strictEqual(render.image_url, `${IMG_BASE}/i/${'1'.repeat(32)}.jpg`);
  assert.strictEqual(render.crop, null);
  assert.strictEqual(render.layout, 'newsnet_news');
  assert.deepStrictEqual(Object.keys(render), ['image_url', 'lines', 'layout', 'crop']);
  assert.strictEqual(await page.textContent('#bePrevCap'), '後端產圖・新聞（藍框）');
  ok('後端預覽：跳圖床登入、錯密碼提示、上傳後 /render 帶圖床網址與 crop:null');

  // 第 1 次按：自動判讀（紅燈）→ 泡泡；未勾「我知道風險」不能送
  await page.click('#sendBtn');
  await page.waitForSelector('#bubble:not([hidden])');
  assert.strictEqual((await calls()).filter(c => c.path === '/guard/check').length, 1);
  const gb = (await calls()).find(c => c.path === '/guard/check').body;
  assert.deepStrictEqual(gb, { ip: 'newsnet', title_lines: ['颱風假最新！北北基桃', '明天照常上班上課'], caption: await page.inputValue('#caption'), text: '' });
  assert.strictEqual(await page.textContent('#sendBtn'), '確認送出');
  assert.strictEqual(await page.locator('#bubble tr').count(), 3);
  assert.match(await page.textContent('#bubble'), /確定送出 3 台？/);
  assert.match(await page.textContent('#bubble'), /少康排程 \d+\/\d+ 21:30/);
  assert.match(await page.textContent('#bubble'), /守則紅燈：標題用語較聳動/);
  assert(await page.locator('#sendBtn').isDisabled(), '紅燈未勾不能送');
  // 改內容 → 回第 1 步
  await page.type('#caption', '！');
  assert(!(await page.isVisible('#bubble')));
  assert.strictEqual(await page.textContent('#sendBtn'), '全部送出（3 台）');
  // 點外面 → 回第 1 步
  await page.click('#sendBtn');
  await page.waitForSelector('#bubble:not([hidden])');
  await page.mouse.click(700, 120);
  assert(!(await page.isVisible('#bubble')));
  ok('第 1 次按自動判讀、泡泡列 3 台；改內容或點外面回第 1 步');

  await page.click('#sendBtn');
  await page.waitForSelector('#ackChk');
  await page.check('#ackChk');
  assert(!(await page.locator('#sendBtn').isDisabled()));
  await page.screenshot({ path: path.join(SHOTS, 'prB-bubble-red.png') });
  ok('紅燈勾「我知道風險」後才能確認送出；已截圖 prB-bubble-red.png');

  // 第 2 次按：逐台送；氣象失敗（HTML 502）
  await page.click('#sendBtn');
  await page.waitForFunction(() => App.flow.state === 'done');
  const s1 = await sends();
  assert.deepStrictEqual(s1.map(c => [c.path, c.body.page]), [['/publish', 'news'], ['/schedule', 'shaokang'], ['/publish', 'weather']]);
  assert.strictEqual(worker.uploads, 1, '預覽與送出共用同一次上傳');
  const [news, shao, wx] = s1.map(c => c.body);
  assert.strictEqual(news.image_url, `${IMG_BASE}/i/${'1'.repeat(32)}.jpg`);
  assert.strictEqual(news.crop, null);
  assert.deepStrictEqual(news.guard, { check_id: 'chk-1', level: 'red', ack: true });
  assert.strictEqual(news.schedule, '');
  assert.strictEqual(news.link, 'https://news.tvbs.com.tw/life/3012345?utm_source=facebook&utm_medium=fbarticlepic');
  assert.strictEqual(shao.schedule, tomorrow + 'T21:30');
  assert.strictEqual(shao.link, 'https://news.tvbs.com.tw/life/3012345?utm_source=facebook&utm_medium=2100roompic');
  assert.strictEqual(wx.link, 'https://news.tvbs.com.tw/life/3012345?utm_source=Facebook&utm_medium=18weather');
  assert.deepStrictEqual([news.rd_write, shao.rd_write, wx.rd_write], [true, true, true]);
  assert.strictEqual(news.article_id, '3012345'); assert.strictEqual(news.short_title, '颱風假最新');
  assert.deepStrictEqual(news.title_lines, ['颱風假最新！北北基桃', '明天照常上班上課']);
  assert.deepStrictEqual(s1.map(c => c.body.template), ['newsnet_news', 'newsnet_news', 'newsnet_news'], '藍框：每台都送 newsnet_news');
  const msg = await page.textContent('#sendMsg');
  assert.match(msg, /2 台成功・1 台失敗/);
  assert.match(msg, /502/);
  assert(!/<|Bad Gateway/.test(msg), 'HTML 錯誤不進畫面');
  assert.deepStrictEqual(await page.$$eval('.pg', els => els.map(e => e.className.replace('pg', '').trim())), ['done', '', 'done', '', '', 'fail']);
  assert.strictEqual(await page.locator('.pg .retry:visible').count(), 1);
  assert.match(await pg(0).locator('.pg-mode').textContent(), /已發布 ↗/);
  assert.match(await pg(2).locator('.pg-mode').textContent(), /✓ 排程/);
  assert(await page.isVisible('#clearBtn'));
  await page.screenshot({ path: path.join(SHOTS, 'prB-result-fail.png') });
  ok('逐台送出 payload 正確；氣象 502 HTML 顯示精簡錯誤與重送鈕；已截圖 prB-result-fail.png');

  // 只重送失敗的氣象
  await pg(5).locator('.retry').click();
  await page.waitForFunction(() => App.state.pages.weather.status === 'ok');
  const s2 = (await sends()).slice(s1.length);
  assert.deepStrictEqual(s2.map(c => [c.path, c.body.page]), [['/publish', 'weather']]);
  assert.strictEqual(worker.uploads, 1);
  assert.strictEqual((await calls()).filter(c => c.path === '/guard/check').length, 3, '內容沒改：重送不重判');
  assert.match(await page.textContent('#sendMsg'), /3 台成功/);
  assert.strictEqual(await page.locator('.pg .retry:visible').count(), 0);
  const recs = await page.evaluate(() => JSON.parse(localStorage.getItem('snn.records.v1')));
  assert.strictEqual(recs.length, 1);
  assert.deepStrictEqual(recs[0].pages.map(p => [p.code, p.kind, p.status]), [['news', 'now', 'ok'], ['shaokang', 'sched', 'ok'], ['weather', 'now', 'ok']]);
  assert.strictEqual(recs[0].pages[0].link, 'https://www.facebook.com/123_news');
  assert.strictEqual(recs[0].pages[1].schedule, tomorrow + 'T21:30');
  ok('只重送失敗的台；本機紀錄 1 筆、3 台都成功');

  // 全部成功：清空頁面不需確認
  await page.click('#clearBtn');
  assert.strictEqual(await page.inputValue('#url'), '');
  assert.strictEqual(await page.locator('.pg.done').count(), 0);
  ok('全部成功後「清空頁面」直接清空');

  // 娛樂（粉框）：預覽換粉框，送出的每一台都是 newsnet_ent
  await page.evaluate(() => { window.__mock.guardLevel = 'green'; });
  const upPick = worker.uploads;
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  await page.fill('#url', 'https://news.tvbs.com.tw/entertainment/3012399');
  await page.fill('#title', '金鐘61／《飢餓》10週年大禮！\n峮峮驚喜合體遭催回歸\n蔡黃汝羞謝「好友」閃瞎全場');
  await page.click('[data-frame="ent"]');
  const px = await page.evaluate(() => [...document.getElementById('editorCanvas').getContext('2d').getImageData(1060, 20, 1, 1).data].slice(0, 3));
  assert(px[0] > 220 && px[1] > 150 && px[1] < 215 && px[2] > 210, '預覽右上角是粉框 ' + px);
  // Rundown：開關直接存；⚙ 只有開關與測試連線（網址、金鑰在 Worker Secrets）
  const gas = worker.rundown;
  assert.strictEqual(await page.isChecked('#rdOn'), false);
  await page.click('#rdOn');
  assert.strictEqual(await page.isChecked('#rdOn'), true);
  assert.strictEqual(await page.evaluate(() => Rundown.enabled()), true);
  await page.click('#rdSetBtn');
  await page.waitForSelector('#rdDlg:not([hidden])');
  assert.strictEqual(await page.isChecked('#rdDlgOn'), true);
  assert.strictEqual(await page.$('#rdUrl'), null, '不再有網址欄');
  await page.click('#rdTest');
  await page.waitForFunction(() => /連線成功/.test(document.getElementById('rdHint').textContent));
  assert.deepStrictEqual(gas.shift(), { action: 'ping' }, '網頁不帶金鑰');
  await page.click('#rdDlg button[type=submit]');
  assert(await page.isHidden('#rdDlg'));
  assert.strictEqual(await page.isChecked('#rdOn'), true);
  assert.match(await page.getAttribute('#slug', 'placeholder'), /金鐘61/);
  ok('Rundown：開關直接存、⚙ 測試連線經 Worker（不帶金鑰）；SLUG 預設顯示標題前 4 字');

  for (const i of [0, 1, 3]) await pg(i).locator('button').first().click();
  for (let i = 0; i < 40 && worker.uploads === upPick; i++) await page.waitForTimeout(100);
  assert.strictEqual(worker.uploads, upPick + 1, '選好照片、還沒按送出就已在背景上傳');
  const sentBefore = (await sends()).length, upBefore = worker.uploads;
  await page.click('#sendBtn');
  await page.waitForSelector('#bubble:not([hidden])');
  await page.click('#sendBtn');
  await page.waitForFunction(() => App.flow.state === 'done');
  const s3 = (await sends()).slice(sentBefore);
  assert.deepStrictEqual(s3.map(c => [c.body.page, c.body.template]), [['news', 'newsnet_ent'], ['ent', 'newsnet_ent'], ['jkk', 'newsnet_ent']]);
  assert.deepStrictEqual(s3[0].body.title_lines, ['金鐘61／《飢餓》10週年大禮！', '峮峮驚喜合體遭催回歸', '蔡黃汝羞謝「好友」閃瞎全場']);
  assert.strictEqual(worker.uploads, upBefore, '送出直接用背景上傳的網址，不重傳');
  ok('背景預先上傳；粉框：預覽疊粉框，3 台都送 template=newsnet_ent');
  const rdReq = gas.shift();
  assert.strictEqual(rdReq.action, 'add'); assert.strictEqual('token' in rdReq, false); assert.strictEqual('mode' in rdReq, false);
  assert.deepStrictEqual(rdReq.entries.map(e => [e.page, e.text]), [['news', '3012399/圖文/金鐘61'], ['ent', '3012399/圖文/金鐘61']], '勾選的粉專各寫一筆，擠看看略過');
  assert.match(rdReq.entries[0].date, /^\d{4}-\d{2}-\d{2}$/); assert.match(rdReq.entries[0].time, /^\d{2}:\d{2}$/);
  const rdMsg = await page.textContent('#sendMsg');
  assert.match(rdMsg, /Rundown：主粉（新聞粉） \d{2}:\d{2} → AB107；娛樂粉：08:00 時段在這天已經排滿/);
  const rdRec = await page.evaluate(() => Records.list()[0].pages.find(p => p.code === 'news').rundown);
  assert.deepStrictEqual([rdRec.ok, rdRec.cell], [true, '2026/10!AB107']);
  ok('Rundown：送出成功後寫入（' + rdMsg.split('｜')[1] + '）');
  await page.fill('#slug', '自訂 SLUG');
  await page.click('#clearBtn');
  assert.strictEqual(await page.inputValue('#slug'), '');
  await page.click('#rdOn');
  assert.strictEqual(await page.evaluate(() => Rundown.enabled()), false);
  assert(await page.isDisabled('#slug'), '關閉時 SLUG 停用');
  await page.click('#rdOn'); assert(await page.isEnabled('#slug')); await page.click('#rdOn');
  await page.click('[data-frame="news"]');
  ok('Rundown 開關可關閉（SLUG 跟著停用）；清空頁面一併清 SLUG');

  // 手機：純文字底圖 → 預覽 /render_text_card → 泡泡
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-mode="text"]');
  const upText = worker.uploads;
  await page.fill('#title', '【快訊】北市宣布明天停班停課');
  await page.click('#previewTextBtn');
  await page.waitForSelector('#bePrevImg:not([hidden])');
  const tc = (await calls()).filter(c => c.path === '/render_text_card').pop().body;
  assert.strictEqual(tc.text, '【快訊】北市宣布明天停班停課');
  assert.strictEqual(tc.width, 1080);
  await pg(0).locator('button').first().click();
  await page.evaluate(() => { window.__mock.guardLevel = 'yellow'; });
  await page.click('#sendBtn');
  await page.waitForSelector('#bubble:not([hidden])');
  assert(!(await page.locator('#sendBtn').isDisabled()), '黃燈可送');
  const geo = await page.evaluate(() => {
    const b = document.getElementById('bubble').getBoundingClientRect();
    return { sw: document.documentElement.scrollWidth, iw: innerWidth, left: b.left, right: b.right };
  });
  assert.strictEqual(geo.sw, geo.iw, '沒有橫向捲動');
  assert(geo.left >= 0 && geo.right <= geo.iw, '泡泡在畫面內 ' + JSON.stringify(geo));
  await page.screenshot({ path: path.join(SHOTS, 'prB-mobile.png') });
  await page.click('#sendBtn');
  await page.waitForFunction(() => App.flow.state === 'done');
  const last = (await sends()).pop().body;
  assert.strictEqual(last.mode, 'text_card'); assert.strictEqual(last.template, ''); assert.strictEqual(last.image_url, '');
  assert.deepStrictEqual(last.guard, { check_id: 'chk-1', level: 'yellow', ack: false });
  assert.strictEqual(worker.uploads, upText, '純文字不上傳圖床');
  ok('手機：純文字預覽、黃燈泡泡在畫面內、送出 text_card；已截圖 prB-mobile.png');

  assert.deepStrictEqual(errors, [], '頁面錯誤：' + errors.join('\n'));
  ok('PR B 沒有 page error / console error');
  await browser.close();
}

// ===== PR C：送出紀錄列表、從列表重送、複製到新增發文、刪除 =====
async function prC(origin) {
  console.log('\n  PR C（送出紀錄）');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(MOCK_BRIDGE);
  const worker = await mockWorker(ctx, origin);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(origin + '/index.html');
  await page.evaluate(() => localStorage.setItem('snn.imghost.v1', JSON.stringify({ session: 'sess-1', exp: Math.floor(Date.now() / 1000) + 43200 })));
  await page.reload();
  await page.waitForFunction(() => /登入剩/.test(document.getElementById('extText').textContent));
  assert(await page.isVisible('#recEmpty'));
  assert.strictEqual(await page.locator('#recEmpty a').count(), 0, '空狀態只引導新增發文');
  assert(await page.isVisible('.page-foot a[href="verify.html"]'), '工具連結移到頁尾');
  assert(!(await page.isVisible('#recTabs')));
  ok('沒有紀錄：顯示空狀態、不顯示分頁籤');

  const calls = () => page.evaluate(() => window.__calls);
  const sends = async () => (await calls()).filter(c => c.path === '/publish' || c.path === '/schedule');
  const tabs = () => page.$$eval('#recTabs button', bs => bs.map(b => b.textContent.replace(/\s+/g, ' ').trim()));
  const chips = row => row.locator('.st2 > *').allTextContents();
  const pg = i => page.locator('.pg').nth(i);

  // 送 3 台（新聞立即、少康排程明天 21:30、氣象立即且失敗），紅燈勾「我知道風險」
  await page.click('#newBtn');
  await page.setInputFiles('#fileInput', path.join(WEB, 'test-image.jpg'));
  await page.waitForFunction(() => Editor.hasImage());
  await page.fill('#url', 'https://news.tvbs.com.tw/life/3012345');
  await page.fill('#title', '颱風假最新！北北基桃\n明天照常上班上課');
  await page.fill('#caption', '北北基桃明天照常上班上課！\n#颱風');
  for (const i of [0, 2, 5]) await pg(i).locator('button').first().click();
  await pg(2).locator('.pg-mode').click();
  await page.click('#modeMenu [data-m="sched"]');
  const tomorrow = await page.evaluate(() => Sched.fmtDateInput(new Date(Date.now() + 864e5)));
  await page.fill('#tpDate', tomorrow);
  await page.fill('#tpTime', ''); await page.type('#tpTime', '2130'); await page.keyboard.press('Enter');
  await page.click('#sendBtn');
  await page.waitForSelector('#ackChk');
  await page.check('#ackChk');
  await page.click('#sendBtn');
  await page.waitForFunction(() => App.flow.state === 'done');
  const first = await sends();
  assert.deepStrictEqual(first.map(c => c.body.page), ['news', 'shaokang', 'weather']);
  await page.keyboard.press('Escape');
  await page.click('#cfLeave');
  assert(!(await page.isVisible('#modal')));

  const row0 = page.locator('.rec').first();
  const md = await page.evaluate(t => Records.fmtMD(Sched.combine(t, '21:30')), tomorrow);
  const c0 = await chips(row0);
  assert.match(c0[0], /^新聞・已發布 \d\d\/\d\d \d\d:\d\d ↗$/, '已發布顯示發布時間');
  assert.deepStrictEqual(c0.slice(1), [`少康・排程 ${md}`, '氣象・失敗 ↻ 重送']);
  assert.strictEqual(await row0.locator('a.chip').getAttribute('href'), 'https://www.facebook.com/123_news');
  assert.strictEqual(await row0.locator('a.chip').getAttribute('target'), '_blank');
  assert.match(await row0.locator('.rec-t').textContent(), /^颱風假最新！北北基桃 明天照常上班上課$/);
  assert.strictEqual(await row0.locator('.rec-t .muted').textContent(), '明天照常上班上課', '第一行之外淡色');
  assert.match(await row0.locator('.rec-m').textContent(), /^今天 \d\d:\d\d 送出・作圖框・藍框/);
  const thumbSrc = await row0.locator('.rec-th img').getAttribute('src');
  assert(/^data:image\/jpeg;base64,/.test(thumbSrc) && thumbSrc.length <= 28000, '縮圖 JPEG ≤ 約 20 KB：' + thumbSrc.length);
  assert.deepStrictEqual(await tabs(), ['全部 1', '已排程 1', '已發布 1', '失敗 1']);
  const stored = await page.evaluate(() => Records.list()[0]);
  assert.deepStrictEqual(stored.pages.map(p => [p.code, !!p.body]), [['news', false], ['shaokang', false], ['weather', true]], '只有失敗的台留著 body');
  assert.deepStrictEqual(stored.pages[2].body, first[2].body, '存的 body 和送出的完全一樣');
  assert.deepStrictEqual(stored.guard, { checkId: 'chk-1', level: 'red', reasons: ['標題用語較聳動'] });
  assert.strictEqual(stored.frame, 'news');
  ok('送 3 台、1 台失敗 → 列表顯示縮圖、標題、模式、版型與各台狀態；分頁籤數量正確');

  // 從列表重送氣象：沿用紀錄裡的紅燈，要再勾「我知道風險」
  const guards = (await calls()).filter(c => c.path === '/guard/check').length;
  await row0.locator('[data-rs]').click();
  await page.waitForSelector('#rsDlg:not([hidden])');
  assert.match(await page.textContent('#rsGuard'), /沿用上次判讀・守則紅燈：標題用語較聳動/);
  assert(await page.isVisible('#rsAckRow'));
  assert(!(await page.isVisible('#rsTime')), '立即發布的台不用選時間');
  assert(await page.locator('#rsGo').isDisabled(), '紅燈沒勾不能重送');
  await page.check('#rsAck');
  assert(!(await page.locator('#rsGo').isDisabled()));
  await page.click('#rsGo');
  await page.waitForFunction(() => /氣象・已發布 \d\d\/\d\d \d\d:\d\d ↗/.test(document.querySelector('.rec').textContent));
  const re = (await sends()).slice(first.length);
  assert.strictEqual(re.length, 1);
  assert.strictEqual(re[0].path, '/publish');
  assert.deepStrictEqual(re[0].body, first[2].body, '重送的 body 和原本的完全一樣（含紅燈 ack:true、圖床網址）');
  assert.strictEqual((await calls()).filter(c => c.path === '/guard/check').length, guards, '沿用燈號，不重判');
  assert.strictEqual(worker.uploads, 1, '不重傳圖');
  assert.deepStrictEqual(await tabs(), ['全部 1', '已排程 1', '已發布 1', '失敗']);
  assert.strictEqual(await page.evaluate(() => Records.list().length), 1, '原地更新同一筆');
  ok('從列表重送失敗的台：紅燈要再勾、送出內容與原本相同、狀態更新為已發布');

  // 塞入更多紀錄：排程時間已過（推測已發布）、排程失敗且時間已過、22 筆 PR B 舊格式
  await page.evaluate(() => {
    const now = Date.now(), all = JSON.parse(localStorage.getItem(Records.KEY));
    const at = new Date(now + 5 * 60000);   // 原本排程只剩 5 分鐘：重送要選新時間
    const input = { mode: 'single', frame: 'ent', imageUrl: 'https://snn-images.19jpz-3.workers.dev/i/' + '9'.repeat(32) + '.jpg', lines: ['金鐘61／《飢餓》10週年大禮！', '峮峮驚喜合體遭催回歸'],
      caption: '金鐘 61 #金鐘61', url: 'https://news.tvbs.com.tw/entertainment/3012399', guard: { checkId: 'g-ent', level: 'green' } };
    const rq = Payload.buildRequests(input, [{ code: 'ent', at }])[0];
    all.push({ id: 'seed-fail', at: new Date(now - 30 * 60000).toISOString(), imgExp: new Date(now + 3 * 864e5 - 30 * 60000).toISOString(), mode: 'single', frame: 'ent',
      title: input.lines.join(' '), lines: input.lines, caption: input.caption, url: input.url, guard: { checkId: 'g-ent', level: 'green', reasons: [] },
      pages: [{ code: 'ent', label: '娛樂', kind: 'sched', schedule: rq.body.schedule, status: 'fail', error: 'HTTP 500：排程時間太近', path: rq.path, body: rq.body }] });
    all.push({ id: 'seed-due', at: new Date(now - 3 * 3600e3).toISOString(), mode: 'text_card', title: '【快訊】北市宣布\n明天停班停課', lines: ['【快訊】北市宣布', '明天停班停課'],
      caption: '停班停課 #颱風', url: '', cardStyle: NEWSNET_CONFIG.textCardStyles[2].key,
      pages: [{ code: 'news', label: '新聞', kind: 'sched', schedule: Sched.toScheduleString(new Date(now - 3600e3)), status: 'ok' }] });
    for (let i = 0; i < 22; i++) all.push({ id: 'old' + i, at: new Date(now - (2 + i) * 864e5).toISOString(), mode: 'single', title: `舊紀錄 ${i + 1}`, articleId: '', url: '',
      pages: [{ code: 'news', label: '新聞', kind: 'now', schedule: '', status: 'ok', link: 'https://www.facebook.com/old' + i, error: '' }] });
    localStorage.setItem(Records.KEY, JSON.stringify(all));
    RecList.render();
  });
  assert.deepStrictEqual(await tabs(), ['全部 25', '已排程 1', '已發布 24', '失敗 1']);
  assert.strictEqual(await page.locator('.rec').count(), 20, '每頁 20 筆');
  assert.strictEqual(await page.textContent('#recCnt'), '共 25 則');
  const dueRow = page.locator('.rec', { hasText: '【快訊】北市宣布' });
  const dc = await chips(dueRow);
  assert.strictEqual(dc.length, 1); assert.match(dc[0], /^新聞・應已發布 \d\d\/\d\d \d\d:\d\d（推測）$/);
  assert.match(await dueRow.locator('.chip.due').getAttribute('title'), /無法確認/);
  assert.match(await dueRow.locator('.rec-m').textContent(), /純文字底圖/);
  assert.deepStrictEqual(await page.locator('.rec').nth(0).locator('.rec-t b').textContent(), '颱風假最新！北北基桃', '新的在前');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, 'prC-list.png') });
  await page.click('#recPager [aria-label="第 2 頁"]');
  assert.strictEqual(await page.locator('.rec').count(), 5);
  assert.strictEqual(await page.getAttribute('#recPager [aria-current=page]', 'data-page'), '2');
  assert(await page.locator('#recPager [aria-label="下一頁"]').isDisabled());
  await page.click('#recPager [aria-label="上一頁"]');
  assert.strictEqual(await page.locator('.rec').count(), 20);
  ok('多筆紀錄：新的在前、每頁 20 筆、頁碼列；排程時間已過顯示「應已發布（推測）」；已截圖 prC-list.png');

  // 失敗分頁籤
  await page.click('#recTabs [data-tab="fail"]');
  assert.strictEqual(await page.locator('.rec').count(), 1);
  assert(!(await page.isVisible('#recPager')));
  const failRow = page.locator('.rec').first();
  assert.deepStrictEqual(await chips(failRow), ['娛樂・失敗 ↻ 重送']);
  assert.match(await failRow.locator('.chip.e').getAttribute('title'), /排程時間太近/);
  await page.waitForTimeout(500);   // 分頁籤的滑塊動畫
  await page.screenshot({ path: path.join(SHOTS, 'prC-failed.png') });
  ok('失敗分頁籤只列有失敗的紀錄；已截圖 prC-failed.png');

  // 排程時間已過的失敗台：要先選新時間才能重送
  const before = (await sends()).length;
  await failRow.locator('[data-rs]').click();
  await page.waitForSelector('#rsDlg:not([hidden])');
  assert(await page.isVisible('#rsTime'));
  assert.match(await page.textContent('#rsTimeNote'), /已過或離現在不到 20 分鐘，請選新的時間/);
  assert.strictEqual(await page.inputValue('#rsClock'), '', '不預填，一定要自己選');
  assert(await page.locator('#rsGo').isDisabled());
  assert(!(await page.isVisible('#rsAckRow')), '綠燈不用勾');
  assert.match(await page.textContent('#rsGuard'), /沿用上次判讀・守則綠燈/);
  await page.fill('#rsDate', await page.evaluate(() => Sched.fmtDateInput(new Date())));
  await page.type('#rsClock', '0000');
  assert.match(await page.textContent('#rsHint'), /至少要比現在晚 20 分鐘/);
  assert(await page.locator('#rsGo').isDisabled());
  await page.fill('#rsDate', tomorrow);
  await page.fill('#rsClock', ''); await page.type('#rsClock', '2130');
  assert.strictEqual(await page.inputValue('#rsClock'), '21:30');
  await page.keyboard.press('ArrowUp');
  assert.strictEqual(await page.inputValue('#rsClock'), '21:40');
  await page.keyboard.press('ArrowDown');
  assert(!(await page.locator('#rsGo').isDisabled()));
  await page.screenshot({ path: path.join(SHOTS, 'prC-resend-time.png') });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-rs="seed-fail|ent"]') && !document.querySelector('.chip.busy'));
  const rs2 = (await sends()).slice(before);
  assert.deepStrictEqual(rs2.map(c => [c.path, c.body.page, c.body.schedule, c.body.template]), [['/schedule', 'ent', tomorrow + 'T21:30', 'newsnet_ent']]);
  assert.deepStrictEqual(rs2[0].body.guard, { check_id: 'g-ent', level: 'green', ack: false });
  assert.deepStrictEqual(await tabs(), ['全部 25', '已排程 2', '已發布 24', '失敗']);
  assert(await page.isVisible('#recNone'), '失敗分頁籤已沒有紀錄');
  await page.click('#recTabs [data-tab="sched"]');
  assert.deepStrictEqual(await chips(page.locator('.rec', { hasText: '金鐘61' })), [`娛樂・排程 ${md}`]);
  ok('排程時間已過的失敗台：要選新時間（同時間視窗規則）才能重送；送 /schedule 帶新時間、狀態更新');

  // 複製到新增發文：帶標題、小編文、網址、版型、模式；不帶圖
  await page.click('#recTabs [data-tab="all"]');
  await page.locator('.rec', { hasText: '金鐘61' }).locator('[data-copy]').click();
  assert(await page.isVisible('#modal'));
  assert.strictEqual(await page.inputValue('#url'), 'https://news.tvbs.com.tw/entertainment/3012399');
  assert.strictEqual(await page.inputValue('#title'), '金鐘61／《飢餓》10週年大禮！\n峮峮驚喜合體遭催回歸');
  assert.strictEqual(await page.inputValue('#caption'), '金鐘 61 #金鐘61');
  assert.strictEqual(await page.textContent('#frameSwitch .active'), '娛樂（粉框）');
  assert.strictEqual(await page.textContent('#modeSwitch .active'), '作圖框');
  assert.strictEqual(await page.evaluate(() => Editor.hasImage()), false, '圖不帶');
  assert.match(await page.textContent('#urlHint'), /照片請重新選/);
  await page.keyboard.press('Escape');
  await page.click('#cfLeave');
  await page.locator('.rec', { hasText: '【快訊】北市宣布' }).locator('[data-copy]').click();
  assert.strictEqual(await page.textContent('#modeSwitch .active'), '純文字底圖');
  assert.strictEqual(await page.inputValue('#title'), '【快訊】北市宣布\n明天停班停課');
  assert.strictEqual(await page.evaluate(() => App.state.cardStyle), await page.evaluate(() => NEWSNET_CONFIG.textCardStyles[2].key));
  await page.keyboard.press('Escape');
  await page.click('#cfLeave');
  ok('複製到新增發文：帶入標題、小編文、網址、版型與模式，不帶圖');

  // 刪除紀錄：先確認；取消不刪
  const dueDel = page.locator('.rec', { hasText: '【快訊】北市宣布' }).locator('[data-del]');
  await dueDel.click();
  assert(await page.isVisible('#rcDlg'));
  await page.keyboard.press('Escape');
  assert(!(await page.isVisible('#rcDlg')));
  assert.strictEqual(await page.locator('.rec', { hasText: '【快訊】北市宣布' }).count(), 1, '取消不刪');
  await dueDel.click();
  await page.click('#rcGo');
  assert.strictEqual(await page.locator('.rec', { hasText: '【快訊】北市宣布' }).count(), 0);
  assert.deepStrictEqual(await tabs(), ['全部 24', '已排程 2', '已發布 23', '失敗']);
  assert.strictEqual(await page.evaluate(() => Records.list().length), 24);
  ok('刪除紀錄：確認後只刪本機這一筆');

  // 複製標題、複製圖片（重新請後端產成品圖 → 剪貼簿 image/png）
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const toastIs = re => page.waitForFunction(r => new RegExp(r).test(document.getElementById('toast').textContent), re.source);
  const clipText = () => page.evaluate(() => navigator.clipboard.readText());
  const clipImage = () => page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const it = items.find(i => i.types.includes('image/png'));
    if (!it) return { types: items.flatMap(i => i.types) };
    const b = await it.getType('image/png'), bm = await createImageBitmap(b);
    return { types: it.types, size: b.size, w: bm.width, h: bm.height };
  });
  const renders = async () => (await calls()).filter(c => /^\/render/.test(c.path));
  const tyRow = page.locator('.rec', { hasText: '颱風假最新' });
  await tyRow.locator('[data-ctitle]').click();
  await toastIs(/^已複製標題$/);
  assert.strictEqual(await clipText(), '颱風假最新！北北基桃\n明天照常上班上課');
  const r0 = (await renders()).length;
  await page.evaluate(() => { window.__mock.renderDelay = 700; });
  await tyRow.locator('[data-cimg]').click();
  await page.waitForFunction(() => /產圖中/.test(document.querySelector('.rec [data-cimg][aria-busy=true]')?.textContent || ''));
  assert(await tyRow.locator('[data-cimg]').isDisabled(), '產圖中按鈕停用');
  await toastIs(/已複製圖片/);
  await page.evaluate(() => { window.__mock.renderDelay = 0; });
  const rr = (await renders()).slice(r0);
  assert.strictEqual(rr.length, 1);
  assert.strictEqual(rr[0].path, '/render');
  assert.deepStrictEqual(Object.keys(rr[0].body), ['image_url', 'lines', 'layout', 'crop'], '/render body 只有舊版的四個欄位');
  assert.deepStrictEqual(rr[0].body, { image_url: first[0].body.image_url, lines: ['颱風假最新！北北基桃', '明天照常上班上課'], layout: 'newsnet_news', crop: null });
  const img = await clipImage();
  assert.deepStrictEqual([img.types.includes('image/png'), img.w, img.h], [true, 540, 540], '剪貼簿有後端成品圖：' + JSON.stringify(img));
  assert.strictEqual(await tyRow.locator('[data-cimg]').textContent(), '複製圖片', '產完恢復');
  assert.strictEqual(worker.uploads, 1, '不重傳圖');
  ok('複製標題：剪貼簿是分行標題；複製圖片：產圖中狀態、/render 只帶 image_url／lines／layout／crop、剪貼簿是 image/png');

  // 純文字底圖、過期、舊紀錄、後端錯誤、不支援 ClipboardItem 時改下載
  await page.evaluate(() => {
    const now = Date.now(), all = JSON.parse(localStorage.getItem(Records.KEY));
    const cardIn = { mode: 'text_card', lines: ['【快訊】雙北宣布', '明天停班停課'], cardText: '【快訊】雙北宣布\n明天停班停課', cardStyle: NEWSNET_CONFIG.textCardStyles[1].key };
    all.push({ id: 'seed-card', at: new Date(now - 5 * 864e5).toISOString(), mode: 'text_card', title: cardIn.cardText, lines: cardIn.lines, caption: '', url: '', cardStyle: cardIn.cardStyle,
      render: Payload.previewRequest(cardIn), pages: [{ code: 'news', label: '新聞', kind: 'now', status: 'ok', link: 'https://www.facebook.com/card' }] });
    all.push({ id: 'seed-exp', at: new Date(now - 4 * 864e5).toISOString(), imgExp: new Date(now - 864e5).toISOString(), mode: 'single', frame: 'news', title: '過期的圖', lines: ['過期的圖'],
      render: { path: '/render', body: { image_url: 'https://snn-images.19jpz-3.workers.dev/i/' + '8'.repeat(32) + '.jpg', lines: ['過期的圖'], layout: 'newsnet_news', crop: null } },
      pages: [{ code: 'news', label: '新聞', kind: 'now', status: 'ok' }] });
    localStorage.setItem(Records.KEY, JSON.stringify(all));
    RecList.render();
  });
  const cardRow = page.locator('.rec', { hasText: '【快訊】雙北宣布' });
  await cardRow.locator('[data-ctitle]').click();
  await toastIs(/^已複製標題$/);
  assert.strictEqual(await clipText(), '【快訊】雙北宣布\n明天停班停課');
  const r1 = (await renders()).length;
  await cardRow.locator('[data-cimg]').click();
  await toastIs(/已複製圖片/);
  const rc = (await renders()).slice(r1);
  assert.deepStrictEqual(rc.map(c => c.path), ['/render_text_card']);
  assert.deepStrictEqual(rc[0].body, await page.evaluate(() => Payload.previewRequest({ mode: 'text_card', lines: ['【快訊】雙北宣布', '明天停班停課'], cardStyle: NEWSNET_CONFIG.textCardStyles[1].key }).body));
  assert((await clipImage()).types.includes('image/png'));
  const expBtn = page.locator('.rec', { hasText: '過期的圖' }).locator('[data-cimg]');
  assert.strictEqual(await expBtn.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(await expBtn.getAttribute('title'), '圖片已過期（圖床只保留 3 天）');
  const r2 = (await renders()).length;
  await expBtn.click({ force: true });   // aria-disabled：仍可點，點了說明原因
  await toastIs(/^圖片已過期（圖床只保留 3 天）$/);
  const oldBtn = page.locator('.rec', { hasText: '舊紀錄 1' }).first().locator('[data-cimg]');
  assert.strictEqual(await oldBtn.getAttribute('aria-disabled'), 'true');
  assert.match(await oldBtn.getAttribute('title'), /舊版紀錄沒有存出圖資料/);
  assert.strictEqual((await renders()).length, r2, '不能複製的不打後端');
  await page.evaluate(() => { window.__mock.renderFail = true; });
  await tyRow.locator('[data-cimg]').click();
  await toastIs(/^複製圖片失敗：HTTP 500：產圖失敗（模擬）$/);
  await page.evaluate(() => { window.__mock.renderFail = false; });
  await page.evaluate(() => { window.__realCI = window.ClipboardItem; window.ClipboardItem = undefined; });
  const [dl] = await Promise.all([page.waitForEvent('download'), tyRow.locator('[data-cimg]').click()]);
  assert.strictEqual(dl.suggestedFilename(), 'newsnet-3012345.png');
  assert.strictEqual(fs.readFileSync(await dl.path()).subarray(1, 4).toString(), 'PNG');
  await toastIs(/不支援複製圖片，已下載 newsnet-3012345\.png/);
  await page.evaluate(() => { window.ClipboardItem = window.__realCI; });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, 'copy-list.png') });
  ok('純文字底圖打 /render_text_card；過期與舊紀錄停用並說明原因；後端錯誤顯示訊息；不支援時改下載 PNG；已截圖 copy-list.png');

  // 手機 390：列表、彈窗底列
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  const mg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth,
    out: [...document.querySelectorAll('.rec, .rec .chip, .rec-act .linkish, .rec-tabs, .pager')].filter(e => { const r = e.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 0.5; }).length }));
  assert.deepStrictEqual(mg, { sw: 390, out: 0 }, '列表沒有橫向捲動、元素都在畫面內');
  await page.screenshot({ path: path.join(SHOTS, 'prC-mobile.png') });
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.screenshot({ path: path.join(SHOTS, 'copy-list-mobile.png') });
  await page.click('#newBtn');
  for (const i of [0, 2, 5]) await pg(i).locator('button').first().click();
  const foot = await page.evaluate(() => {
    const iw = innerWidth, ih = innerHeight;
    const r = e => e.getBoundingClientRect();
    const btn = r(document.getElementById('sendBtn'));
    const pgs = [...document.querySelectorAll('.pg')].map(r);
    return { sw: document.documentElement.scrollWidth, btn: [btn.left >= 0, btn.right <= iw, btn.bottom <= ih, btn.height >= 40],
      pages: pgs.every(b => b.left >= 0 && b.right <= iw && b.bottom <= ih) };
  });
  assert.deepStrictEqual(foot, { sw: 390, btn: [true, true, true, true], pages: true }, '底列粉專按鈕與全部送出在畫面內');
  await page.screenshot({ path: path.join(SHOTS, 'prC-mobile-modal.png') });
  await page.keyboard.press('Escape');
  await page.click('#cfLeave').catch(() => {});
  ok('手機 390：列表與彈窗底列不橫向捲動、按鈕在畫面內；已截圖 prC-mobile.png');

  assert.deepStrictEqual(errors, [], '頁面錯誤：' + errors.join('\n'));
  ok('PR C 沒有 page error / console error');
  await browser.close();
}

// ===== 帶入：純文字底圖模式也載入主圖，切回作圖框不用再按一次；貼上網址自動帶入 =====
async function fillBothModes(origin) {
  console.log('\n  帶入（兩種模式都載入主圖）');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(MOCK_BRIDGE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /登入剩/.test(document.getElementById('extText').textContent));
  await page.click('#newBtn');
  await page.click('[data-mode="text"]');
  assert.strictEqual(await page.evaluate(() => Editor.hasImage()), false);
  await page.fill('#url', 'https://news.tvbs.com.tw/life/9990001');
  await page.click('#fillBtn');
  await page.waitForFunction(() => /已帶入標題.*與主圖（切到作圖框即可使用）/.test(document.getElementById('urlHint').textContent));
  assert.strictEqual(await page.evaluate(() => Editor.hasImage()), true);
  await page.click('[data-mode="frame"]');
  assert.strictEqual(await page.evaluate(() => Editor.hasImage()), true);
  ok('純文字底圖模式帶入也載入主圖，切到作圖框直接有圖');

  await page.evaluate(() => Editor.clearImage());
  await page.fill('#url', '');
  await page.focus('#url');
  await page.evaluate(() => {
    const el = document.getElementById('url');
    el.value = 'https://news.tvbs.com.tw/life/9990001';
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true }));
  });
  await page.waitForFunction(() => Editor.hasImage());
  ok('貼上網址自動帶入（不用按帶入）');
  assert.deepStrictEqual(errors, []);
  await browser.close();
}

// ===== 帶入預填小編文（QPT 的圖文格式）、標題同步【】那一行、AI 產生放最上面 =====
async function captionFlow(origin) {
  console.log('\n  小編文（圖文格式）');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(MOCK_BRIDGE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(origin + '/index.html');
  await page.waitForFunction(() => /登入剩/.test(document.getElementById('extText').textContent));
  const cap = () => page.inputValue('#caption');
  const hintText = () => page.textContent('#urlHint');
  const fill = async (u, re) => {
    await page.fill('#url', u);
    await page.click('#fillBtn');
    await page.waitForFunction(re => new RegExp(re).test(document.getElementById('urlHint').textContent), re.source);
  };
  const T0 = '蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始';
  const CAP = '（圖／TVBS）', TAGS = '#沈伯洋 #蔡英文 #賴清德';

  await page.click('#newBtn');
  await fill('https://news.tvbs.com.tw/politics/3012345', /小編文已帶入/);
  assert.strictEqual(await cap(), `【${T0}】\n${CAP}\n${TAGS}`, '【原標題（含全形空格）】／主圖圖說／2～3 字 hashtag');
  assert.match(await hintText(), /小編文已帶入標題、圖說、hashtag/);
  const art = (await page.evaluate(() => window.__calls)).filter(c => c.op === 'fetchArticle');
  assert.deepStrictEqual(art, [{ op: 'fetchArticle', url: 'https://news.tvbs.com.tw/politics/3012345' }]);
  ok('帶入：小編文預填【標題】／（圖／TVBS）／#標籤（' + (await cap()).replace(/\n/g, '⏎') + '）');

  // 每次改標題都即時更新【】那一行（逐字打也算）
  await page.fill('#title', '颱風假最新！北北基桃\n明天照常上班上課');
  assert.strictEqual(await cap(), `【颱風假最新！北北基桃 明天照常上班上課】\n${CAP}\n${TAGS}`);
  await page.focus('#title');
  await page.keyboard.press('End');
  await page.keyboard.type('喔');
  assert.strictEqual((await cap()).split('\n')[0], '【颱風假最新！北北基桃 明天照常上班上課喔】');
  await page.keyboard.press('Backspace');
  ok('改標題：【】那一行逐字跟著改，其他行不動');

  // AI 產生：放最上面；再按一次是換掉，不是疊兩份
  await page.evaluate(() => { window.__mock.aiText = 'AI 第一版小編文\n第二行'; window.__mock.aiTags = ['颱風', '賴清德']; });
  await page.click('#aiGenBtn');
  await page.waitForFunction(() => /^AI 第一版/.test(document.getElementById('caption').value));
  assert.strictEqual(await cap(), `AI 第一版小編文\n第二行\n【颱風假最新！北北基桃 明天照常上班上課】\n${CAP}\n${TAGS}`);
  await page.evaluate(() => { window.__mock.aiText = 'AI 第二版小編文'; });
  await page.click('#aiGenBtn');
  await page.waitForFunction(() => /^AI 第二版/.test(document.getElementById('caption').value));
  assert.strictEqual(await cap(), `AI 第二版小編文\n【颱風假最新！北北基桃 明天照常上班上課】\n${CAP}\n${TAGS}`);
  ok('AI 產生：文字放在最上面；再按一次換掉上一次的 AI 文字；原本已有 3 個 hashtag，AI 的不再補');

  // AI 產生之後、小編手動改了圖說：改標題仍只換【】那一行
  await page.fill('#caption', (await cap()).replace(CAP, '（圖／小編改的圖說）'));
  await page.fill('#title', '北北基桃明天\n照常上班上課');
  assert.strictEqual(await cap(), `AI 第二版小編文\n【北北基桃明天 照常上班上課】\n（圖／小編改的圖說）\n${TAGS}`);
  await page.evaluate(() => document.querySelector('.m-body').scrollTop = 0);
  await page.screenshot({ path: path.join(SHOTS, 'caption-qpt.png') });
  ok('AI 產生＋手動改圖說後改標題：只換【】那一行；已截圖 caption-qpt.png');

  // 小編改過的小編文：再帶入不覆蓋，只更新【】那一行
  await fill('https://news.tvbs.com.tw/politics/3012345', /小編文已改過/);
  assert.strictEqual(await cap(), `AI 第二版小編文\n【${T0}】\n（圖／小編改的圖說）\n${TAGS}`);
  ok('小編改過的小編文：帶入不覆蓋（' + await hintText() + '）');

  // 【】那一行整行刪掉：改標題不再補回來
  await page.fill('#caption', 'AI 第二版小編文\n（圖／小編改的圖說）');
  await page.fill('#title', '新標題');
  assert.strictEqual(await cap(), 'AI 第二版小編文\n（圖／小編改的圖說）');
  ok('【】那一行刪掉後，改標題不補回來');

  // 沒抓到圖說／hashtag：照 QPT 列出缺什麼
  await page.fill('#caption', '');
  await fill('https://news.tvbs.com.tw/politics/9990002', /小編文已帶入/);
  assert.strictEqual(await cap(), `【${T0}】`);
  assert.match(await hintText(), /小編文已帶入，但沒抓到圖說、沒抓到 2～3 字的 hashtag/);
  ok('缺圖說與 hashtag 時提示：' + await hintText());

  // 舊外掛（沒有 fetchArticle）：提示更新，標題與【標題】照樣帶入
  await page.evaluate(() => { window.__mock.oldExt = true; });
  await page.fill('#caption', '');
  await page.fill('#title', '');
  await fill('https://news.tvbs.com.tw/politics/3012345', /外掛版本太舊/);
  assert.strictEqual(await page.inputValue('#title'), (await page.evaluate(t => Rules.breakTitle(t), T0)).join('\n'));
  assert.strictEqual(await cap(), `【${T0}】`);
  assert.match(await page.getAttribute('#urlHint', 'class'), /bad/);
  ok('舊外掛：提示更新到 0.6.0，標題與【標題】照樣帶入（' + await hintText() + '）');

  assert.deepStrictEqual(errors, [], errors.join('\n'));
  await browser.close();
}

// ===== 安裝插件教學：沒外掛自動打開；檔案只取 GitHub 的 extension/ 並驗證 SHA；有外掛、手機不跳 =====
async function installGuide(origin) {
  console.log('\n  安裝插件教學');
  const crypto = require('crypto');
  const blobSha = buf => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
  const files = { 'extension/manifest.json': Buffer.from('{"name":"網新快速排程 連線驗證","version":"0.0.0"}'), 'extension/bridge.js': Buffer.from('// b'), 'web/index.html': Buffer.from('<p>') };
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const mockGitHub = async (ctx, bad) => {
    const api = 'https://api.github.com/repos/unnn3ing-oss/-schedulenewnet';
    await ctx.route(api + '/commits/main', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ sha: 'c0ffee', commit: { tree: { sha: 'tree1' } } }) }));
    await ctx.route(api + '/git/trees/tree1?recursive=1', r => r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ truncated: false, tree: Object.entries(files).map(([p, b]) => ({ path: p, type: 'blob', sha: blobSha(b) })) }) }));
    await ctx.route('https://raw.githubusercontent.com/unnn3ing-oss/-schedulenewnet/c0ffee/**', r => {
      const p = decodeURIComponent(new URL(r.request().url()).pathname.split('/c0ffee/')[1]);
      r.fulfill({ body: bad && p.endsWith('bridge.js') ? Buffer.from('// 被改過') : files[p] });
    });
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await mockGitHub(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(origin + '/index.html');
  await page.waitForSelector('#deployOverlay:not([hidden])', { timeout: 8000 });
  assert.match(await page.textContent('#extText'), /未偵測到外掛/);
  assert.strictEqual(await page.evaluate(() => document.querySelector('#deployOverlay [data-style]').style.getPropertyValue('--d').trim() !== ''), true, '動畫時間由 data-style 套上');
  ok('沒有外掛：重試後自動打開安裝教學，動畫時間有套上');
  assert.match(await page.textContent('#deployCount'), /1 \/ 5/);
  const [inst] = await Promise.all([page.waitForEvent('download'), page.click('#deployInstallBtn')]);
  assert.strictEqual(inst.suggestedFilename(), 'schedulenewnet-install.cmd');
  const cmd = fs.readFileSync(await inst.path(), 'utf8');
  const embedded = Buffer.from(cmd.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('latin1');
  assert(embedded.startsWith('PK') && embedded.includes('manifest.json') && embedded.includes('bridge.js') && !embedded.includes('schedulenewnet-ext/') && !embedded.includes('index.html'), '安裝檔嵌的 ZIP 只含 extension/ 的檔案、沒有最上層資料夾');
  assert.match(cmd, /安裝程式 0\.0\.0/);
  const zipFile = path.join(require('os').tmpdir(), 'snn-embedded.zip');
  fs.writeFileSync(zipFile, Buffer.from(embedded, 'latin1'));
  assert.match(require('child_process').execFileSync('unzip', ['-t', zipFile], { encoding: 'utf8' }), /No errors detected/, '網頁打包的 ZIP 解得開');
  await page.waitForFunction(() => /已下載安裝檔/.test(document.getElementById('deployStatus').textContent));
  ok('下載安裝檔：Windows .cmd，內嵌驗證過的插件 ZIP');
  await page.click('#deployOverlay .ds-more summary');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#deployZipBtn')]);
  const zip = fs.readFileSync(await dl.path()).toString('latin1');
  assert.strictEqual(dl.suggestedFilename(), 'schedulenewnet-ext.zip');
  assert(zip.includes('schedulenewnet-ext/manifest.json') && zip.includes('schedulenewnet-ext/bridge.js') && !zip.includes('index.html'), 'ZIP 只含 extension/ 的檔案');
  await page.waitForFunction(() => /已下載 ZIP（2 個檔案）/.test(document.getElementById('deployStatus').textContent));
  ok('下載 ZIP：只取 extension/、路徑去掉前綴（' + await page.textContent('#deployStatus') + '）');
  await page.keyboard.press('Escape');
  assert(await page.isHidden('#deployOverlay'));
  await page.click('#deployBtn');
  assert(await page.isVisible('#deployOverlay'));
  await page.click('#deployNextBtn');
  assert(await page.isHidden('#deployCopyCmd'), 'Windows 不顯示 Mac 終端機指令');
  for (let i = 0; i < 3; i++) await page.click('#deployNextBtn');
  assert.strictEqual(await page.textContent('#deployNextBtn'), '完成');
  assert.match(await page.textContent('#dsh5'), /重新整理/);
  await page.click('#deployNextBtn');
  assert(await page.isHidden('#deployOverlay'));
  ok('右上角「安裝插件」可再打開；Esc、完成可關閉；共 5 步');
  assert.deepStrictEqual(errors, [], '頁面錯誤：' + errors.join('\n'));
  await ctx.close();

  const bad = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await mockGitHub(bad, true);
  const p2 = await bad.newPage();
  await p2.goto(origin + '/index.html');
  await p2.waitForSelector('#deployOverlay:not([hidden])', { timeout: 8000 });
  await p2.click('#deployInstallBtn');
  await p2.waitForFunction(() => /不一致，已取消/.test(document.getElementById('deployStatus').textContent));
  ok('檔案內容和 GitHub SHA 不符：整批取消');
  await bad.close();

  const withExt = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await withExt.addInitScript(MOCK_BRIDGE);
  const p3 = await withExt.newPage();
  await p3.goto(origin + '/index.html');
  await p3.waitForFunction(() => /外掛已連線/.test(document.getElementById('extText').textContent));
  await p3.waitForTimeout(3500);
  assert(await p3.isHidden('#deployOverlay'), '有外掛不跳');
  await withExt.close();
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' });
  const p4 = await phone.newPage();
  await p4.goto(origin + '/index.html');
  await p4.waitForFunction(() => /未偵測到外掛/.test(document.getElementById('extText').textContent), null, { timeout: 8000 });
  await p4.waitForTimeout(500);
  assert(await p4.isHidden('#deployOverlay'), '手機不跳');
  await phone.close();
  ok('有外掛、手機都不自動跳出');
  const panel = await browser.newContext({ viewport: { width: 400, height: 800 } });
  const p5 = await panel.newPage();
  await p5.setContent(`<iframe id="app" src="${origin}/index.html" style="width:400px;height:780px;border:0"></iframe>`);
  const f5 = await (await p5.waitForSelector('#app')).contentFrame();
  await f5.waitForFunction(() => /未偵測到外掛/.test(document.getElementById('extText').textContent), null, { timeout: 8000 });
  await p5.waitForTimeout(500);
  assert(await f5.evaluate(() => document.documentElement.classList.contains('in-panel')));
  assert(await f5.isHidden('#deployBtn') && await f5.isHidden('#deployOverlay'), '嵌在側邊欄：不顯示安裝插件、不跳教學');
  await panel.close();
  ok('嵌在外掛側邊欄（iframe）：不顯示「安裝插件」、不自動跳教學');
  await browser.close();
}
