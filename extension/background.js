// 點工具列圖示開啟側邊欄；每小時問 GitHub 有沒有新版，有就在圖示顯示「新」（更新要在側邊欄按，見 updater.js）。
importScripts('updater.js');

// 驗證三種送法：
//   b1  外掛背景直接 fetch（帶 cookie）
//   b1o 同 b1，但把 Origin 標頭改成網新網址（防後端檢查來源）
//   b2  交給網新分頁，在原網域內 fetch（一定是同網域）
// 只允許唯讀／判讀／預覽端點，不允許 /schedule、/publish。
const HOST = 'https://digi-social-post.tvbs.ai';
const ALLOWED = [/^\/[\w\-/]*page_meta\?url=/, /^\/[\w\-/]*hero\?url=/, /^\/[\w\-/]*guard\/check$/, /^\/[\w\-/]*render$/];
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
  return { ...base, snippet: (await r.text()).slice(0, SNIPPET) };
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

async function cookieInfo() {
  // 只回報名稱與到期時間，不回傳值。
  const list = await chrome.cookies.getAll({ url: HOST + '/' });
  return list.map(c => ({ name: c.name, sameSite: c.sameSite, httpOnly: c.httpOnly, expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session' }));
}

async function handle(msg) {
  const { op, payload } = msg || {};
  if (op === 'ping') return { ok: true, version: chrome.runtime.getManifest().version };
  if (op === 'cookies') return { ok: true, data: await cookieInfo() };
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
setup();
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'check-update') return;
  try {
    const info = await Updater.checkLatest();
    await chrome.action.setBadgeText({ text: info.hasUpdate ? '新' : '' });
    if (info.hasUpdate) await chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
  } catch (e) { /* 離線或被限流：下次鬧鐘再試 */ }
});
