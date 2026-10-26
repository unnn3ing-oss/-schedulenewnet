// Rundown 自動排入：送出成功後把「文章ID/圖文/SLUG」寫進 FB RUNDOWN 試算表。
// 寫入由 gas/rundown.gs（Google Apps Script 網頁應用程式，以小編自己的帳號執行）處理；網頁只送 { token, action, entries }。
// 純函式（entries、defaultSlug…）Node 可 require 測試；瀏覽器另有設定小視窗與 post()。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Rundown = Object.assign(root.Rundown || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  const PAGES = { news: '主粉', ent: '娛樂粉', shaokang: '少康粉', intl: '國際＋粉' };   // 其他粉專在 Rundown 沒有區段
  const TYPE = '圖文';
  const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  const pad = n => String(n).padStart(2, '0');

  // 沒填 SLUG：標題第一行去空白後前 4 字（「/」會打亂格式，一併拿掉）
  function defaultSlug(lines) {
    const first = (Array.isArray(lines) ? lines : [lines]).find(l => String(l || '').trim()) || '';
    return Array.from(String(first).replace(/[\s/]+/g, '')).slice(0, 4).join('');
  }
  const cleanSlug = s => String(s == null ? '' : s).replace(/[\s/]+/g, '');
  const entryText = (articleId, slug) => `${articleId || ''}/${TYPE}/${slug}`;

  // 'YYYY-MM-DDTHH:mm'（排程）或 Date（立即＝送出當下）→ { date, time }（本機時區）
  function whenOf(at) {
    if (typeof at === 'string') { const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(at); return m ? { date: m[1], time: m[2] } : null; }
    if (at instanceof Date && !isNaN(at)) return { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` };
    return null;
  }

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

  // GAS 回傳的單筆結果 → 給人看的一句
  function describe(r, label) {
    if (!r) return `${label}：沒有回應`;
    if (!r.ok) return `${label}：${r.error || '失敗'}`;
    const cell = String(r.cell || '').replace(/^.*!/, '');
    if (r.status === 'exists') return `${label}：已在 ${cell}（不重複寫）`;
    return `${label} ${r.time || ''} → ${cell}${r.status === 'insert' ? '（插入）' : ''}`;
  }

  return { PAGES, TYPE, URL_RE, defaultSlug, cleanSlug, entryText, whenOf, entries, describe };
});

// ---- 瀏覽器：設定（localStorage）、送出、設定小視窗 ----
(function () {
  if (typeof document === 'undefined') return;
  const R = window.Rundown, KEY = 'snn.rundown.v1', $ = id => document.getElementById(id);
  const listeners = [];
  const DEF = { on: false, url: '', token: '' };
  function settings() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return Object.assign({}, DEF, v && typeof v === 'object' ? v : {}); } catch (e) { return Object.assign({}, DEF); }
  }
  function save(patch) {
    const v = Object.assign(settings(), patch);
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 被停用：這次分頁內照常 */ }
    listeners.forEach(fn => fn(v));
    return v;
  }
  const ready = s => R.URL_RE.test(s.url) && s.token.length >= 12;
  const enabled = () => { const s = settings(); return s.on && ready(s); };

  async function call(s, payload) {
    let r;
    try {
      // text/plain：簡單請求，不用 CORS 預檢；Apps Script 會轉址到 googleusercontent 再回 JSON
      r = await fetch(s.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ token: s.token }, payload)) });
    } catch (e) { throw new Error('連不上 Rundown（Apps Script 網址或存取權限不對）'); }
    const j = await r.json().catch(() => null);
    if (!j) throw new Error(`Rundown 回應看不懂（HTTP ${r.status}），請確認部署時「誰可以存取」選「所有人」`);
    if (!j.ok) throw new Error('Rundown：' + (j.error || '失敗'));
    return j;
  }
  const add = list => call(settings(), { action: 'add', entries: list });

  // ---- 設定小視窗 ----
  const box = () => $('rdDlg');
  function hint(msg, cls) { $('rdHint').textContent = msg || ''; $('rdHint').className = 'hint' + (cls ? ' ' + cls : ''); }
  function form() {
    return { on: $('rdDlgOn').checked, url: $('rdUrl').value.trim(), token: $('rdToken').value.trim() };
  }
  function check(v) {
    if (!R.URL_RE.test(v.url)) return '網址要是 https://script.google.com/macros/s/…/exec';
    if (v.token.length < 12) return '金鑰至少 12 字（與 Apps Script 的 TOKEN 相同）';
    return '';
  }
  function open() {
    const s = settings();
    $('rdDlgOn').checked = s.on; $('rdUrl').value = s.url; $('rdToken').value = s.token;
    hint(''); box().hidden = false;
    setTimeout(() => (s.url ? $('rdDlgOn') : $('rdUrl')).focus(), 0);
  }
  const close = () => { box().hidden = true; };
  const isOpen = () => !!box() && !box().hidden;

  function wire() {
    if (!box()) return;
    $('rdForm').addEventListener('submit', e => {
      e.preventDefault();
      const v = form(), bad = (v.on || v.url || v.token) ? check(v) : '';
      if (bad && v.on) { hint(bad, 'bad'); return; }
      save(v); close();
    });
    $('rdTest').addEventListener('click', async () => {
      const v = form(), bad = check(v);
      if (bad) { hint(bad, 'bad'); return; }
      $('rdTest').disabled = true; hint('測試中…');
      try { const j = await call(v, { action: 'ping' }); hint(`連線成功：${j.title || '試算表'}（分頁 ${(j.sheets || []).join('、')}…）`, 'ok'); } catch (x) { hint(x.message, 'bad'); } finally { $('rdTest').disabled = false; }
    });
    $('rdCancel').addEventListener('click', close);
    box().addEventListener('mousedown', e => { if (e.target === box()) close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  Object.assign(window.Rundown, { settings, save, ready, enabled, add, open, close, isOpen, onChange: fn => listeners.push(fn) });
})();
