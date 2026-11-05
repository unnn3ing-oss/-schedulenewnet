// 點工具列圖示開啟側邊欄；每小時（以及 Chrome 啟動、外掛安裝或重新載入時）問 GitHub 有沒有新版，有就在圖示顯示「新」（更新要在側邊欄按，見 updater.js）。
importScripts('updater.js');

// 驗證三種送法：
//   b1  外掛背景直接 fetch（帶 cookie）
//   b1o 同 b1，但把 Origin 標頭改成網新網址（防後端檢查來源）
//   b2  交給網新分頁，在原網域內 fetch（一定是同網域）
// 白名單（docs/newsnet_handoff.md §3）：唯讀／判讀／預覽端點，加上正式介面要用的 AI 小編文、排程與立即發布。
// 新增的端點要求名稱前是「/」，免得 /unpublish 之類的路徑也被放行。
const HOST = 'https://digi-social-post.tvbs.ai';
const endpoint = name => new RegExp('^/(?:[\\w-]+/)*' + name + '$');
const ALLOWED = [/^\/[\w\-/]*page_meta\?url=/, /^\/[\w\-/]*hero\?url=/, /^\/[\w\-/]*guard\/check$/, /^\/[\w\-/]*render$/,
  endpoint('render_text_card'), endpoint('ai_caption'), endpoint('schedule'), endpoint('publish')];
const ORIGIN_RULE = 1;
const SNIPPET = 600;

function allowed(path) { return typeof path === 'string' && ALLOWED.some(re => re.test(path)); }

async function setOriginRule(on) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ORIGIN_RULE],
    addRules: on ? [{
      id: ORIGIN_RULE, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'set', value: HOST }] },
      condition: { urlFilter: '|' + HOST + '/', tabIds: [chrome.tabs.TAB_ID_NONE] }
    }] : []
  });
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

async function doFetch(url, method, body) {
  const init = { method, credentials: 'include', headers: {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(url, init);
  const contentType = r.headers.get('content-type') || '';
  const base = { status: r.status, contentType, redirected: r.redirected, finalUrl: r.url };
  if (/^image\//i.test(contentType)) return { ...base, snippet: '', image: await toDataUrl(await r.blob()) };
  const text = await r.text();
  // snippet 給驗證頁顯示；text 給正式介面解析 JSON（上限 200 KB）
  return { ...base, snippet: text.slice(0, SNIPPET), text: text.slice(0, 200000) };
}

async function viaTab(url, method, body) {
  let [tab] = await chrome.tabs.query({ url: HOST + '/ip/newsnet/*' });
  let opened = false;
  if (!tab) { tab = await chrome.tabs.create({ url: HOST + '/ip/newsnet/', active: false }); opened = true; }
  if (tab.status !== 'complete') {
    await new Promise(resolve => {
      const done = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 20000);
    });
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'MAIN', args: [url, method, body === undefined ? null : body, SNIPPET],
    func: async (u, m, b, n) => {
      const init = { method: m, credentials: 'same-origin', headers: {} };
      if (b !== null) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(b); }
      const r = await fetch(u, init);
      const t = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type') || '', redirected: r.redirected, finalUrl: r.url, snippet: t.slice(0, n), pageUrl: location.href };
    }
  });
  return { ...res.result, tabOpened: opened };
}

// 抓文章主圖：只允許 tvbs.com.tw 的 https 圖片（與上面的 ALLOWED 後端白名單無關、互不影響），不帶 cookie
const IMG_MAX_BYTES = 10 * 1024 * 1024;
function imageHostOk(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && (x.hostname === 'tvbs.com.tw' || x.hostname.endsWith('.tvbs.com.tw'));
  } catch (e) { return false; }
}
async function fetchImage(url) {
  if (!imageHostOk(url)) return { ok: false, error: 'host_not_allowed' };
  const r = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!imageHostOk(r.url)) return { ok: false, error: 'host_not_allowed' };
  if (!r.ok) return { ok: false, error: 'http_' + r.status };
  const type = r.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) return { ok: false, error: 'not_image' };
  const len = Number(r.headers.get('content-length') || 0);
  if (len > IMG_MAX_BYTES) return { ok: false, error: 'too_big' };
  const blob = await r.blob();
  if (blob.size > IMG_MAX_BYTES) return { ok: false, error: 'too_big' };
  return { ok: true, data: { image: await toDataUrl(blob), contentType: type, bytes: blob.size } };
}

