const test = require('node:test');
const assert = require('node:assert/strict');

const ORIGIN = 'https://unnn3ing-oss.github.io';
const DAY = 86400000;
const mkEnv = (extra) => Object.assign({
  APP_PASSWORD: 'p'.repeat(20), SESSION_SECRET: 's'.repeat(40), ALLOWED_ORIGIN: ORIGIN,
  FAIL_DELAY_MS: '0', IMAGES: fakeR2()
}, extra);
let mod;
const load = async () => (mod = mod || await import('../worker/index.js'));

/* 記憶體假 R2：put/get/head/delete，物件含 body、httpMetadata、customMetadata、uploaded、size */
function fakeR2() {
  const store = new Map();
  const view = (e) => ({ key: e.key, size: e.bytes.length, uploaded: e.uploaded,
    httpMetadata: e.httpMetadata, customMetadata: e.customMetadata });
  return {
    store,
    async put(key, value, opts = {}) {
      store.set(key, { key, bytes: new Uint8Array(value), uploaded: new Date(),
        httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
    },
    async get(key) {
      const e = store.get(key);
      return e ? Object.assign(view(e), { body: new Blob([e.bytes]).stream() }) : null;
    },
    async head(key) { const e = store.get(key); return e ? view(e) : null; },
    async delete(key) { store.delete(key); }
  };
}

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2]);

async function call(path, init = {}, env) {
  const { default: worker } = await load();
  const headers = Object.assign({ origin: ORIGIN }, init.headers || {});
  if (headers.origin === null) delete headers.origin;
  return worker.fetch(new Request('https://img.test' + path, Object.assign({}, init, { headers })), env || mkEnv());
}
const parse = async (res) => JSON.parse(await res.text());
const login = (password, env) => call('/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ password }) }, env);
async function goodSession(env) {
  const { signSession } = await load();
  return signSession((env || mkEnv()).SESSION_SECRET, Math.floor(Date.now() / 1000) + 600);
}
async function upload(bytes, { type = 'image/jpeg', session, env, headers } = {}) {
  env = env || mkEnv();
  session = session === undefined ? await goodSession(env) : session;
  const h = Object.assign({ 'content-type': type }, headers || {});
  if (session !== null) h.authorization = 'Bearer ' + session;
  return { env, res: await call('/upload', { method: 'POST', headers: h, body: bytes }, env) };
}

test('login 成功：回 session 與約 30 天後的 exp', async () => {
  const { verifySession } = await load();
  const env = mkEnv();
  const res = await login(env.APP_PASSWORD, env);
  const body = await parse(res);
  assert.equal(body.ok, true);
  assert.equal(body.data.ttl, 30 * 86400);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(body.data.exp - now - 30 * 86400) <= 1);
  assert.equal(await verifySession(env.SESSION_SECRET, body.data.session, now), true);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('login 失敗：密碼錯 → unauthorized；格式錯 → bad_request', async () => {
  const env = mkEnv();
  assert.equal((await parse(await login('wrong', env))).code, 'unauthorized');
  const bad = await call('/login', { method: 'POST', body: 'not json' }, env);
  assert.equal((await parse(bad)).code, 'bad_request');
});

test('login 失敗延遲 FAIL_DELAY_MS', async () => {
  const env = mkEnv({ FAIL_DELAY_MS: '40' });
  const t = Date.now();
  await login('wrong', env);
  assert.ok(Date.now() - t >= 35);
});

test('LOGIN_LIMITER 擋住 login 與 upload（upload 以 session 為 key）', async () => {
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const env = mkEnv({ LOGIN_LIMITER: limiter });
  assert.equal((await parse(await login(env.APP_PASSWORD, env))).code, 'rate_limited');
  const session = await goodSession(env);
  const { res } = await upload(JPG, { env, session });
  assert.equal(res.status, 429);
  assert.equal(keys[1], session);
});

test('upload 沒有／過期／偽造憑證 → 401，且不寫入', async () => {
  const { signSession } = await load();
  const env = mkEnv();
  const expired = await signSession(env.SESSION_SECRET, Math.floor(Date.now() / 1000) - 1);
  const forged = await signSession('z'.repeat(40), Math.floor(Date.now() / 1000) + 600);
  const good = await goodSession(env);
  for (const session of [null, '', expired, forged, good + 'x', 'a.b']) {
    const { res } = await upload(JPG, { env, session });
    assert.equal(res.status, 401, String(session));
    assert.equal((await parse(res)).code, 'unauthorized');
  }
  assert.equal(env.IMAGES.store.size, 0);
});

test('upload 檔頭與宣告不符 → 415；不支援類型、空內容也拒絕', async () => {
  const env = mkEnv();
  assert.equal((await upload(PNG, { env, type: 'image/jpeg' })).res.status, 415);
  assert.equal((await upload(new TextEncoder().encode('<script>alert(1)</script>'), { env, type: 'image/png' })).res.status, 415);
  assert.equal((await upload(JPG, { env, type: 'image/gif' })).res.status, 415);
  assert.equal((await upload(JPG, { env, type: 'text/html' })).res.status, 415);
  assert.equal((await upload(new Uint8Array(0), { env })).res.status, 400);
  assert.equal(env.IMAGES.store.size, 0);
});

test('upload 超過 MAX_BYTES → 413（含沒有 content-length 的情況）', async () => {
  const env = mkEnv({ MAX_BYTES: '10' });
  const big = new Uint8Array(20); big.set(JPG);
  const { res } = await upload(big, { env });
  assert.equal(res.status, 413);
  assert.equal((await parse(res)).code, 'too_large');
  const res2 = await call('/upload', { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: 'Bearer ' + await goodSession(env) },
    body: new Blob([big]).stream(), duplex: 'half' }, env);
  assert.equal(res2.status, 413);
  assert.equal(env.IMAGES.store.size, 0);
  // 預設上限 8 MB
  const big2 = new Uint8Array(8 * 1024 * 1024 + 1); big2.set(JPG);
  assert.equal((await upload(big2)).res.status, 413);
});

test('jpeg / png / webp 上傳成功，回傳網址可 GET，內容與標頭正確', async () => {
  for (const [bytes, type, ext] of [[JPG, 'image/jpeg', 'jpg'], [PNG, 'image/png', 'png'], [WEBP, 'image/webp', 'webp']]) {
    const { env, res } = await upload(bytes, { type });
    assert.equal(res.status, 200);
    const body = await parse(res);
    assert.equal(body.ok, true);
    assert.match(body.data.key, new RegExp('^[0-9a-f]{32}\\.' + ext + '$'));
    assert.equal(body.data.url, 'https://img.test/i/' + body.data.key);
    const exp = Date.parse(body.data.expiresAt) - Date.now();
    assert.ok(Math.abs(exp - 3 * DAY) < 5000);
    const stored = env.IMAGES.store.get(body.data.key);
    assert.equal(stored.httpMetadata.contentType, type);
    assert.ok(!Number.isNaN(Date.parse(stored.customMetadata.uploadedAt)));

    const { default: worker } = await load();
    const got = await worker.fetch(new Request(body.data.url), env);   // 公開，不帶任何憑證
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), type);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(got.headers.get('access-control-allow-origin'), '*');
    const m = /^public, max-age=(\d+)$/.exec(got.headers.get('cache-control'));
    assert.ok(m && Math.abs(Number(m[1]) - 3 * 86400) < 5);
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);

    const h = await worker.fetch(new Request(body.data.url, { method: 'HEAD' }), env);
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('content-length'), String(bytes.length));
  }
});

