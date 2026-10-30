// 暫存圖床（worker/index.js）客戶端＋登入小視窗。網頁直接 fetch Worker（CORS），不經外掛。
// GET /config → { ok, data:{ password } }；password:false＝免密碼模式（Worker 沒設 APP_PASSWORD），自動登入、不跳視窗
//   查不到（網路錯、舊版 Worker 沒有 /config）就照要密碼處理
// POST /login {password} → { ok, data:{ session, exp, ttl } }（失敗也是 HTTP 200 {ok:false,code,error}）；預設 30 天有效
// /upload、/rundown 成功時若附 data.renew（剩不到一半效期），就換成新憑證：常用的人不用再登入
// POST /upload（Authorization: Bearer 憑證，body＝圖片位元組）→ { ok, data:{ url, key, expiresAt } }；憑證失效回 401
// Worker 的 ALLOWED_ORIGIN 要等於本頁的 origin（GitHub Pages：https://unnn3ing-oss.github.io），否則瀏覽器會擋 CORS。
(function () {
  const BASE = 'https://snn-images.19jpz-3.workers.dev';
  const KEY = 'snn.imghost.v1';
  const MARGIN_SEC = 120;               // 快到期（2 分鐘內）就當作過期，免得上傳到一半失效
  const $ = id => document.getElementById(id);
  const listeners = [];
  const emit = () => listeners.forEach(fn => fn(session()));
  const err = (code, msg) => Object.assign(new Error(msg || code), { code });

  // ---- 憑證（只存憑證與到期時間；不存密碼）----
  function read() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && typeof v.session === 'string' && typeof v.exp === 'number' ? v : null; } catch (e) { return null; }
  }
  function session() { const s = read(); return s && s.exp * 1000 > Date.now() + MARGIN_SEC * 1000 ? s : null; }
  function write(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* 被停用：本次分頁內仍可用 */ } emit(); }
  const logout = () => write(null);

  const NET = '連不上圖床（網路問題，或 Worker 的 ALLOWED_ORIGIN 不是本頁網址）';

  // ---- 免密碼模式 ----
  let free = false, cfg = null;       // free：Worker 確認不用密碼；cfg：查詢中的 Promise（失敗就清掉，下次再查）
  function checkConfig() {
    if (!cfg) {
      cfg = fetch(BASE + '/config', typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : {})
        .then(r => r.json())
        .then(j => { const f = !!(j && j.ok && j.data && j.data.password === false); if (f !== free) { free = f; emit(); } return free; })
        .catch(() => { cfg = null; return free; });
    }
    return cfg;
  }
  const passwordFree = () => free;
  // 免密碼就直接拿憑證；要密碼回 null。Worker 改回要密碼（unauthorized）就切回密碼模式
  async function autoLogin() {
    if (!(await checkConfig())) return null;
    try { return await login(''); } catch (e) {
      if (e.code === 'unauthorized' || e.code === 'bad_request') { free = false; cfg = null; emit(); return null; }
      throw e;
    }
  }
  async function login(password) {
    let r;
    try {
      // text/plain：簡單請求，不需要 CORS 預檢（Worker 自己解析 JSON）
      r = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ password: String(password || '') }) });
    } catch (e) { throw err('network', NET); }
    const j = await r.json().catch(() => null);
    if (!j || !j.ok || !j.data || typeof j.data.session !== 'string') throw err((j && j.code) || 'http_' + r.status, (j && j.error) || `圖床登入失敗（HTTP ${r.status}）`);
    write({ session: j.data.session, exp: Number(j.data.exp) || Math.floor(Date.now() / 1000) + 43200 });
    return session();
  }
  // Worker 續發的新憑證：格式對、而且比手上的晚到期才換
  function renew(d) {
    const n = d && d.renew, cur = read();
    if (n && typeof n.session === 'string' && n.session && Number.isFinite(Number(n.exp)) && (!cur || Number(n.exp) > cur.exp)) write({ session: n.session, exp: Number(n.exp) });
  }

  // 不跳視窗；免密碼模式下沒憑證或憑證失效會自己再拿一張
  async function upload(blob) {
    const post = async s => {
      try {
        return await fetch(BASE + '/upload', { method: 'POST', headers: { 'Authorization': 'Bearer ' + s.session, 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
      } catch (e) { throw err('network', NET); }
    };
    const s = session() || await autoLogin();
    if (!s) throw err('need_login');
    let r = await post(s);
    if (r.status === 401) {
      logout();
      const again = await autoLogin();
      if (!again) throw err('need_login');
      r = await post(again);
      if (r.status === 401) { logout(); throw err('need_login'); }
    }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok || !j.data || !/^https:\/\//.test(j.data.url || '')) throw err((j && j.code) || 'http_' + r.status, (j && j.error) || `圖床上傳失敗（HTTP ${r.status}）`);
    renew(j.data);
    return j.data;
  }

  // ---- 登入小視窗 ----
  let waiting = [];
  const box = () => $('imgLogin');
  function hint(msg, cls) { $('ilHint').textContent = msg || ''; $('ilHint').className = 'hint' + (cls ? ' ' + cls : ''); }
  function refreshBox() {
    const s = session();
    const h = s ? (s.exp * 1000 - Date.now()) / 3600000 : 0;
    $('ilState').textContent = s ? `已登入，約剩 ${h >= 48 ? Math.round(h / 24) + ' 天' : Math.max(1, Math.round(h)) + ' 小時'}（常用會自動延長）。` : '上傳圖片給後端抓取用，登入一次 30 天有效，常用會自動延長。';
    $('ilLogout').hidden = !s;
  }
  // 開視窗；回傳 Promise：登入成功 resolve、取消 reject(need_login)。免密碼模式直接登入、不開視窗
  async function prompt(reason) {
    const s = await autoLogin();
    if (s) return s;
    const p = new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    if (box().hidden) {
      box().hidden = false;
      $('ilPass').value = '';
      refreshBox();
      hint(reason === 'expired' ? '圖床登入已過期，請重新登入' : '', reason === 'expired' ? 'bad' : '');
      setTimeout(() => $('ilPass').focus(), 0);
    }
    return p;
  }
  function finish(ok) {
    box().hidden = true;
    const w = waiting; waiting = [];
    w.forEach(x => (ok ? x.resolve(session()) : x.reject(err('need_login', '沒有登入圖床'))));
  }
  const isOpen = () => !box().hidden;
  const cancel = () => finish(false);

  // 上傳；沒登入或憑證失效就跳登入視窗，登入後自動再傳一次
  async function ensureUpload(blob) {
    if (!session()) await prompt(read() ? 'expired' : '');
    try { return await upload(blob); } catch (e) {
      if (e.code !== 'need_login') throw e;
      await prompt('expired');
      return upload(blob);
    }
  }

  function wire() {
    $('ilForm').addEventListener('submit', async e => {
      e.preventDefault();
      const pw = $('ilPass').value;
      if (!pw) { hint('請輸入圖床密碼', 'bad'); return; }
      $('ilGo').disabled = true; hint('登入中…');
      try { await login(pw); $('ilPass').value = ''; hint(''); finish(true); } catch (x) { hint(x.message, 'bad'); $('ilPass').select(); } finally { $('ilGo').disabled = false; }
    });
    $('ilCancel').addEventListener('click', cancel);
    $('ilLogout').addEventListener('click', () => { logout(); refreshBox(); hint('已登出'); });
    box().addEventListener('mousedown', e => { if (e.target === box()) cancel(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
  checkConfig();

  window.ImgHost = { BASE, session, login, logout, renew, upload, ensureUpload, prompt, cancel, isOpen, passwordFree, checkConfig, onChange: fn => listeners.push(fn) };
})();
