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

test('login 成功：回 session 與約 12 小時後的 exp', async () => {
  const { verifySession } = await load();
  const env = mkEnv();
  const res = await login(env.APP_PASSWORD, env);
  const body = await parse(res);
  assert.equal(body.ok, true);
  assert.equal(body.data.ttl, 43200);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Math.abs(body.data.exp - now - 43200) <= 1);
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
    ['/login', { APP_PASSWORD: undefined }], ['/login', { APP_PASSWORD: 'short' }],
    ['/login', { SESSION_SECRET: undefined }], ['/login', { SESSION_SECRET: 's'.repeat(31) }]
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