test('每次上傳的 key 不同；MAX_AGE_DAYS 影響 expiresAt', async () => {
  const env = mkEnv({ MAX_AGE_DAYS: '1' });
  const a = await parse((await upload(JPG, { env })).res);
  const b = await parse((await upload(JPG, { env })).res);
  assert.notEqual(a.data.key, b.data.key);
  assert.ok(Math.abs(Date.parse(a.data.expiresAt) - Date.now() - DAY) < 5000);
});

test('GET /i 壞 key → 404 JSON；不存在 → 404', async () => {
  const env = mkEnv();
  const bad = ['/i/', '/i/abc.jpg', '/i/' + '0'.repeat(32), '/i/' + '0'.repeat(32) + '.gif', '/i/' + 'A'.repeat(32) + '.jpg',
    '/i/' + '0'.repeat(32) + '.jpg/x', '/i/../' + '0'.repeat(32) + '.jpg', '/i/' + '0'.repeat(33) + '.jpg'];
  for (const p of bad.concat('/i/' + '0'.repeat(32) + '.jpg')) {
    const res = await call(p, {}, env);
    assert.equal(res.status, 404, p);
    assert.equal((await parse(res)).code, 'not_found');
  }
});

test('過期物件 → 404 並被刪除', async () => {
  const { env, res } = await upload(JPG);
  const { data } = await parse(res);
  env.IMAGES.store.get(data.key).uploaded = new Date(Date.now() - 3 * DAY - 1000);
  const got = await call('/i/' + data.key, {}, env);
  assert.equal(got.status, 404);
  assert.equal(env.IMAGES.store.has(data.key), false);
});

