/* Cloudflare Worker：暫存圖床（R2），圖片 3 天後自動失效。
 * POST /login  {password}                 → 通過後簽發憑證，預設 30 天有效（免密碼模式：不看密碼直接簽發）
 *   自動續期：/upload、/rundown 成功時，憑證剩不到一半效期就在回應 data.renew 附一張新的，常用的人不用再登入
 * GET /config                             → { ok, data:{ password:true|false } }，網頁靠這個決定要不要跳密碼視窗
 * POST /upload（Authorization: Bearer 憑證，內容為圖片原始位元組）→ 存進 R2，回公開網址
 * GET|HEAD /i/<key>                       → 公開讀取（不需登入，網址本身不可猜）
 * POST /rundown（Authorization: Bearer 憑證，{action:'ping'|'add', entries}）→ 轉送給 FB RUNDOWN 的 Apps Script（gas/rundown.gs）
 *   網址與金鑰只放在 Worker：RUNDOWN_URL（Apps Script 網頁應用程式 /exec 網址）、RUNDOWN_TOKEN（同 Apps Script 的 TOKEN，至少 12 字）
 * 必要 Secrets：APP_PASSWORD（至少 8 字元，建議 12 以上）、SESSION_SECRET（至少 32 字元）
 *   免密碼模式：刪掉 APP_PASSWORD（或設成空字串）→ /login 不檢查密碼；重新設回 APP_PASSWORD 就恢復要密碼。
 *   其餘檢查不變：仍要 SESSION_SECRET 簽憑證、上傳仍要 Bearer 憑證、檔頭／大小／ALLOWED_ORIGIN 照舊。
 * 必要綁定：IMAGES（R2 bucket）
 * 選用 Variables：ALLOWED_ORIGIN（預設 https://unnn3ing-oss.github.io）、SESSION_DAYS（登入有效天數，預設 30，1～365）、MAX_AGE_DAYS（預設 3）、MAX_BYTES（預設 8388608）、FAIL_DELAY_MS（登入失敗延遲，預設 1000）
 * 選用綁定：LOGIN_LIMITER（Rate Limiting；登入以 IP、上傳以憑證當 key）
 * /login 失敗回 HTTP 200 {ok:false,code,error}；/upload 失敗用對應的 HTTP 狀態碼；設定不完整回 500 misconfigured。 */

export const SESSION_TTL_SEC = 30 * 86400;
// 登入有效秒數：SESSION_DAYS（1～365 天）沒設或不合理就用預設 30 天
export function sessionTtl(env) {
  const d = Number(env && env.SESSION_DAYS);
  return env && env.SESSION_DAYS !== undefined && env.SESSION_DAYS !== '' && Number.isFinite(d) && d >= 1 && d <= 365 ? Math.floor(d * 86400) : SESSION_TTL_SEC;
}
const MAX_BODY = 65536;
const MIN_SECRET = 32;
const MIN_PASSWORD = 8;
const DEFAULT_ORIGIN = 'https://unnn3ing-oss.github.io';
const DEFAULT_MAX_AGE_DAYS = 3;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const KEY_RE = /^[0-9a-f]{32}\.(jpg|png|webp)$/;
const enc = new TextEncoder();

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const MESSAGES = {
  unauthorized: '密碼不正確或登入已過期。',
  rate_limited: '操作太頻繁，請稍後再試。',
  bad_request: '要求格式不正確。',
  misconfigured: 'Worker 尚未設定完成。',
  too_large: '圖片太大。',
  unsupported: '只接受 JPEG、PNG、WebP 圖片，且內容必須與類型相符。',
  not_found: '找不到。',
  rundown_off: 'Worker 尚未設定 RUNDOWN_URL／RUNDOWN_TOKEN。',
  rundown_failed: '連不上 Rundown 的 Apps Script。'
};
const RUNDOWN_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
const RUNDOWN_PAGES = ['news', 'ent', 'shaokang', 'intl'];

/* ---------- 憑證（與 hottopic 相同） ---------- */
function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) return null;
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch (e) { return null; }
}
function hmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function signSession(secret, exp) {
  const payload = enc.encode(JSON.stringify({ exp }));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), payload);
  return b64urlEncode(payload) + '.' + b64urlEncode(new Uint8Array(sig));
}

// 憑證有效就回到期時間（秒），無效回 0
export async function sessionExp(secret, session, nowSec) {
  if (typeof session !== 'string') return 0;
  const parts = session.split('.');
  if (parts.length !== 2) return 0;
  const payload = b64urlDecode(parts[0]), sig = b64urlDecode(parts[1]);
  if (!payload || !sig || !payload.length || !sig.length) return 0;
  let ok;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, payload); } catch (e) { return 0; }
  if (!ok) return 0;
  let exp;
  try { exp = JSON.parse(new TextDecoder().decode(payload)).exp; } catch (e) { return 0; }
  return typeof exp === 'number' && Number.isFinite(exp) && exp > nowSec ? exp : 0;
}
export async function verifySession(secret, session, nowSec) { return (await sessionExp(secret, session, nowSec)) > 0; }

