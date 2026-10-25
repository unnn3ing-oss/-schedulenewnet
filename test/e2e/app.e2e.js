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
  await ctx.close();

  await prB(`http://localhost:${server.address().port}`);
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
  const json = (status, obj, type) => ({ ok: true, data: { status, contentType: type || 'application/json', text: typeof obj === 'string' ? obj : JSON.stringify(obj) } });
  function respond(op, p) {
    if (op === 'ping') return { ok: true, version: '0.5.0' };
    if (op === 'cookies') return { ok: true, data: [{ name: 'queen_session', sameSite: 'lax', httpOnly: true, expires: new Date(Date.now() + 5 * 864e5).toISOString() }] };
    if (op !== 'call') return { ok: false, error: 'unknown_op' };
    calls.push({ path: p.path, method: p.method, body: p.body });
    if (p.path === '/guard/check') return json(200, { level: window.__mock.guardLevel, check_id: 'chk-1', reasons: ['標題用語較聳動'] });
    if (p.path === '/render') return { ok: true, data: { status: 200, contentType: 'image/png', image: picture(540, 540, '後端套版（模擬）') } };
    if (p.path === '/render_text_card') return { ok: true, data: { status: 200, contentType: 'image/png', image: picture(540, 540, '純文字（模擬）') } };
    if (p.path === '/ai_caption') return json(200, p.body.mode === 'generate' ? { caption: 'AI 產生的小編文 #颱風' } : { text: p.body.text.replace('上般', '上班') });
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
    setTimeout(() => window.postMessage(Object.assign({ source: 'snn-ext', nonce: d.nonce }, res), location.origin), 40);
  });
};

async function prB(origin) {
  console.log('\n  PR B（模擬外掛與圖床）');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(MOCK_BRIDGE);
  const worker = { logins: 0, uploads: 0, auths: [] };
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
    return send(404, { ok: false, code: 'not_found' });
  });
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
  await page.fill('#lines .ln >> nth=0', '颱風假最新！北北基桃');
  await page.fill('#lines .ln >> nth=1', '明天照常上班上課');

  // AI 小編文
  await page.click('#aiGenBtn');
  await page.waitForFunction(() => document.getElementById('caption').value === 'AI 產生的小編文 #颱風');
  await page.fill('#caption', '北北基桃明天照常上般上課！\n#颱風 #停班停課');
  await page.click('#aiFixBtn');
  await page.waitForFunction(() => /上班上課/.test(document.getElementById('caption').value));
  const ai = (await calls()).filter(c => c.path === '/ai_caption').map(c => c.body);
  assert.deepStrictEqual(ai[0], { ip: 'newsnet', mode: 'generate', title: '颱風假最新！北北基桃 明天照常上班上課', summary: '' });
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
  assert.strictEqual(render.template, 'newsnet_news');
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

  // 手機：純文字底圖 → 預覽 /render_text_card → 泡泡
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-mode="text"]');
  await page.fill('#cardText', '【快訊】北市宣布明天停班停課');
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
  assert.strictEqual(worker.uploads, 1, '純文字不上傳圖床');
  ok('手機：純文字預覽、黃燈泡泡在畫面內、送出 text_card；已截圖 prB-mobile.png');

  assert.deepStrictEqual(errors, [], '頁面錯誤：' + errors.join('\n'));
  ok('PR B 沒有 page error / console error');
  await browser.close();
}