test('其他路徑與方法 → 404 not_found', async () => {
  for (const [p, m] of [['/', 'GET'], ['/nope', 'POST'], ['/login', 'GET'], ['/upload', 'GET'], ['/i/' + '0'.repeat(32) + '.jpg', 'DELETE']]) {
    const res = await call(p, { method: m });
    assert.equal(res.status, 404, p + m);
    assert.equal((await parse(res)).code, 'not_found');
  }
});

test('CORS：OPTIONS 預檢與 Origin 比對', async () => {
  const pre = await call('/upload', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
  const evil = await call('/upload', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } });
  assert.equal(evil.status, 204);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const env = mkEnv();
  assert.equal((await login(env.APP_PASSWORD, env)).headers.get('access-control-allow-origin'), ORIGIN);
  const e2 = await call('/login', { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{"password":"x"}' }, env);
  assert.equal(e2.headers.get('access-control-allow-origin'), null);
  const e3 = await call('/login', { method: 'POST', headers: { origin: null }, body: '{"password":"x"}' }, env);
  assert.equal(e3.headers.get('access-control-allow-origin'), null);
  const { res } = await upload(JPG, { headers: { origin: 'https://evil.test' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('設定不完整 → 500 misconfigured，不丟例外', async () => {
  const cases = [
    ['/login', { APP_PASSWORD: 'short' }],
    ['/login', { SESSION_SECRET: undefined }], ['/login', { SESSION_SECRET: 's'.repeat(31) }],
    ['/login', { APP_PASSWORD: undefined, SESSION_SECRET: undefined }], ['/login', { APP_PASSWORD: '', SESSION_SECRET: 's'.repeat(31) }]
  ];
  for (const [p, extra] of cases) {
    const env = mkEnv(extra);
    const res = await login('anything', env);
    assert.equal(res.status, 500, JSON.stringify(extra));
    const body = await parse(res);
    assert.deepEqual({ ok: body.ok, code: body.code }, { ok: false, code: 'misconfigured' });
  }
  const noSecret = mkEnv({ SESSION_SECRET: undefined });
  const r1 = await call('/upload', { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: 'Bearer x' }, body: JPG }, noSecret);
  assert.equal(r1.status, 500);
  assert.equal((await parse(r1)).code, 'misconfigured');
  const noBucket = mkEnv({ IMAGES: undefined });
  const r2 = await upload(JPG, { env: noBucket, session: await goodSession(mkEnv()) });
  assert.equal(r2.res.status, 500);
  assert.equal((await parse(r2.res)).code, 'misconfigured');
  const r3 = await call('/i/' + '0'.repeat(32) + '.jpg', {}, noBucket);
  assert.equal(r3.status, 500);
  const { default: worker } = await load();
  const r4 = await worker.fetch(new Request('https://img.test/login', { method: 'POST', body: '{}' }), undefined);
  assert.equal(r4.status, 500);
});

test('回應不含 Secret 值', async () => {
  const env = mkEnv();
  for (const res of [await login(env.APP_PASSWORD, env), await login('wrong', env), (await upload(JPG, { env })).res]) {
    const body = await res.text();
    assert.equal(body.includes(env.APP_PASSWORD) || body.includes(env.SESSION_SECRET), false);
  }
});

/* ---------- 免密碼模式：沒設 APP_PASSWORD 就不檢查密碼，其餘照舊 ---------- */
const getConfig = (env, headers) => call('/config', { headers }, env);

test('GET /config 回報要不要密碼（含 CORS）', async () => {
  const on = await getConfig(mkEnv());
  assert.deepEqual(await parse(on), { ok: true, data: { password: true } });
  assert.equal(on.headers.get('access-control-allow-origin'), ORIGIN);
  for (const APP_PASSWORD of [undefined, '']) {
    assert.deepEqual(await parse(await getConfig(mkEnv({ APP_PASSWORD }))), { ok: true, data: { password: false } });
  }
  const evil = await getConfig(mkEnv(), { origin: 'https://evil.test' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('/config', { method: 'POST', body: '{}' })).status, 404);
});

test('免密碼模式：login 不看密碼（空 body 也行）就簽發，憑證能上傳', async () => {
  const { verifySession } = await load();
  for (const APP_PASSWORD of [undefined, '']) {
    const env = mkEnv({ APP_PASSWORD, FAIL_DELAY_MS: '5000' });
    const t = Date.now();
    const bodies = [await parse(await login('', env)), await parse(await login('anything', env)),
      await parse(await call('/login', { method: 'POST', body: '' }, env))];
    assert.ok(Date.now() - t < 2000, '不套用失敗延遲');
    const now = Math.floor(Date.now() / 1000);
    for (const b of bodies) {
      assert.equal(b.ok, true);
      assert.equal(b.data.ttl, 30 * 86400);
      assert.equal(await verifySession(env.SESSION_SECRET, b.data.session, now), true);
    }
    const { res } = await upload(JPG, { env, session: bodies[0].data.session });
    assert.equal(res.status, 200);
    assert.equal(env.IMAGES.store.size, 1);
  }
});

test('免密碼模式：上傳仍要憑證、仍檢查檔頭與大小，LOGIN_LIMITER 照擋', async () => {
  const env = mkEnv({ APP_PASSWORD: undefined, MAX_BYTES: '10' });
  assert.equal((await upload(JPG, { env, session: null })).res.status, 401);
  assert.equal((await upload(PNG, { env, type: 'image/jpeg' })).res.status, 415);
  assert.equal((await upload(new Uint8Array(11).fill(0xff), { env })).res.status, 413);
  assert.equal(env.IMAGES.store.size, 0);
  const limited = mkEnv({ APP_PASSWORD: undefined, LOGIN_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await parse(await login('', limited))).code, 'rate_limited');
});

test('重新設回 APP_PASSWORD：恢復要密碼', async () => {
  const env = mkEnv();
  assert.equal((await parse(await login('', env))).code, 'unauthorized');
  assert.equal((await parse(await call('/login', { method: 'POST', body: '' }, env))).code, 'bad_request');
  assert.equal((await parse(await login(env.APP_PASSWORD, env))).ok, true);
});

/* ---------- /rundown：網址與金鑰只在 Worker ---------- */
const RD_URL = 'https://script.google.com/macros/s/AKfyTEST_123/exec';
const rdEnv = (extra) => mkEnv(Object.assign({ RUNDOWN_URL: RD_URL, RUNDOWN_TOKEN: 't'.repeat(16) }, extra));
async function rundown(body, { env, session, gas } = {}) {
  env = env || rdEnv();
  session = session === undefined ? await goodSession(env) : session;
  const h = { 'content-type': 'text/plain' };
  if (session !== null) h.authorization = 'Bearer ' + session;
  const seen = [], orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return gas ? gas(url, init) : new Response('{"ok":true,"title":"T","sheets":["2026/10"]}'); };
  try { const res = await call('/rundown', { method: 'POST', headers: h, body: JSON.stringify(body) }, env); return { res, seen }; } finally { globalThis.fetch = orig; }
}
const ENTRY = { page: 'news', date: '2026-10-27', time: '08:07', text: '1234567/圖文/測試圖文' };

test('rundownBody：只放行 ping／格式正確的 add', async () => {
  const { rundownBody } = await load();
  assert.deepEqual(rundownBody({ action: 'ping', token: 'x' }), { action: 'ping' });
  assert.deepEqual(rundownBody({ action: 'add', entries: [Object.assign({ extra: 1 }, ENTRY)] }), { action: 'add', entries: [ENTRY] });
  for (const bad of [null, {}, { action: 'del' }, { action: 'add', entries: [] }, { action: 'add', entries: Array(11).fill(ENTRY) },
    { action: 'add', entries: [Object.assign({}, ENTRY, { page: 'jkk' })] }, { action: 'add', entries: [Object.assign({}, ENTRY, { time: '8:07' })] },
    { action: 'add', entries: [Object.assign({}, ENTRY, { text: 'a\nb' })] }, { action: 'add', entries: [Object.assign({}, ENTRY, { text: 'x'.repeat(101) })] }])
    assert.equal(rundownBody(bad), null);
});

test('rundown 沒有／偽造憑證 → 401，不轉送', async () => {
  for (const session of [null, 'bad.token']) {
    const { res, seen } = await rundown({ action: 'ping' }, { session });
    assert.equal(res.status, 401); assert.equal(seen.length, 0);
  }
});

test('rundown 沒設 RUNDOWN_URL／RUNDOWN_TOKEN → 503；格式錯 → 400', async () => {
  for (const extra of [{ RUNDOWN_URL: '' }, { RUNDOWN_URL: 'https://example.com/exec' }, { RUNDOWN_TOKEN: 'short' }]) {
    const { res, seen } = await rundown({ action: 'ping' }, { env: rdEnv(extra) });
    assert.equal(res.status, 503); assert.equal((await parse(res)).code, 'rundown_off'); assert.equal(seen.length, 0);
  }
  const { res } = await rundown({ action: 'add', entries: [] });
  assert.equal(res.status, 400);
});

test('rundown 轉送：Worker 補上金鑰，回傳 results／ping 資訊，不洩漏金鑰', async () => {
  const env = rdEnv();
  const p = await rundown({ action: 'ping', token: 'from-web' }, { env });
  assert.equal(p.seen[0].url, RD_URL);
  assert.deepEqual(JSON.parse(p.seen[0].init.body), { token: env.RUNDOWN_TOKEN, action: 'ping' });
  const pb = await parse(p.res);
  assert.ok(pb.data.renew, '測試憑證只剩 10 分鐘：回應附續期憑證');
  delete pb.data.renew;
  assert.deepEqual(pb, { ok: true, data: { title: 'T', sheets: ['2026/10'] } });
  const results = [{ ok: true, page: 'news', status: 'write', cell: '2026/10!AB106', time: '08:07' }];
  const a = await rundown({ action: 'add', entries: [ENTRY] }, { env, gas: () => new Response(JSON.stringify({ ok: true, results })) });
  assert.deepEqual(JSON.parse(a.seen[0].init.body), { token: env.RUNDOWN_TOKEN, action: 'add', entries: [ENTRY] });
  const text = await a.res.text();
  const ab = JSON.parse(text); delete ab.data.renew;
  assert.deepEqual(ab, { ok: true, data: { results } });
  assert(!text.includes(env.RUNDOWN_TOKEN) && !text.includes(RD_URL));
});

test('rundown：Apps Script 回非 JSON 或 ok:false → 502', async () => {
  const a = await rundown({ action: 'ping' }, { gas: () => new Response('<html>登入</html>') });
  assert.equal(a.res.status, 502);
  const b = await rundown({ action: 'ping' }, { gas: () => new Response('{"ok":false,"error":"金鑰不對"}') });
  assert.equal(b.res.status, 502); assert.match((await parse(b.res)).error, /金鑰不對/);
  const c = await rundown({ action: 'ping' }, { gas: () => { throw new Error('net'); } });
  assert.equal(c.res.status, 502);
});

test('SESSION_DAYS 改登入天數；不合理的值退回 30 天', async () => {
  const { sessionTtl } = await load();
  assert.equal(sessionTtl({}), 30 * 86400);
  assert.equal(sessionTtl({ SESSION_DAYS: '7' }), 7 * 86400);
  assert.equal(sessionTtl({ SESSION_DAYS: '365' }), 365 * 86400);
  for (const v of ['0', '400', 'abc', '', '-3']) assert.equal(sessionTtl({ SESSION_DAYS: v }), 30 * 86400, v);
  const body = await parse(await login('p'.repeat(20), mkEnv({ SESSION_DAYS: '7' })));
  assert.equal(body.data.ttl, 7 * 86400);
});

test('自動續期：憑證剩不到一半效期，上傳成功就附一張新的；還很新就不附', async () => {
  const { signSession, verifySession } = await load();
  const env = mkEnv();
  const now = Math.floor(Date.now() / 1000);
  // 剩 10 分鐘：續
  let { res } = await upload(JPG, { env, session: await signSession(env.SESSION_SECRET, now + 600) });
  let body = await parse(res);
  assert.equal(res.status, 200);
  assert.ok(body.data.renew, '快到期要續');
  assert.ok(Math.abs(body.data.renew.exp - now - 30 * 86400) <= 2);
  assert.equal(body.data.renew.ttl, 30 * 86400);
  assert.equal(await verifySession(env.SESSION_SECRET, body.data.renew.session, now), true);
  // 剩 20 天（超過一半）：不續
  ({ res } = await upload(JPG, { env, session: await signSession(env.SESSION_SECRET, now + 20 * 86400) }));
  body = await parse(res);
  assert.equal(res.status, 200);
  assert.equal(body.data.renew, undefined);
  // 過期的不能拿來續
  ({ res } = await upload(JPG, { env, session: await signSession(env.SESSION_SECRET, now - 1) }));
  assert.equal(res.status, 401);
  assert.equal((await parse(res)).data, undefined);
});
