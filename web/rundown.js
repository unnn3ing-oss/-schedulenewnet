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

  // GAS 回傳的單筆結果 → 給人看的一句
  function describe(r, label) {
    if (!r) return `${label}：沒有回應`;
    if (!r.ok) return `${label}：${r.error || '失敗'}`;
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
  function settings() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return { on: !!(v && v.on) }; } catch (e) { return { on: false }; }
  }
  function save(patch) {
    const v = { on: !!Object.assign(settings(), patch).on };
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
      try { const j = await call({ action: 'ping' }); hint(`連線成功：${j.title || '試算表'}（分頁 ${(j.sheets || []).join('、')}…）`, 'ok'); } catch (x) { hint(x.message, 'bad'); } finally { $('rdTest').disabled = false; }
    });
    $('rdCancel').addEventListener('click', close);
    box().addEventListener('mousedown', e => { if (e.target === box()) close(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  Object.assign(window.Rundown, { settings, save, enabled, add, open, close, isOpen, onChange: fn => listeners.push(fn) });
})();
