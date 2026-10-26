// 本機送出紀錄（localStorage `snn.records.v1`）：每次「全部送出」存一筆，重送時更新同一筆。後端沒有列表端點，紀錄只存在這台瀏覽器。
// 瀏覽器是 window.Records，Node 用 require（可傳入假的 storage 測試）。
// 紀錄格式（PR B 舊紀錄缺的欄位一律當空值處理，不需要轉換）：
//   { id, at, updatedAt, mode:'single'|'text_card', frame:'news'|'ent', title, lines[], caption, url, articleId, cardStyle,
//     thumb:'data:image/jpeg…', imgExp, guard:{ checkId, level, reasons[] },
//     render:{ path:'/render'|'/render_text_card', body }（送出當下的後端出圖請求，給「複製圖片」重新產圖；只存網址與文字，不存圖）,
//     pages:[{ code, label, kind:'now'|'sched', schedule:'YYYY-MM-DDTHH:mm', status:'ok'|'fail', link, postId, error, sentAt, path, body }] }
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const sched = node ? require('./sched.js') : root.Sched;
  const api = factory(sched);
  if (node) module.exports = api; else root.Records = api;
})(typeof self !== 'undefined' ? self : this, function (Sched) {
  const KEY = 'snn.records.v1';
  const MAX = 200;                 // 最多留 200 筆，舊的丟掉
  const PAGE_SIZE = 20;            // 列表每頁 20 筆
  const THUMB_DAYS = 7;            // 縮圖只留 7 天
  const THUMB_KEEP = 60;           // 最多 60 筆帶縮圖（最新的）
  const THUMB_CHARS = 28000;       // 縮圖 dataURL 上限（約 20 KB）
  const IMG_DAYS = Sched.MAX_DAYS; // 圖床的圖 3 天後失效
  const DAY = 864e5;
  const pad = n => String(n).padStart(2, '0');
  const time = v => { const t = Date.parse(v || ''); return isNaN(t) ? 0 : t; };

  // 'YYYY-MM-DDTHH:mm'（本機時區）→ Date；不合法回 null
  function parseSchedule(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return isNaN(d) ? null : d;
  }
  const fmtMD = d => `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;   // 排程 MM/DD HH:mm

  // ---- 顯示用（相容舊紀錄）----
  // 標題：第一行粗體、其餘淡色。新紀錄有 lines；PR B 舊紀錄只有 title（作圖框以空白接起、純文字含 \n）
  function titleParts(rec) {
    const lines = Array.isArray(rec.lines) && rec.lines.length ? rec.lines.map(String) : String(rec.title || '').split('\n');
    const clean = lines.map(s => s.trim()).filter(Boolean);
    return { first: clean[0] || '（無標題）', rest: clean.slice(1).join(' ') };
  }
  const modeLabel = rec => (rec.mode === 'text_card' ? '純文字底圖' : '作圖框');
  const frameLabel = rec => (rec.mode === 'text_card' ? '' : rec.frame === 'ent' ? '粉框' : rec.frame === 'news' ? '藍框' : '');

  // 單台狀態：published 已發布｜scheduled 排程中｜due 排程時間已過（推測已發布，無法確認）｜failed 失敗｜unknown
  function pageState(p, now) {
    if (!p) return 'unknown';
    if (p.status === 'fail') return 'failed';
    if (p.status !== 'ok') return 'unknown';
    if (p.kind !== 'sched') return 'published';
    const at = parseSchedule(p.schedule);
    return at && at.getTime() <= now.getTime() ? 'due' : 'scheduled';
  }

  // ---- 分頁籤：全部／已排程／已發布（含推測已發布）／失敗 ----
  const TABS = ['all', 'sched', 'pub', 'fail'];
  function matches(rec, tab, now) {
    if (tab === 'all' || !TABS.includes(tab)) return true;
    const st = (rec.pages || []).map(p => pageState(p, now));
    if (tab === 'sched') return st.includes('scheduled');
    if (tab === 'pub') return st.includes('published') || st.includes('due');
    return st.includes('failed');
  }
  const filter = (list, tab, now) => list.filter(r => matches(r, tab, now));
  const counts = (list, now) => Object.fromEntries(TABS.map(t => [t, filter(list, t, now).length]));

  // 分頁（沿用 hottopic web/paging.js 的寫法）
  const pageCount = (total, size) => Math.max(1, Math.ceil(total / (size || PAGE_SIZE)));
  function clampPage(page, pages) { const n = Math.trunc(Number(page)); return isFinite(n) ? Math.min(Math.max(n, 1), pages) : 1; }
  const slicePage = (list, page, size) => list.slice((page - 1) * (size || PAGE_SIZE), page * (size || PAGE_SIZE));
  // 頁碼列：第 1 頁、最後一頁、目前頁±1；不連續處放 '…'；7 頁以內全列
  function pageWindow(page, pages) {
    const out = [];
    if (pages <= 7) { for (let i = 1; i <= pages; i++) out.push(i); return out; }
    const keep = [...new Set([1, pages, page - 1, page, page + 1].filter(n => n >= 1 && n <= pages))].sort((a, b) => a - b);
    keep.forEach((n, k) => { if (k && n - keep[k - 1] > 1) out.push('…'); out.push(n); });
    return out;
  }

  // ---- 從列表重送 ----
  // 圖床的圖什麼時候失效：有存 imgExp 用它，否則以送出時間＋3 天估
  function imageExpiry(rec) {
    const e = time(rec.imgExp) || (time(rec.at) ? time(rec.at) + IMG_DAYS * DAY : 0);
    return e ? new Date(e) : null;
  }
  // 能不能重送這一台：{ ok:false, reason } 或 { ok:true, kind, at, needTime, needGuard }
  function resendCheck(rec, code, now) {
    const p = rec && (rec.pages || []).find(x => x.code === code);
    if (!p) return { ok: false, reason: '找不到這一台的紀錄' };
    if (p.status !== 'fail') return { ok: false, reason: '只有失敗的台可以重送' };
    if (!p.body || typeof p.body !== 'object') return { ok: false, reason: '舊版紀錄沒有存送出內容，無法重送；請用「複製到新增發文」重做' };
    if (p.body.image_url) {
      const exp = imageExpiry(rec);
      if (!exp || exp.getTime() <= Sched.earliest(now).getTime()) return { ok: false, reason: `圖床的圖已失效（${IMG_DAYS} 天），無法重送；請用「複製到新增發文」重做` };
    }
    const kind = p.kind === 'sched' || p.body.schedule ? 'sched' : 'now';
    const at = kind === 'sched' ? parseSchedule(p.body.schedule || p.schedule) : null;
    const needTime = kind === 'sched' && (!at || !!validateAt(rec, at, now));
    const g = rec.guard;
    return { ok: true, kind, at, needTime, needGuard: !(g && g.level) };
  }
  // 重送的排程時間：照 Sched.validate（現在＋20 分～3 天），作圖框另外不能晚於圖床的圖失效
  function validateAt(rec, at, now) {
    const err = Sched.validate(at, now);
    if (err) return err;
    const p = (rec.pages || []).find(x => x.body && x.body.image_url);
    const exp = p ? imageExpiry(rec) : null;
    if (exp && at.getTime() > exp.getTime()) return { code: 'img_expire', msg: `圖床的圖 ${Sched.fmtWhen(exp, now)} 失效，排程要早於這個時間` };
    return null;
  }
  // 重送用的請求：存的 body 原樣，只換排程時間與守則（紅燈要重新勾「我知道風險」）
  function resendRequest(page, opts) {
    const body = JSON.parse(JSON.stringify(page.body));
    if (opts.at) body.schedule = Sched.toScheduleString(opts.at);
    const g = opts.guard || {};
    body.guard = { check_id: String(g.checkId || ''), level: g.level || '', ack: g.level === 'red' ? !!opts.ack : false };
    return { path: body.schedule ? '/schedule' : '/publish', body };
  }
  // 守則判讀 body（從存的送出內容還原，§5）
  function guardBodyOf(page) {
    const b = page.body || {};
    return { ip: b.ip, title_lines: b.mode === 'text_card' ? [] : (b.title_lines || []), caption: String(b.caption || ''), text: b.mode === 'text_card' ? String(b.text || '') : '' };
  }

  // ---- 「複製到新增發文」：標題、小編文、網址、版型、模式（不含圖）----
  function copyInput(rec) {
    const card = rec.mode === 'text_card';
    let lines = Array.isArray(rec.lines) && rec.lines.length ? rec.lines.map(String) : null;
    if (!lines) {
      const b = ((rec.pages || []).find(p => p.body) || {}).body;
      lines = b && Array.isArray(b.title_lines) && b.title_lines.length ? b.title_lines.slice() : String(card && b && b.text ? b.text : rec.title || '').split('\n');
    }
    const body = ((rec.pages || []).find(p => p.body) || {}).body || {};
    return { mode: card ? 'text' : 'frame', frame: rec.frame === 'ent' ? 'ent' : 'news', lines: lines.map(s => s.trim()).filter(Boolean),
      caption: String(rec.caption != null ? rec.caption : body.caption || ''), url: String(rec.url || ''), cardStyle: rec.cardStyle || '', slug: String(rec.slug || '') };
  }

  // ---- 「複製標題」「複製圖片」----
  // 標題文字：分行以 \n 接起（純文字底圖就是卡面文字），與「複製到新增發文」帶入的標題相同
  const titleText = rec => copyInput(rec).lines.join('\n');
  // 純文字底圖 /render_text_card 的欄位（同 Payload.previewRequest）
  const CARD_KEYS = ['ip', 'text', 'bg', 'text_color', 'width', 'height', 'wordmark', 'font', 'shadow', 'line_gap', 'center_on_canvas'];
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
  // 重新向後端要成品圖的請求：新紀錄存了送出當下的 render（＝Payload.previewRequest）；
  // 舊紀錄從存的送出內容（失敗的台才留 body）還原。/render 的 body 一律只有 { image_url, lines, layout, crop }。沒資料回 null
  function renderRequest(rec) {
    const r = rec && rec.render;
    if (r && r.body && typeof r.body === 'object') {
      if (r.path === '/render' && r.body.image_url) return { path: '/render', body: { image_url: String(r.body.image_url), lines: (r.body.lines || []).map(String), layout: String(r.body.layout || ''), crop: null } };
      if (r.path === '/render_text_card' && r.body.text) return { path: '/render_text_card', body: pick(r.body, CARD_KEYS) };
    }
    const b = ((rec && rec.pages) || []).map(p => p && p.body).find(x => x && typeof x === 'object');
    if (!b) return null;
    if (b.mode === 'text_card') return b.text ? { path: '/render_text_card', body: pick(b, CARD_KEYS) } : null;
    if (!b.image_url) return null;
    return { path: '/render', body: { image_url: String(b.image_url), lines: (b.title_lines || []).map(String),
      layout: String(b.template || (rec.frame === 'ent' ? 'newsnet_ent' : 'newsnet_news')), crop: null } };   // 同 Rules.frameTemplate
  }
  // 能不能複製圖片：{ ok:true, request } 或 { ok:false, reason }。作圖框的圖在圖床，過期就產不出來
  function copyImageCheck(rec, now) {
    const request = renderRequest(rec);
    if (!request) return { ok: false, reason: '舊版紀錄沒有存出圖資料，無法複製圖片；請用「複製到新增發文」重做' };
    if (request.path === '/render') {
      const exp = imageExpiry(rec);
      if (!exp || exp.getTime() <= now.getTime()) return { ok: false, reason: `圖片已過期（圖床只保留 ${IMG_DAYS} 天）` };
    }
    return { ok: true, request };
  }
  // 下載用檔名：newsnet-<文章編號>.png；沒有文章編號用送出日期時間
  function imageFileName(rec) {
    const id = String(rec.articleId || '').replace(/[^\w-]/g, '');
    if (id) return `newsnet-${id}.png`;
    const d = new Date(time(rec.at) || Date.now());
    return `newsnet-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
  }

  // ---- 儲存衛生 ----
  // 新的在前、最多 MAX 筆；縮圖只留 7 天內且最新 THUMB_KEEP 筆；成功的台不會再重送，拿掉 body
  function prune(all, now) {
    const t = now.getTime();
    return all.slice().sort((a, b) => time(b.at) - time(a.at)).slice(0, MAX).map((r, i) => {
      const keepThumb = r.thumb && i < THUMB_KEEP && t - time(r.at) <= THUMB_DAYS * DAY;
      const out = Object.assign({}, r);
      if (!keepThumb) delete out.thumb;
      if (Array.isArray(r.pages)) out.pages = r.pages.map(p => { if (p && p.status === 'ok' && p.body) { const q = Object.assign({}, p); delete q.body; return q; } return p; });
      return out;
    });
  }
  const okThumb = s => typeof s === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= THUMB_CHARS;

  function create(storage, clock) {
    const store = storage;
    const nowFn = clock || (() => new Date());
    const listeners = [];
    let lastError = '';
    function list() {
      try {
        const v = JSON.parse(store.getItem(KEY) || '[]');
        return Array.isArray(v) ? v.filter(r => r && typeof r === 'object' && r.id).sort((a, b) => time(b.at) - time(a.at)) : [];
      } catch (e) { return []; }
    }
    // 寫入；空間不夠（QuotaExceeded）就先丟掉全部縮圖，再從舊的砍半，直到寫得進去。回 true／false，不擋送出
    function save(all) {
      let data = prune(all, nowFn());
      lastError = '';
      for (let step = 0; step < 12; step++) {
        try { store.setItem(KEY, JSON.stringify(data)); listeners.forEach(fn => fn()); return true; } catch (e) {
          lastError = 'quota';
          if (data.some(r => r.thumb)) data = data.map(r => { const o = Object.assign({}, r); delete o.thumb; return o; });
          else if (data.length > 1) data = data.slice(0, Math.ceil(data.length / 2));
          else return false;
        }
      }
      return false;
    }
    const get = id => list().find(r => r.id === id) || null;
    function add(rec) {
      const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const item = Object.assign({ id, at: nowFn().toISOString() }, rec);
      if (!okThumb(item.thumb)) delete item.thumb;
      save([item].concat(list()));
      return id;
    }
    // 更新整筆（不換 id、不換位置）
    function update(id, patch) {
      const all = list(), rec = all.find(r => r.id === id);
      if (!rec) return false;
      Object.assign(rec, patch, { updatedAt: nowFn().toISOString() });
      if ('thumb' in patch && !okThumb(rec.thumb)) delete rec.thumb;
      return save(all);
    }
    // 更新某一台的結果（送出、重送）：同一筆紀錄、同一台原地更新
    function updatePage(id, code, patch) {
      const all = list(), rec = all.find(r => r.id === id);
      if (!rec) return false;
      const p = (rec.pages || []).find(x => x.code === code);
      if (p) Object.assign(p, patch); else (rec.pages = rec.pages || []).push(Object.assign({ code }, patch));
      rec.updatedAt = nowFn().toISOString();
      return save(all);
    }
    function remove(id) {
      const all = list(), rest = all.filter(r => r.id !== id);
      return rest.length !== all.length && save(rest);
    }
    return { list, get, add, update, updatePage, remove, error: () => lastError, onChange: fn => listeners.push(fn),
      clear: () => { try { store.removeItem(KEY); } catch (e) { /* 無妨 */ } listeners.forEach(fn => fn()); } };
  }

  const api = { KEY, MAX, PAGE_SIZE, THUMB_DAYS, THUMB_KEEP, THUMB_CHARS, TABS, create, parseSchedule, fmtMD, titleParts, modeLabel, frameLabel,
    pageState, matches, filter, counts, pageCount, clampPage, slicePage, pageWindow, imageExpiry, resendCheck, validateAt, resendRequest,
    guardBodyOf, copyInput, titleText, renderRequest, copyImageCheck, imageFileName, prune, okThumb };
  if (typeof window !== 'undefined') {
    let ls = null;
    try { ls = window.localStorage; } catch (e) { /* 隱私模式等被停用 */ }
    if (ls) Object.assign(api, create(ls));
    else Object.assign(api, { list: () => [], get: () => null, add: () => '', update: () => false, updatePage: () => false, remove: () => false, error: () => 'disabled', onChange() {}, clear() {} });
  }
  return api;
});
