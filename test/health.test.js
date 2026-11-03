const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../web/health.js');
const F = require('../web/sendflow.js');

const NOW = Date.UTC(2026, 10, 3, 4, 0, 0);
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

// 全部正常的假相依；個別測試再覆寫
function deps(over) {
  const calls = [];
  const d = {
    calls,
    now: () => NOW,
    online: () => true,
    selfUrl: 'https://x/icons/icon16.png',
    imgBase: 'https://img',
    fetch: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
      if (url === 'https://x/icons/icon16.png') return res(200, {});
      if (url === 'https://img/config') return res(200, { ok: true, data: { password: true } });
      if (url === 'https://img/rundown') return res(200, { ok: true, data: { title: 'FB RUNDOWN(2026)', sheets: ['2026/11'] } });
      throw new Error('unexpected ' + url);
    },
    ping: async () => ({ ok: true, version: '0.8.4' }),
    cookies: async () => ({ ok: true, data: [{ name: 'queen_session', expires: new Date(NOW + 10 * 864e5).toISOString() }] }),
    call: async path => { calls.push({ ext: path }); return { ok: true, data: { status: 200, contentType: 'application/json', text: '{"title":"TVBS"}' } }; },
    extErrorKind: F.extErrorKind,
    latestExtVersion: async () => '0.8.4',
    imgSession: () => ({ session: 's', exp: Math.floor(NOW / 1000) + 20 * 86400 }),
    rundownEnabled: () => true
  };
  return Object.assign(d, over);
}
const byId = rows => Object.fromEntries(rows.map(r => [r.id, r]));

test('全部正常（一鍵檢測）：每項都 ✅、沒有提示；後台只打唯讀的 page_meta', async () => {
  const d = deps();
  const rows = await H.run(d, { deep: true, timeout: 500 });
  assert.deepEqual(rows.map(r => r.id), H.ITEMS.map(x => x[0]));
  for (const r of rows) { assert.equal(r.status, 'ok', r.id + '：' + r.text); assert.equal(r.hint, ''); }
  assert.equal(H.summary(rows), '全部正常');
  const ext = d.calls.filter(c => c.ext).map(c => c.ext);
  assert.deepEqual(ext, ['/page_meta?url=' + encodeURIComponent(H.PROBE_URL)]);
  assert(!d.calls.some(c => /schedule|publish|guard|render|ai_caption/.test(c.url || c.ext)), '不打會改資料或花資源的端點');
  assert.deepEqual(JSON.parse(d.calls.find(c => c.url === 'https://img/rundown').body), { action: 'ping' });
  assert.match(byId(rows).rundown.text, /FB RUNDOWN/);
});

test('快速檢測（開啟時自動跑）：不打後台、不連 Rundown', async () => {
  const d = deps();
  const rows = byId(await H.run(d, { timeout: 500 }));
  assert.equal(rows.backend.status, 'skip');
  assert.equal(rows.rundown.status, 'skip');
  assert(!d.calls.some(c => c.ext || c.url === 'https://img/rundown'));
});

test('外掛 ping 只呼叫一次（各項共用）', async () => {
  let n = 0;
  await H.run(deps({ ping: async () => { n++; return { ok: true, version: '0.8.4' }; } }), { deep: true, timeout: 500 });
  assert.equal(n, 1);
});

test('沒裝外掛：外掛 ❌ 附安裝提示，相依的項目略過', async () => {
  const rows = byId(await H.run(deps({ ping: async () => ({ ok: false, error: 'no_extension' }) }), { deep: true, timeout: 500 }));
  assert.equal(rows.ext.status, 'bad');
  assert.match(rows.ext.hint, /安裝插件/);
  for (const k of ['conn', 'extUpdate', 'login', 'backend']) assert.equal(rows[k].status, 'skip', k);
});

