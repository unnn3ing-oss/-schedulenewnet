// 「全部送出」兩段式流程與回應解析（純函式，不碰 DOM）：瀏覽器是 window.SendFlow，Node 用 require。
// 規則：docs/newsnet_handoff.md §5（守則判讀）、§6（逐台送、只重送失敗）、§7（錯誤容錯）
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const rules = node ? require('./rules.js') : root.Rules;
  const sched = node ? require('./sched.js') : root.Sched;
  const api = factory(rules, sched);
  if (node) module.exports = api; else root.SendFlow = api;
})(typeof self !== 'undefined' ? self : this, function (Rules, Sched) {
  const isHtml = s => /<(!doctype|html)/i.test(String(s || ''));

  // 回應文字 → 物件：最多解 3 層 JSON（舊版 niceError 的做法）；不是 JSON 回 null
  function parseJson(text) {
    let v = text;
    for (let i = 0; i < 3 && typeof v === 'string'; i++) {
      try { v = JSON.parse(v); } catch (e) { if (!i) return null; break; }
    }
    if (v && typeof v === 'object') return v;
    return typeof v === 'string' ? { message: v } : null;   // JSON 字串包著的錯誤文字
  }

  // 錯誤物件／文字 → 一行人看得懂的訊息（取 detail／message／error；HTML 一律換成通用訊息，免得整頁 HTML 跑進畫面）
  function pickMessage(obj) {
    if (!obj || typeof obj !== 'object') return '';
    for (const k of ['detail', 'message', 'error']) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length) return v.map(x => (x && typeof x === 'object' ? x.msg || x.message || JSON.stringify(x) : String(x))).join('；');
      if (v && typeof v === 'object') { const m = pickMessage(v); if (m) return m; }
    }
    return '';
  }
  function niceError(status, text) {
    if (isHtml(text)) return status ? `後端回傳錯誤頁（HTTP ${status}），請稍後再試` : '後端回傳錯誤頁，請稍後再試';
    const msg = pickMessage(parseJson(text)) || String(text || '').trim();
    const short = msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
    if (status === 401 || status === 403) return '沒有登入網新發文台（' + status + '），請先登入' + (short ? '：' + short : '');
    return (status ? `HTTP ${status}` : '錯誤') + (short ? '：' + short : '');
  }

  // 外掛 Ext.call 的結果 → { ok, status, json, text, image, error }
  function apiResult(r) {
    if (!r || !r.ok) {
      const e = r && r.error;
      return { ok: false, error: e === 'no_extension' ? '外掛沒回應，請確認外掛已安裝並更新到 0.5.0' : e === 'path_not_allowed' ? '外掛版本太舊（不允許這個端點），請更新到 0.5.0' : '外掛回報錯誤：' + e };
    }
    const d = r.data || {};
    const text = d.text != null ? d.text : (d.snippet || '');
    const status = d.status || 0;
    if (status < 200 || status >= 300) return { ok: false, status, text, error: niceError(status, text) };
    if (d.image) return { ok: true, status, image: d.image };
    if (isHtml(text)) return { ok: false, status, text, error: '後端回了網頁（可能被導去登入頁），請先登入網新發文台' };
    const json = parseJson(text);
    if (json && (json.ok === false || (json.error && !json.post_url && !json.post_id))) return { ok: false, status, json, text, error: niceError(status, text).replace(/^HTTP \d+：/, '') };
    return { ok: true, status, json, text };
  }

  // 守則判讀回應（格式未確認：接受常見欄位名，並看一層 data／result）
  const LEVELS = { green: 'green', yellow: 'yellow', red: 'red', '綠': 'green', '黃': 'yellow', '紅': 'red' };
  function parseGuard(res) {
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || '判讀失敗' };
    const obj = res.json;
    if (!obj || typeof obj !== 'object') return { ok: false, error: '判讀回應格式不認得' };
    if (obj.error) return { ok: false, error: '判讀失敗：' + pickMessage(obj) };   // §5.5：含 error 視為過期
    const pools = [obj, obj.data, obj.result].filter(o => o && typeof o === 'object');
    const first = keys => { for (const o of pools) for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };
    const raw = String(first(['level', 'light', 'color']) || '').toLowerCase().replace('燈', '');
    const level = LEVELS[raw];
    if (!level) return { ok: false, error: '判讀回應格式不認得' };
    let reasons = first(['reasons', 'reason', 'issues', 'summary', 'message']);
    reasons = (Array.isArray(reasons) ? reasons : reasons ? [reasons] : [])
      .map(x => (x && typeof x === 'object' ? x.msg || x.message || x.reason || x.text || '' : String(x))).filter(Boolean);
    return { ok: true, level, checkId: String(first(['check_id', 'checkId', 'id']) || ''), reasons };
  }

  // 發布／排程回應：{ message | post_url | post_id }
  function sendOutcome(res) {
    if (!res.ok) return { ok: false, error: res.error };
    const j = res.json || {};
    const link = typeof j.post_url === 'string' && /^https:\/\//.test(j.post_url) ? j.post_url : '';
    return { ok: true, link, postId: j.post_id != null ? String(j.post_id) : '', message: typeof j.message === 'string' ? j.message : '' };
  }

  // ---- 確認泡泡 ----
  const LIGHT = { green: '守則綠燈', yellow: '守則黃燈', red: '守則紅燈' };
  // targets = [{ code, at: Date|null }]；guard = parseGuard 的結果；ack = 是否勾「我知道風險」
  function bubble({ targets, guard, ack, now }) {
    const rows = targets.map(t => {
      const p = Rules.pageByCode(t.code), err = t.at ? Sched.validate(t.at, now) : null;
      return { code: t.code, label: p ? p.label : t.code, short: t.at ? Sched.fmtWhen(t.at, now) : '立即',
        when: t.at ? '排程 ' + Sched.fmtWhen(t.at, now) : '立即發布', error: err ? err.msg : '' };
    });
    const g = guard || { ok: false, error: '尚未判讀' };
    const level = g.ok ? g.level : '';
    const needAck = level === 'red';
    const guardText = g.ok ? LIGHT[level] + (g.reasons && g.reasons.length ? '：' + g.reasons.join('；') : '') : g.error;
    const blockers = [];
    if (!rows.length) blockers.push('請先選粉專');
    rows.filter(r => r.error).forEach(r => blockers.push(`${r.label}：${r.error}`));
    if (!g.ok) blockers.push('守則判讀失敗，再按一次重新判讀');
    else if (needAck && !ack) blockers.push('紅燈要先勾「我知道風險」');
    return { title: `確定送出 ${rows.length} 台？`, rows, level, needAck, guardText, blockers, canConfirm: !blockers.length };
  }

  // ---- 兩段式狀態機 ----
  // idle ─click→ checking ─guard→ armed ─click(可送)→ sending ─sent→ done
  // armed 時：點其他地方或改內容 → idle；判讀中改內容 → idle（結果以 key 比對後丟棄）
  // armed 而判讀失敗：再按一次 → checking（重判）；紅燈沒勾「我知道風險」：按了不動
  // 單台重送（燈號仍有效）：idle／done ─resend→ sending；上傳圖失敗：sending ─abort→ idle
  function next(state, ev) {
    switch (ev.type) {
      case 'click':
        if (state === 'idle' || state === 'done') return 'checking';
        if (state === 'armed') return ev.canConfirm ? 'sending' : (ev.guardFailed ? 'checking' : 'armed');
        return state;                                        // checking／sending 時忽略
      case 'guard': return state === 'checking' ? (ev.stale ? 'idle' : 'armed') : state;
      case 'edit': case 'outside': return state === 'armed' || state === 'checking' ? 'idle' : state;
      case 'resend': return state === 'idle' || state === 'done' ? 'sending' : state;
      case 'sent': return state === 'sending' ? 'done' : state;
      case 'abort': return state === 'sending' ? 'idle' : state;
      default: return state;
    }
  }

  // 各台狀態 → 「2 台成功・1 台失敗」
  function summary(statuses) {
    const ok = statuses.filter(s => s === 'ok').length, bad = statuses.filter(s => s === 'fail').length;
    return [ok ? `${ok} 台成功` : '', bad ? `${bad} 台失敗` : ''].filter(Boolean).join('・');
  }

  return { isHtml, parseJson, niceError, apiResult, parseGuard, sendOutcome, bubble, next, summary };
});