// 簽一張新憑證（登入、續期共用）
async function issue(env) {
  const ttl = sessionTtl(env), exp = Math.floor(Date.now() / 1000) + ttl;
  return { session: await signSession(env.SESSION_SECRET, exp), exp, ttl };
}
// 剩不到一半效期就續一張；舊的到期前仍有效（網頁收到新的就換掉）
async function renewal(env, exp) {
  return exp - Math.floor(Date.now() / 1000) < sessionTtl(env) / 2 ? issue(env) : null;
}
// 驗 Bearer 憑證：有效回 { session, exp }，無效回 null
async function bearer(request, env) {
  const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
  const session = m ? m[1] : '';
  const exp = await sessionExp(env.SESSION_SECRET, session, Math.floor(Date.now() / 1000));
  return exp ? { session, exp } : null;
}

/* 定時比對密碼：以隨機金鑰對輸入做 HMAC，再用 verify（定時比較）檢查，長度不同也不洩漏 */
async function passwordMatches(input, expected) {
  const k = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const mac = await crypto.subtle.sign('HMAC', k, enc.encode(input));
  return crypto.subtle.verify('HMAC', k, mac, enc.encode(expected));
}

/* ---------- 設定與回應 ---------- */
const allowedOrigin = (env) => env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
const longEnough = (v, min = MIN_SECRET) => typeof v === 'string' && v.length >= min;
const passwordOff = (env) => env.APP_PASSWORD === undefined || env.APP_PASSWORD === null || env.APP_PASSWORD === '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function posInt(v, dflt) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : dflt;
}
const maxAgeMs = (env) => posInt(env.MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS) * 86400000;
const maxBytes = (env) => Math.floor(posInt(env.MAX_BYTES, DEFAULT_MAX_BYTES));
const hasBucket = (env) => !!env.IMAGES && typeof env.IMAGES.put === 'function' && typeof env.IMAGES.get === 'function';

function corsHeaders(request, env) {
  const h = { 'Vary': 'Origin' };
  const origin = request.headers.get('origin');
  if (origin && origin === allowedOrigin(env)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function reply(request, env, body, status) {
  const headers = Object.assign({ 'Content-Type': 'application/json;charset=utf-8' }, corsHeaders(request, env));
  return new Response(JSON.stringify(body), { status: status || 200, headers });
}
const fail = (request, env, code, status, error) =>
  reply(request, env, { ok: false, code, error: error || MESSAGES[code] || MESSAGES.bad_request }, status);
const misconfigured = (request, env) => fail(request, env, 'misconfigured', 500);

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY || enc.encode(raw).length > MAX_BODY) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return null; }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

/* 以檔頭位元組判斷真實圖片類型（不信任 Content-Type） */
export function sniffType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

async function underLimit(env, key) {
  if (!env.LOGIN_LIMITER || typeof env.LOGIN_LIMITER.limit !== 'function') return true;
  const r = await env.LOGIN_LIMITER.limit({ key });
  return !!(r && r.success);
}

/* ---------- 端點 ---------- */
async function handleLogin(request, env) {
  const open = passwordOff(env);   // 免密碼模式：不看 body，直接簽發（仍受 LOGIN_LIMITER 限制）
  if ((!open && !longEnough(env.APP_PASSWORD, MIN_PASSWORD)) || !longEnough(env.SESSION_SECRET)) return misconfigured(request, env);
  if (!(await underLimit(env, request.headers.get('cf-connecting-ip') || 'unknown'))) return fail(request, env, 'rate_limited');
  const body = open ? null : await readJson(request);
  if (!open && (!body || typeof body.password !== 'string')) return fail(request, env, 'bad_request');
  if (!open && !(await passwordMatches(body.password, env.APP_PASSWORD))) {
    const ms = env.FAIL_DELAY_MS === undefined ? 1000 : Number(env.FAIL_DELAY_MS);
    if (ms > 0) await sleep(ms);
    return fail(request, env, 'unauthorized');
  }
  return reply(request, env, { ok: true, data: await issue(env) });
}

async function handleUpload(request, env) {
  if (!longEnough(env.SESSION_SECRET) || !hasBucket(env)) return misconfigured(request, env);
  const auth = await bearer(request, env);
  if (!auth) return fail(request, env, 'unauthorized', 401);
  const session = auth.session;
  if (!(await underLimit(env, session))) return fail(request, env, 'rate_limited', 429);

  const limit = maxBytes(env);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return fail(request, env, 'too_large', 413);
  const claimed = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES[claimed]) return fail(request, env, 'unsupported', 415);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > limit) return fail(request, env, 'too_large', 413);
  if (!bytes.length) return fail(request, env, 'bad_request', 400);
  if (sniffType(bytes) !== claimed) return fail(request, env, 'unsupported', 415);

  const rnd = crypto.getRandomValues(new Uint8Array(16));
  const key = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('') + '.' + TYPES[claimed];
  const now = new Date();
  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType: claimed },
    customMetadata: { uploadedAt: now.toISOString() }
  });
  const expiresAt = new Date(now.getTime() + maxAgeMs(env)).toISOString();
  const renew = await renewal(env, auth.exp);
  return reply(request, env, { ok: true, data: Object.assign({ url: new URL(request.url).origin + '/i/' + key, key, expiresAt }, renew ? { renew } : {}) });
}