test('外掛剛更新（舊內容腳本）：頁面與外掛連線 ❌「請重新整理頁面」', async () => {
  const rows = byId(await H.run(deps({ ping: async () => ({ ok: false, error: 'Extension context invalidated.' }) }), { timeout: 500 }));
  assert.equal(rows.conn.status, 'bad');
  assert.match(rows.conn.text, /外掛剛更新，請重新整理頁面/);
  assert.match(rows.conn.hint, /F5/);
  assert.equal(rows.ext.status, 'warn');
});

test('外掛有新版：⚠️ 並提示到側邊欄更新；查不到最新版也只是 ⚠️', async () => {
  let rows = byId(await H.run(deps({ latestExtVersion: async () => '0.9.0' }), { timeout: 500 }));
  assert.equal(rows.extUpdate.status, 'warn');
  assert.match(rows.extUpdate.text, /v0\.9\.0.*v0\.8\.4/);
  assert.match(rows.extUpdate.hint, /狀態與更新/);
  rows = byId(await H.run(deps({ latestExtVersion: async () => { throw new Error('x'); } }), { timeout: 500 }));
  assert.equal(rows.extUpdate.status, 'warn');
  rows = byId(await H.run(deps({ latestExtVersion: async () => '0.8.3' }), { timeout: 500 }));
  assert.equal(rows.extUpdate.status, 'ok');
});

test('網新登入：沒 cookie ❌、快到期 ⚠️、session cookie ✅；不顯示 cookie 值', async () => {
  const cookie = (expires, extra) => deps({ cookies: async () => ({ ok: true, data: [Object.assign({ name: 'queen_session', expires }, extra)] }) });
  let rows = byId(await H.run(deps({ cookies: async () => ({ ok: true, data: [{ name: 'other', expires: 'session' }] }) }), { timeout: 500 }));
  assert.equal(rows.login.status, 'bad');
  assert.match(rows.login.hint, /登入/);
  rows = byId(await H.run(cookie(new Date(NOW + 1.5 * 864e5).toISOString()), { timeout: 500 }));
  assert.equal(rows.login.status, 'warn');
  rows = byId(await H.run(cookie(new Date(NOW - 1000).toISOString()), { timeout: 500 }));
  assert.equal(rows.login.status, 'bad');
  rows = byId(await H.run(cookie('session', { value: 'SECRET-VALUE' }), { timeout: 500 }));
  assert.equal(rows.login.status, 'ok');
  assert(!JSON.stringify(rows).includes('SECRET-VALUE'));
});

test('後台回應：401／403、導去登入頁 ❌；5xx ⚠️', async () => {
  const backend = (status, text) => deps({ call: async () => ({ ok: true, data: { status, text } }) });
  for (const [st, text, want] of [[401, '', 'bad'], [403, '{"detail":"x"}', 'bad'], [200, '<!doctype html><html>login', 'bad'], [502, '<html>', 'warn'], [422, '{"detail":"url"}', 'ok']]) {
    const rows = byId(await H.run(backend(st, text), { deep: true, timeout: 500, only: ['backend'] }));
    assert.equal(rows.backend.status, want, `HTTP ${st}`);
  }
});

test('圖床 Worker 沒有 /config：⚠️ 提示重新部署 worker/index.js', async () => {
  const d = deps({ imgSession: () => null });
  const base = d.fetch;
  d.fetch = async (url, init) => (url === 'https://img/config' ? res(404, { ok: false, code: 'not_found' }) : base(url, init));
  const rows = byId(await H.run(d, { timeout: 500 }));
  assert.equal(rows.imgWorker.status, 'warn');
  assert.match(rows.imgWorker.hint, /請重新部署 worker\/index\.js/);
  assert.equal(rows.imgLogin.status, 'warn');
  assert.match(rows.imgLogin.text, /圖床未登入/);
});

