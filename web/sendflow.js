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
  // HTTP 狀態碼 → 中文說明；head 用在「說明：後端原文」，tail 是沒有原文時補的建議
  const STATUS = {
    400: ['後端說請求內容有問題', '，請確認填寫的內容'], 404: ['後端找不到這個功能', '，請回報'],
    408: ['後端等太久沒收到資料', '，請再試一次'], 413: ['送出的內容太大', '，請換小一點的圖片或縮短文字'],
    422: ['後端說資料格式不對', '，請確認填寫的內容'], 429: ['送出太頻繁，後端暫時擋下', '，請等一下再試'],
    500: ['後端發生錯誤', '，請稍後再試'], 502: ['後端暫時連不上', '，請稍後再試'],
    503: ['後端暫時無法服務', '，請稍後再試'], 504: ['後端處理逾時', '，請稍後再試']
  };
  function statusText(status) {
    const [head, tail] = STATUS[status] || (status >= 500 ? ['後端發生錯誤', '，請稍後再試'] : status >= 400 ? ['後端拒絕了這次請求', '，請稍後再試或回報'] : ['後端回應異常', '，請稍後再試']);
    return { head, code: status ? `HTTP ${status}` : '', tail };
  }
  const hasCjk = s => /[\u3000-\u9fff\uff00-\uffef]/.test(String(s || ''));
  function niceError(status, text) {
    if (isHtml(text)) return status ? `後端回傳錯誤頁（HTTP ${status}），請稍後再試` : '後端回傳錯誤頁，請稍後再試';
    const msg = pickMessage(parseJson(text)) || String(text || '').trim();
    const short = msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
    if (status === 401 || status === 403) return '沒有登入網新發文台（' + status + '），請先登入' + (short ? '：' + short : '');
    const t = statusText(status);
    if (!short) return t.head + (t.code ? `（${t.code}）` : '') + t.tail;
    return hasCjk(short) ? (t.code || '錯誤') + '：' + short : `${t.head}（${t.code ? t.code + '；' : ''}原文：${short}）`;   // 後端給的中文原樣保留
  }

  // 外掛連線斷掉的錯誤（Chrome 原文）分兩種：
  //   reloaded＝外掛更新／重新載入後，頁面上還是舊的內容腳本，請求根本沒送出去（重新整理頁面就好）
  //   interrupted＝請求已交給外掛背景，但回應前背景被關掉，結果不明（可能已經發出）
  function extErrorKind(e) {
    const s = String(e || '');
    if (/reading 'sendMessage'|reading 'getManifest'|Extension context invalidated|Receiving end does not exist/i.test(s)) return 'reloaded';
    if (/message channel closed|message port closed/i.test(s)) return 'interrupted';
    return '';
  }
  const EXT_RELOADED = '外掛剛更新或重新載入，這個頁面和外掛斷線了（這次沒有送出），請重新整理頁面（F5；側邊欄請關掉再打開）後再試';
  const EXT_INTERRUPTED = '外掛連線中途斷了，結果不明：請先到粉專確認是否已發出，沒有再重送';
  // 外掛、瀏覽器回的錯誤代碼或英文原文 → 中文（外掛 background.js／bridge.js 的代碼、Chrome／瀏覽器的英文錯誤）
  // 已經是中文的（後端、圖床、Apps Script 給的）原樣回傳；認不得的英文加上 lead 開頭、原文放括號，方便回報除錯
  const CODES = {
    no_extension: '外掛沒回應，請確認外掛已安裝並更新到 0.5.0',
    path_not_allowed: '外掛版本太舊（不允許這個端點），請更新到 0.5.0',
    unknown_op: '外掛版本太舊，不支援這個功能，請更新外掛',
    method_not_allowed: '外掛不允許這種請求方式，請回報',
    unknown_mode: '外掛不認得這個連線方式，請更新外掛',
    empty_response: '外掛沒有回傳結果，請重新整理頁面後再試；一直這樣請更新外掛',
    host_not_allowed: '網址不在允許範圍（只能是 tvbs.com.tw 的 https 網址）',
    not_html: '這個網址不是網頁',
    not_image: '這個網址不是圖片',
    too_big: '檔案太大，超過上限',
    timeout: '等太久沒有回應（逾時），請稍後再試',
    need_login: '沒有登入圖床，請先登入',
    network: '網路連線失敗，請確認網路後再試',
    bad_image: '讀不到這張圖片',
    no_image: '還沒有放照片',
    export_failed: '圖片輸出失敗，請再試一次',
    quota: '瀏覽器儲存空間不足'
  };
  // 瀏覽器錯誤（DOMException 名稱或常見英文訊息）
  const PATTERNS = [
    [/NotAllowedError|permission denied|not allowed by the user agent|denied permission/i, '瀏覽器不允許這個動作（權限被拒絕），請允許後再試'],
    [/AbortError|aborted/i, '動作被中斷或逾時，請再試一次'],
    [/TimeoutError|timed? ?out/i, '等太久沒有回應（逾時），請稍後再試'],
    [/Failed to fetch|NetworkError|Load failed|network error|ERR_[A-Z_]+/i, '網路連線失敗，請確認網路後再試'],
    [/QuotaExceededError|quota/i, '瀏覽器或磁碟空間不足'],
    [/SecurityError|insecure|tainted/i, '瀏覽器的安全限制不允許這個動作'],
    [/NotFoundError|could not be found/i, '找不到指定的檔案或資料夾（可能被移走或改名）'],
    [/NoModificationAllowedError|InvalidModificationError/i, '檔案無法寫入（可能是唯讀或被其他程式占用）'],
    [/InvalidStateError/i, '檔案或資料夾的狀態已改變，請重試'],
    [/EncodingError|decode|Image load/i, '讀不到這張圖片（格式不支援或檔案損毀）'],
    [/Unexpected token|JSON/i, '回應格式看不懂']
  ];
  function zhError(e, lead) {
    if (e == null || e === '') return '發生未知錯誤';
    const name = e && typeof e === 'object' && typeof e.name === 'string' && e.name !== 'Error' ? e.name : '';
    const s = String(e && typeof e === 'object' && 'message' in e ? e.message || name : e).trim();
    if (!s) return name ? zhError(name, lead) : '發生未知錯誤';
    const legacy = /^外掛回報錯誤：(.+)$/s.exec(s);   // 舊版存進紀錄的「外掛回報錯誤：英文原文」
    if (legacy) return zhError(legacy[1], lead);
    if (hasCjk(s)) return s;
    const k = extErrorKind(s);
    if (k) return k === 'reloaded' ? EXT_RELOADED : EXT_INTERRUPTED;
    if (Object.prototype.hasOwnProperty.call(CODES, s)) return CODES[s];
    const h = /^http_(\d+)$/.exec(s);
    if (h) return h[1] === '404' ? '網址找不到（HTTP 404）' : `網站回應錯誤（HTTP ${h[1]}）`;
    const full = name ? name + ': ' + s : s;
    for (const [re, zh] of PATTERNS) if (re.test(full)) return zh;
    return `${lead || '外掛發生未知錯誤'}（原文：${full.length > 160 ? full.slice(0, 160) + '…' : full}）`;
  }
  // 後端／Apps Script 自己回的錯誤文字：不套瀏覽器的判斷（免得 quota、permission 被講成瀏覽器的問題）；
  // 中文原樣、已知代碼翻譯，其他加 lead 開頭並附原文
  function backendError(e, lead) {
    const s = String(e && typeof e === 'object' && 'message' in e ? e.message : e == null ? '' : e).trim();
    if (!s) return lead || '後端回報錯誤';
    if (hasCjk(s)) return s;
    if (Object.prototype.hasOwnProperty.call(CODES, s)) return CODES[s];
    return `${lead || '後端回報錯誤'}（原文：${s.length > 160 ? s.slice(0, 160) + '…' : s}）`;
  }
  // 外掛回的錯誤 → 給人看的一句
  const extError = e => zhError(e, '外掛發生未知錯誤');

  // 外掛 Ext.call 的結果 → { ok, status, json, text, image, error }
  function apiResult(r) {
    if (!r || !r.ok) return { ok: false, error: extError(r && r.error) };
    const d = r.data || {};
    const text = d.text != null ? d.text : (d.snippet || '');
    const status = d.status || 0;
    if (status < 200 || status >= 300) return { ok: false, status, text, error: niceError(status, text) };
    if (d.image) return { ok: true, status, image: d.image };
    if (isHtml(text)) return { ok: false, status, text, error: '後端回了網頁（可能被導去登入頁），請先登入網新發文台' };
    const json = parseJson(text);
    if (json && (json.ok === false || (json.error && !json.post_url && !json.post_id))) return { ok: false, status, json, text, error: backendError(pickMessage(json) || '後端回報失敗', '後端回報錯誤') };
    return { ok: true, status, json, text };
  }

  // 守則判讀回應（格式未確認：接受常見欄位名，並看一層 data／result）
  const LEVELS = { green: 'green', yellow: 'yellow', red: 'red', '綠': 'green', '黃': 'yellow', '紅': 'red' };
  function parseGuard(res) {
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || '判讀失敗' };
    const obj = res.json;
    if (!obj || typeof obj !== 'object') return { ok: false, error: '判讀回應格式不認得' };
    if (obj.error) return { ok: false, error: '判讀失敗：' + backendError(pickMessage(obj), '後端回報錯誤') };   // §5.5：含 error 視為過期
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

  return { isHtml, parseJson, niceError, extErrorKind, extError, zhError, backendError, apiResult, parseGuard, sendOutcome, bubble, next, summary };
});
