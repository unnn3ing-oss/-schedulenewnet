/* Cloudflare Worker：暫存圖床（R2），圖片 3 天後自動失效。
 * POST /login  {password}                 → 通過後簽發 12 小時憑證
 * POST /upload（Authorization: Bearer 憑證，內容為圖片原始位元組）→ 存進 R2，回公開網址
 * GET|HEAD /i/<key>                       → 公開讀取（不需登入，網址本身不可猜）
 * 必要 Secrets：APP_PASSWORD（至少 8 字元，建議 12 以上）、SESSION_SECRET（至少 32 字元）
 * 必要綁定：IMAGES（R2 bucket）
 * 選用 Variables：ALLOWED_ORIGIN（預設 https://unnn3ing-oss.github.io）、MAX_AGE_DAYS（預設 3）、MAX_BYTES（預設 8388608）、FAIL_DELAY_MS（登入失敗延遲，預設 1000）
 * 選用綁定：LOGIN_LIMITER（Rate Limiting；登入以 IP、上傳以憑證當 key）
 * /login 失敗回 HTTP 200 {ok:false,code,error}；/upload 失敗用對應的 HTTP 狀態碼；設定不完整回 500 misconfigured。 */

export const SESSION_TTL_SEC = 43200;
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
  not_found: '找不到。'
};

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

export async function verifySession(secret, session, nowSec) {
  if (typeof session !== 'string') return false;
  const parts = session.split('.');
  if (parts.length !== 2) return false;
  const payload = b64urlDecode(parts[0]), sig = b64urlDecode(parts[1]);
  if (!payload || !sig || !payload.length || !sig.length) return false;
  let ok;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, payload); } catch (e) { return false; }
  if (!ok) return false;
  let exp;
  try { exp = JSON.parse(new TextDecoder().decode(payload)).exp; } catch (e) { return false; }
  return typeof exp === 'number' && Number.isFinite(exp) && exp > nowSec;
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
  if (!longEnough(env.APP_PASSWORD, MIN_PASSWORD) || !longEnough(env.SESSION_SECRET)) return misconfigured(request, env);
  if (!(await underLimit(env, request.headers.get('cf-connecting-ip') || 'unknown'))) return fail(request, env, 'rate_limited');
  const body = await readJson(request);
  if (!body || typeof body.password !== 'string') return fail(request, env, 'bad_request');
  if (!(await passwordMatches(body.password, env.APP_PASSWORD))) {
    const ms = env.FAIL_DELAY_MS === undefined ? 1000 : Number(env.FAIL_DELAY_MS);
    if (ms > 0) await sleep(ms);
    return fail(request, env, 'unauthorized');
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  return reply(request, env, { ok: true, data: { session: await signSession(env.SESSION_SECRET, exp), exp, ttl: SESSION_TTL_SEC } });
}

async function handleUpload(request, env) {
  if (!longEnough(env.SESSION_SECRET) || !hasBucket(env)) return misconfigured(request, env);
  const m = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
  const session = m ? m[1] : '';
  if (!(await verifySession(env.SESSION_SECRET, session, Math.floor(Date.now() / 1000)))) return fail(request, env, 'unauthorized', 401);
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
  return reply(request, env, { ok: true, data: { url: new URL(request.url).origin + '/i/' + key, key, expiresAt } });
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
      if (request.method === 'POST' && path === '/upload') return await handleUpload(request, env);
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