test('圖床：連不上 ❌；免密碼模式沒憑證也 ✅；憑證不到一天 ⚠️', async () => {
  let rows = byId(await H.run(deps({ fetch: async () => { throw new TypeError('Failed to fetch'); } }), { timeout: 500, only: ['imgWorker', 'net'] }));
  assert.equal(rows.imgWorker.status, 'bad');
  assert.match(rows.imgWorker.hint, /ALLOWED_ORIGIN/);
  assert.equal(rows.net.status, 'bad');
  const d = deps({ imgSession: () => null });
  const base = d.fetch;
  d.fetch = async (url, init) => (url === 'https://img/config' ? res(200, { ok: true, data: { password: false } }) : base(url, init));
  rows = byId(await H.run(d, { timeout: 500 }));
  assert.equal(rows.imgLogin.status, 'ok');
  assert.match(rows.imgWorker.text, /免密碼/);
  rows = byId(await H.run(deps({ imgSession: () => ({ session: 's', exp: Math.floor(NOW / 1000) + 3 * 3600 }) }), { timeout: 500, only: ['imgLogin'] }));
  assert.equal(rows.imgLogin.status, 'warn');
  assert.match(rows.imgLogin.text, /3 小時/);
});

test('Rundown：沒開 ➖、沒登入圖床 ⚠️（不是 ❌）、憑證失效 ⚠️、Apps Script 錯 ❌', async () => {
  let rows = byId(await H.run(deps({ rundownEnabled: () => false }), { deep: true, timeout: 500, only: ['rundown'] }));
  assert.equal(rows.rundown.status, 'skip');
  rows = byId(await H.run(deps({ imgSession: () => null }), { deep: true, timeout: 500, only: ['rundown'] }));
  assert.equal(rows.rundown.status, 'warn');
  const rd = (status, body) => { const d = deps(); const base = d.fetch; d.fetch = async (u, i) => (u === 'https://img/rundown' ? res(status, body) : base(u, i)); return d; };
  rows = byId(await H.run(rd(401, { ok: false }), { deep: true, timeout: 500, only: ['rundown'] }));
  assert.equal(rows.rundown.status, 'warn');
  rows = byId(await H.run(rd(200, { ok: false, error: 'Worker 沒有設定 RUNDOWN_URL' }), { deep: true, timeout: 500, only: ['rundown'] }));
  assert.equal(rows.rundown.status, 'bad');
  assert.match(rows.rundown.text, /RUNDOWN_URL/);
});

test('離線：網路 ❌；單項卡住會逾時、不拖累其他項；即時回報每一列', async () => {
  let rows = byId(await H.run(deps({ online: () => false }), { timeout: 500, only: ['net'] }));
  assert.equal(rows.net.status, 'bad');
  const seen = [];
  const t0 = Date.now();
  rows = await H.run(deps({ ping: () => new Promise(() => {}) }), { timeout: 80, onRow: id => seen.push(id) });
  assert(Date.now() - t0 < 1000);
  const m = byId(rows);
  assert.equal(m.ext.status, 'bad');
  assert.match(m.ext.text, /逾時/);
  assert.equal(m.imgWorker.status, 'ok');
  assert.equal(seen.length, H.ITEMS.length);
  assert.match(H.summary(rows), /項異常/);
});

test('相依丟錯也不會讓整個檢測失敗', async () => {
  const rows = byId(await H.run(deps({ cookies: async () => { throw new Error('boom'); }, ping: async () => { throw new Error('x'); } }), { timeout: 500 }));
  assert.equal(rows.ext.status, 'bad');
  const r2 = byId(await H.run(deps({ cookies: async () => { throw new Error('boom'); } }), { timeout: 500, only: ['login'] }));
  assert.equal(r2.login.status, 'bad');
  assert.match(r2.login.text, /boom/);
});

test('cmpVer', () => {
  assert.equal(H.cmpVer('0.8.4', '0.8.10'), -1);
  assert.equal(H.cmpVer('0.9.0', '0.8.10'), 1);
  assert.equal(H.cmpVer('0.8.4', '0.8.4'), 0);
});
