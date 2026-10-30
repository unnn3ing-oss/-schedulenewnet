// 側邊欄更新彈窗（外掛真的載入 Chromium；Updater 換成假的，不連 GitHub、不寫檔案）
// node test/e2e/sidepanel.e2e.js
const { chromium } = require('playwright'); const path = require('path'); const assert = require('assert');
(async () => {
  const ext = path.join(__dirname, '..', '..', 'extension');
  const ctx = await chromium.launchPersistentContext('', { headless: false, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  await ctx.addInitScript(() => {
    let real;
    window.__log = []; window.__saved = false;
    Object.defineProperty(window, 'Updater', { configurable: true, get: () => real, set(v) {
      real = Object.assign({}, v, {
        checkLatest: async () => ({ hasUpdate: true, version: '0.9.0', localVersion: '0.8.3', sha: 'abc', date: new Date().toISOString(), message: 'm',
          notes: [{ summary: '新功能說明', items: ['第一點', '第二點'] }], changed: [{ path: 'a.js', status: 'mod' }, { path: 'manifest.json', status: 'mod' }] }),
        hasSavedFolder: async () => window.__saved,
        getFolder: async () => (window.__saved ? { fake: 1 } : null),
        pickFolder: async () => { window.__log.push('pick'); window.__saved = true; return { fake: 1 }; },
        apply: async (dir, info, onP, confirmFn) => {
          onP('下載 1/2：a.js'); await new Promise(r => setTimeout(r, 300));
          onP('下載 2/2：manifest.json'); await new Promise(r => setTimeout(r, 300));
          if (!(await confirmFn(['新增權限：tabs']))) { const e = new Error('已取消更新'); e.name = 'AbortError'; throw e; }
          onP('寫入 1/2：a.js'); await new Promise(r => setTimeout(r, 300));
          if (window.__fail) throw new Error('寫入失敗（測試）');
          window.__log.push('applied');
        }
      });
    } });
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.setViewportSize({ width: 380, height: 720 });
  await p.goto(`chrome-extension://${id}/sidepanel.html`);
  await p.evaluate(() => { chrome.runtime.reload = () => window.__log.push('reload'); });
  // 1. 自動彈出新版
  await p.waitForSelector('#upDlg[open]');
  assert.match(await p.textContent('#upDlgTitle'), /有新版本 v0\.9\.0/);
  assert.match(await p.textContent('#upDlgBody'), /新功能說明.*第一點/s);
  await p.click('#upDlgBtns >> text=立即更新');
  // 2. 沒選過資料夾 → 選資料夾說明
  await p.waitForFunction(() => /選擇外掛資料夾/.test(document.getElementById('upDlgTitle').textContent));
  assert.match(await p.textContent('#upDlgBody'), /schedulenewnet-ext/);
  await p.click('#upDlgBtns >> text=選擇資料夾');
  // 3. 權限變動確認（在彈窗裡）
  await p.waitForFunction(() => /增加權限/.test(document.getElementById('upDlgTitle').textContent));
  assert.match(await p.textContent('#upDlgBody'), /新增權限：tabs/);
  await p.click('#upDlgBtns >> text=繼續更新');
  await p.waitForFunction(() => /更新完成/.test(document.getElementById('upDlgTitle').textContent));
  await p.waitForTimeout(1100);
  let log = await p.evaluate(() => window.__log);
  assert.deepStrictEqual(log, ['pick', 'applied', 'reload']);
  // 4. 第二次：記住資料夾，不再選；失敗時彈窗顯示並可重試
  await p.evaluate(() => { window.__log = []; window.__fail = true; document.getElementById('upDlg').close(); document.getElementById('upApplyBtn').disabled = false; document.getElementById('upCheckBtn').disabled = false; });
  await p.click('#tabInfo');
  assert(await p.isVisible('#upFolder'), '顯示已記住');
  await p.click('#upApplyBtn');
  await p.waitForFunction(() => /增加權限/.test(document.getElementById('upDlgTitle').textContent));
  await p.click('#upDlgBtns >> text=繼續更新');
  await p.waitForFunction(() => /沒有更新成功/.test(document.getElementById('upDlgTitle').textContent));
  assert.match(await p.textContent('#upDlgBody'), /寫入失敗（測試）/);
  await p.evaluate(() => { window.__fail = false; });
  await p.click('#upDlgBtns >> text=重試');
  await p.waitForFunction(() => /增加權限/.test(document.getElementById('upDlgTitle').textContent));
  await p.click('#upDlgBtns >> text=取消更新');
  await p.waitForFunction(() => !document.getElementById('upDlg').open);
  assert.match(await p.textContent('#upStatus'), /已取消/);
  log = await p.evaluate(() => window.__log);
  assert(!log.includes('pick'), '第二次不再選資料夾');
  assert.deepStrictEqual(errs, []);
  console.log('側邊欄更新彈窗：新版彈窗 → 選資料夾（只一次）→ 權限確認 → 完成；第二次沿用資料夾、失敗可重試、取消 — ok');
  await ctx.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
