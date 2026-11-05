// Rundown 自動排入：送出成功後把「文章ID/圖文/SLUG」寫進 FB RUNDOWN 試算表。
// 寫入由 gas/rundown.gs（Google Apps Script 網頁應用程式，以小編自己的帳號執行）處理；網頁送到圖床 Worker /rundown，Worker 補上金鑰再轉給 Apps Script。
// 純函式（entries、defaultSlug…）Node 可 require 測試；瀏覽器另有設定小視窗與 post()。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Rundown = Object.assign(root.Rundown || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  const PAGES = { news: '主粉（新聞粉）', ent: '娛樂粉', shaokang: '少康粉', intl: '國際＋粉' };   // 粉專 → Rundown A 欄的區段（同 gas RD_SECTIONS）；其他粉專沒有區段
  const TYPE = '圖文';
  const pad = n => String(n).padStart(2, '0');

  // 標題第一行有「/」（半形或全形「／」，例：「快訊/」「最新/」「新/」）就只抓第一個斜線後面的字，前面是標籤不是內容；
  // 斜線後面沒字就照舊。沒填 SLUG 時取去空白後的前 4 字（「/」會打亂格式，其餘的也一併拿掉）
  // 第一行只有「快訊」「最新」「新」這種標籤（後面可帶斜線）時，改抓下一個有字的行
  const TAG_ONLY = /^\s*(?:最新|快訊|新)\s*[\/／]?\s*$/;
  // SLUG 只留文字和數字：空白、標點、符號（「》」「！」「，」「/」「#」…）一律拿掉
  const stripSlug = x => String(x == null ? '' : x).replace(/[\p{P}\p{S}\p{Z}\p{C}]+/gu, '');
  function defaultSlug(lines) {
    const rows = (Array.isArray(lines) ? lines : [lines]).filter(l => String(l || '').trim());
    let first = String(rows.find(l => !TAG_ONLY.test(l)) || rows[0] || '');
    const cut = first.search(/[\/／]/);
    if (cut >= 0 && stripSlug(first.slice(cut + 1))) first = first.slice(cut + 1);
    return Array.from(stripSlug(first)).slice(0, 4).join('');
  }
  const cleanSlug = stripSlug;
  const entryText = (articleId, slug) => `${articleId || ''}/${TYPE}/${slug}`;

  // 'YYYY-MM-DDTHH:mm'（排程）或 Date（立即＝送出當下）→ { date, time }（本機時區）
  function whenOf(at) {
    if (typeof at === 'string') { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(at); return m ? { date: m[1], time: m[2] } : null; }
    if (at instanceof Date && !isNaN(at)) return { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` };
    return null;
  }

  // 有勾選並送成功的粉專各寫一筆到對應區段（擠看看、氣象沒有區段，略過）
  // sent：[{ code, at }]（at＝排程字串或送出時間）→ { entries, skipped:[code] }
  function entries(info, sent) {
    const slug = cleanSlug(info.slug) || defaultSlug(info.lines);
    const text = entryText(info.articleId, slug), out = [], skipped = [];
    sent.forEach(s => {
      const w = whenOf(s.at);
      if (!PAGES[s.code] || !w) { skipped.push(s.code); return; }
      out.push({ page: s.code, date: w.date, time: w.time, text });
    });
    return { entries: out, skipped };
  }

  // Apps Script 的例外可能是英文原文（例：Exception: …）：交給 SendFlow.zhError 加中文說明；中文原樣保留
  const SF = typeof SendFlow !== 'undefined' ? SendFlow : typeof require === 'function' ? require('./sendflow.js') : null;
  const zh = e => (SF ? SF.backendError(e, 'Rundown 試算表發生錯誤') : String(e));
  // GAS 回傳的單筆結果 → 給人看的一句
  function describe(r, label) {
    if (!r) return `${label}：沒有回應`;
    if (!r.ok) return `${label}：${r.error ? zh(r.error) : '失敗'}`;
    const cell = String(r.cell || '').replace(/^.*!/, '');
    if (r.status === 'exists') return `${label}：已在 ${cell}（不重複寫）`;
    return `${label} ${r.time || ''} → ${cell}${r.status === 'insert' ? '（插入）' : ''}${r.addedRow ? '（新增一列）' : ''}`;
  }

  return { PAGES, TYPE, defaultSlug, cleanSlug, entryText, whenOf, entries, describe };
});

// ---- 瀏覽器：開關（localStorage）、經圖床 Worker 轉送、設定小視窗 ----
// Apps Script 網址與金鑰只放在 Worker 的 Secrets（RUNDOWN_URL／RUNDOWN_TOKEN），網頁端只帶圖床登入憑證
(function () {
  if (typeof document === 'undefined') return;
  const KEY = 'snn.rundown.v1', $ = id => document.getElementById(id);
  const listeners = [];
  // 預設開啟：沒存過（第一次用、換瀏覽器、清過資料）就是開；小編自己關掉才會記成關
  let mem = null;   // localStorage 被停用時，這次分頁內照常記住切換
  function settings() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && typeof v.on === 'boolean') return { on: v.on }; } catch (e) { /* 讀不到就看分頁內的 */ }
    return { on: mem ? mem.on : true };
  }
  function save(patch) {
    const v = { on: !!Object.assign(settings(), patch).on };
    mem = v;
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 被停用：這次分頁內照常 */ }
    listeners.forEach(fn => fn(v));
    return v;
  }
  const enabled = () => settings().on;

  // POST 圖床 Worker /rundown；沒登入或憑證失效就跳圖床登入，登入後再送一次
  async function call(payload) {
    const post = s => fetch(ImgHost.BASE + '/rundown', { method: 'POST', headers: { 'Authorization': 'Bearer ' + s.session, 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    let r;
    try {
      r = await post(ImgHost.session() || await ImgHost.prompt(''));
      if (r.status === 401) { ImgHost.logout(); r = await post(await ImgHost.prompt('expired')); }
    } catch (e) {
      throw new Error(e && e.code === 'need_login' ? '沒有登入圖床（Rundown 經由圖床 Worker 轉送）' : '連不上圖床 Worker');
    }
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`Rundown 回應看不懂（HTTP ${r.status}）`);
    if (!j.ok) throw new Error(j.error || 'Rundown 失敗');
    ImgHost.renew(j.data);
    return j.data || {};
  }
  const add = list => call({ action: 'add', entries: list });

  // ---- 設定小視窗 ----
  const box = () => $('rdDlg');
  function hint(msg, cls) { $('rdHint').textContent = msg || ''; $('rdHint').className = 'hint' + (cls ? ' ' + cls : ''); }
  function open() {
    $('rdDlgOn').checked = settings().on;
    hint(''); box().hidden = false;
    setTimeout(() => $('rdDlgOn').focus(), 0);
  }
  const close = () => { box().hidden = true; };
  const isOpen = () => !!box() && !box().hidden;

  function wire() {
    if (!box()) return;
    $('rdForm').addEventListener('submit', e => { e.preventDefault(); save({ on: $('rdDlgOn').checked }); close(); });
    $('rdTest').addEventListener('click', async () => {
      $('rdTest').disabled = true; hint('測試中…');
      try { const j = await call({ action: 'ping' }); hint(`連線成功：${j.title || '試算表'}（分頁 ${(j.sheets || []).join('、')}…）`, 'ok'); } catch (x) { hint(SendFlow.backendError(x, 'Rundown 發生錯誤'), 'bad'); } finally { $('rdTest').disabled = false; }
    });
    $('rdCancel').addEventListener('click', close);
    box().addEventListener('mousedown', e => { if (e.target === box()) close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  Object.assign(window.Rundown, { settings, save, enabled, add, open, close, isOpen, onChange: fn => listeners.push(fn) });
})();