/* 只轉送格式正確的排入資料；Apps Script 那邊再驗 TOKEN、找格子 */
export function rundownBody(body) {
  if (!body || (body.action !== 'ping' && body.action !== 'add')) return null;
  if (body.action === 'ping') return { action: 'ping' };
  const list = body.entries;
  if (!Array.isArray(list) || !list.length || list.length > 10) return null;
  const entries = [];
  for (const e of list) {
    if (!e || !RUNDOWN_PAGES.includes(e.page) || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !/^\d{2}:\d{2}$/.test(e.time)) return null;
    if (typeof e.text !== 'string' || !e.text.trim() || e.text.length > 100 || /[\r\n]/.test(e.text)) return null;
    entries.push({ page: e.page, date: e.date, time: e.time, text: e.text });
  }
  return { action: 'add', entries };
}

async function handleRundown(request, env) {
  if (!longEnough(env.SESSION_SECRET)) return misconfigured(request, env);
  const auth = await bearer(request, env);
  if (!auth) return fail(request, env, 'unauthorized', 401);
  const session = auth.session;
  if (!RUNDOWN_URL_RE.test(env.RUNDOWN_URL || '') || !longEnough(env.RUNDOWN_TOKEN, 12)) return fail(request, env, 'rundown_off', 503);
  if (!(await underLimit(env, session))) return fail(request, env, 'rate_limited', 429);
  const body = rundownBody(await readJson(request));
  if (!body) return fail(request, env, 'bad_request', 400);
  let j;
  try {
    // Apps Script 會 302 到 googleusercontent 再回 JSON
    const r = await fetch(env.RUNDOWN_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: env.RUNDOWN_TOKEN }, body)) });
    j = await r.json().catch(() => null);
  } catch (e) { j = null; }
  if (!j || typeof j !== 'object') return fail(request, env, 'rundown_failed', 502, 'Rundown 的 Apps Script 沒有回 JSON（確認部署的「誰可以存取」是「所有人」）。');
  if (!j.ok) return fail(request, env, 'rundown_failed', 502, 'Rundown：' + String(j.error || '失敗').slice(0, 200));
  const renew = await renewal(env, auth.exp);
  return reply(request, env, { ok: true, data: Object.assign(j.results ? { results: j.results } : { title: j.title, sheets: j.sheets }, renew ? { renew } : {}) });
}

async function handleImage(request, env, key) {
  if (!hasBucket(env)) return misconfigured(request, env);
  const head = request.method === 'HEAD';
  const obj = head ? await env.IMAGES.head(key) : await env.IMAGES.get(key);
  if (!obj) return fail(request, env, 'not_found', 404);
  const uploaded = obj.uploaded instanceof Date ? obj.uploaded.getTime() : Date.parse(obj.customMetadata && obj.customMetadata.uploadedAt);
  const remaining = (uploaded + maxAgeMs(env) - Date.now()) / 1000;
  if (!Number.isFinite(uploaded) || remaining <= 0) {
    await env.IMAGES.delete(key);   // 到期（R2 生命週期規則的備援）
    return fail(request, env, 'not_found', 404);
  }
  const headers = {
    'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
    'Cache-Control': 'public, max-age=' + Math.floor(remaining),
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*'
  };
  if (typeof obj.size === 'number') headers['Content-Length'] = String(obj.size);
  return new Response(head ? null : obj.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    try {
      env = env || {};
      const path = new URL(request.url).pathname;
      if (request.method === 'OPTIONS') {
        const h = Object.assign({
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '600'
        }, corsHeaders(request, env));
        return new Response(null, { status: 204, headers: h });
      }
      if (request.method === 'POST' && path === '/login') return await handleLogin(request, env);
      if (request.method === 'GET' && path === '/config') return reply(request, env, { ok: true, data: { password: !passwordOff(env) } });
      if (request.method === 'POST' && path === '/upload') return await handleUpload(request, env);
      if (request.method === 'POST' && path === '/rundown') return await handleRundown(request, env);
      if ((request.method === 'GET' || request.method === 'HEAD') && path.startsWith('/i/')) {
        const key = path.slice(3);
        if (KEY_RE.test(key)) return await handleImage(request, env, key);
      }
      return fail(request, env, 'not_found', 404);
    } catch (e) {
      return fail(request, env, 'server_error', 500, '伺服器發生錯誤。');
    }
  }
};