// 抓文章網頁（給網頁解析圖說與 hashtag）：同樣只允許 tvbs.com.tw 的 https 網址、不帶 cookie；轉址後的最終網址也要在允許範圍。
// 只回 HTML 原文與最終網址，不呼叫任何後端端點。上限 5 MB、15 秒（整個下載過程）。
const ARTICLE_MAX_BYTES = 5 * 1024 * 1024, ARTICLE_TIMEOUT = 15000;
async function fetchArticle(url) {
  if (!imageHostOk(url)) return { ok: false, error: 'host_not_allowed' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ARTICLE_TIMEOUT);
  try {
    const r = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal });
    if (!imageHostOk(r.url)) return { ok: false, error: 'host_not_allowed' };
    if (!r.ok) return { ok: false, error: 'http_' + r.status };
    const type = r.headers.get('content-type') || '';
    if (!/^text\/html/i.test(type)) return { ok: false, error: 'not_html' };
    if (Number(r.headers.get('content-length') || 0) > ARTICLE_MAX_BYTES) { ctrl.abort(); return { ok: false, error: 'too_big' }; }
    const reader = r.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > ARTICLE_MAX_BYTES) { ctrl.abort(); return { ok: false, error: 'too_big' }; }
      chunks.push(value);
    }
    const charset = (/charset=([\w-]+)/i.exec(type) || [])[1] || 'utf-8';
    let dec;
    try { dec = new TextDecoder(charset); } catch (e) { dec = new TextDecoder('utf-8'); }
    return { ok: true, data: { html: dec.decode(await new Blob(chunks).arrayBuffer()), url: r.url } };
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'timeout' : String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

async function cookieInfo() {
  // 只回報名稱與到期時間，不回傳值。
  const list = await chrome.cookies.getAll({ url: HOST + '/' });
  return list.map(c => ({ name: c.name, sameSite: c.sameSite, httpOnly: c.httpOnly, expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session' }));
}

async function handle(msg) {
  const { op, payload } = msg || {};
  if (op === 'ping') return { ok: true, version: chrome.runtime.getManifest().version };
  if (op === 'cookies') return { ok: true, data: await cookieInfo() };
  if (op === 'fetchImage') {
    try { return await fetchImage(String((payload || {}).url || '')); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  if (op === 'fetchArticle') {
    try { return await fetchArticle(String((payload || {}).url || '')); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  if (op !== 'call') return { ok: false, error: 'unknown_op' };
  const { mode, path, method = 'GET', body } = payload || {};
  if (!allowed(path)) return { ok: false, error: 'path_not_allowed' };
  if (!['GET', 'POST'].includes(method)) return { ok: false, error: 'method_not_allowed' };
  const url = HOST + path;
  try {
    if (mode === 'b1') return { ok: true, data: await doFetch(url, method, body) };
    if (mode === 'b1o') {
      await setOriginRule(true);
      try { return { ok: true, data: await doFetch(url, method, body) }; } finally { await setOriginRule(false); }
    }
    if (mode === 'b2') return { ok: true, data: await viaTab(url, method, body) };
    return { ok: false, error: 'unknown_mode' };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只接受自己的內容腳本（GitHub Pages／localhost 頁面）
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(sendResponse);
  return true;
});

// ---- 側邊欄與自動檢查更新 ----
const CHECK_EVERY_MINUTES = 60;
function ensureCheckAlarm() {
  chrome.alarms.get('check-update', alarm => {
    if (!alarm || alarm.periodInMinutes !== CHECK_EVERY_MINUTES) {
      chrome.alarms.create('check-update', { delayInMinutes: 1, periodInMinutes: CHECK_EVERY_MINUTES });
    }
  });
}
function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureCheckAlarm();
}
// 檢查一次並更新圖示上的「新」。Chrome 啟動、安裝／重新載入外掛時也會馬上查，
// 但距離上次檢查不到 5 分鐘就跳過，免得常開關 Chrome 或重新載入時一直問 GitHub。
const MIN_GAP_MS = 5 * 60 * 1000;
const CHECKED_KEY = 'snn-update-checked-at';
async function checkNow() {
  try {
    const last = (await chrome.storage.local.get(CHECKED_KEY))[CHECKED_KEY] || 0;
    if (Date.now() - last < MIN_GAP_MS) return;
    await chrome.storage.local.set({ [CHECKED_KEY]: Date.now() });
  } catch (e) { /* 存不了就照樣查 */ }
  try {
    const info = await Updater.checkLatest();
    await chrome.action.setBadgeText({ text: info.hasUpdate ? '新' : '' });
    if (info.hasUpdate) await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  } catch (e) { /* 離線或被限流：下次鬧鐘再試 */ }
}
setup();
chrome.runtime.onInstalled.addListener(() => { setup(); checkNow(); });
chrome.runtime.onStartup.addListener(() => { setup(); checkNow(); });

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'check-update') return checkNow();
});
