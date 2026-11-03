// 一鍵檢測：網路、外掛、網新登入、圖床 Worker、Rundown 是否正常。每項同時跑、各自有逾時，跑完一項就更新畫面。
// 純邏輯（run／checks）不碰 DOM，相依都由 deps 注入，Node 可 require 測試；瀏覽器另有設定彈窗裡的面板，
// 以及給外掛側邊欄用的 postMessage（側邊欄問嵌入的網頁版，網頁版跑完回傳結果，見 extension/sphealth.js）。
// 不顯示任何 cookie 值、憑證或密碼；不呼叫 /schedule、/publish 等會改資料的端點；不跳圖床登入視窗、不改圖床憑證。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Health = Object.assign(root.Health || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  const TIMEOUT = 8000;
  // 後台登入的實際檢查：GET /page_meta（外掛白名單內、唯讀，只讀網頁標題），只在按按鈕時跑
  const PROBE_URL = 'https://news.tvbs.com.tw/';
  const ICON = { ok: '✅', warn: '⚠️', bad: '❌', skip: '➖', wait: '⏳' };
  const ITEMS = [
    ['net', '網路連線'], ['ext', '外掛'], ['conn', '頁面與外掛連線'], ['extUpdate', '外掛版本'],
    ['login', '網新發文台登入'], ['backend', '網新後台回應'], ['imgWorker', '圖床 Worker'], ['imgLogin', '圖床登入'], ['rundown', 'Rundown 連線']
  ];
  const DEEP_ONLY = '按「🩺 一鍵檢測」才會實際連線測試';

  const row = (status, text, hint) => ({ status, text, hint: status === 'ok' || status === 'skip' ? '' : (hint || '') });
  const ok = (t) => row('ok', t), warn = (t, h) => row('warn', t, h), bad = (t, h) => row('bad', t, h), skip = (t) => row('skip', t);
  const errMsg = e => String((e && e.message) || e || '');
  function cmpVer(a, b) {
    const x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  }
  const daysLeft = (ms, now) => Math.floor((ms - now) / 86400000);
  function fmtLeft(ms, now) {
    const h = (ms - now) / 3600000;
    return h >= 48 ? `約剩 ${Math.round(h / 24)} 天` : `約剩 ${Math.max(1, Math.round(h))} 小時`;
  }

  // 網新登入 cookie（只看名稱與到期時間）→ 一列結果。外掛側邊欄也用同樣的判斷（extension/sphealth.js 有一份）
  function loginRow(list, now) {
    const q = Array.isArray(list) ? list.find(x => x && x.name === 'queen_session') : null;
    const HINT = '在新分頁開啟網新發文台（digi-social-post.tvbs.ai/ip/newsnet/）登入後，再檢測一次';
    if (!q) return bad('尚未登入（找不到登入 cookie）', HINT);
    if (!q.expires || q.expires === 'session') return ok('已登入（關閉瀏覽器後失效）');
    const exp = Date.parse(q.expires);
    if (!Number.isFinite(exp)) return ok('已登入');
    const d = daysLeft(exp, now);
    if (exp <= now) return bad('登入已過期', HINT);
    if (d < 3) return warn(`已登入，但約 ${Math.max(0, d)} 天後到期`, '快到期了，有空時重新登入網新發文台');
    return ok(`已登入，約 ${d} 天後到期`);
  }

  // 每項檢查：(ctx) → Promise<row>。ctx 是 deps 加上共用的 ping()／config()（只呼叫一次）
  const checks = {
    async net(c) {
      if (c.online && !c.online()) return bad('瀏覽器顯示目前離線', '檢查 Wi-Fi 或網路線，連上後再檢測');
      try {
        const r = await c.fetch(c.selfUrl, { cache: 'no-store' });
        return r.ok ? ok('已連線') : warn(`網頁伺服器回應異常（HTTP ${r.status}）`, '稍後再試；持續發生請通知管理者');
      } catch (e) { return bad('連不到網頁伺服器', '檢查網路連線（公司網路可能擋住），連上後再檢測'); }
    },
    async ext(c) {
      const p = await c.ping();
      if (p.ok) return ok(`已安裝並有回應（v${p.version || '?'}）`);
      if (p.error === 'no_extension') return bad('未偵測到外掛', c.mobile ? '手機不能裝 Chrome 外掛，請用電腦版 Chrome' : '到「設定」按「🧩 安裝插件」照步驟安裝；裝好後重新整理頁面');
      if (c.extErrorKind(p.error) === 'reloaded') return warn('外掛有裝，但這個頁面和外掛斷線了', '請重新整理頁面（F5；側邊欄請關掉再打開）');
      return bad('外掛回報錯誤：' + p.error, '重新整理頁面；還是不行就到 chrome://extensions 重新載入外掛');
    },
    async conn(c) {
      const p = await c.ping();
      if (p.ok) return ok('正常');
      if (p.error === 'no_extension') return skip('需要先安裝外掛');
      if (c.extErrorKind(p.error) === 'reloaded') return bad('外掛剛更新，請重新整理頁面', '按 F5 重新整理（側邊欄請關掉再打開），之後就能正常送出');
      if (c.extErrorKind(p.error) === 'interrupted') return bad('外掛連線中途斷了', '重新整理頁面後再檢測');
      return bad('連線異常：' + p.error, '重新整理頁面；還是不行就到 chrome://extensions 重新載入外掛');
    },
    async extUpdate(c) {
      const p = await c.ping();
      if (!p.ok) return skip('需要外掛有回應');
      let latest;
      try { latest = await c.latestExtVersion(); } catch (e) { return warn('查不到 GitHub 上的最新版本', '可能是網路問題或 GitHub 暫時限流，稍後再試'); }
      if (!latest) return warn('查不到 GitHub 上的最新版本', '稍後再試');
      const d = cmpVer(p.version, latest);
      if (d < 0) return warn(`有新版 v${latest}（目前 v${p.version}）`, '打開外掛側邊欄「狀態與更新」，按「更新到最新版」');
      return ok(d > 0 ? `v${p.version}（比 GitHub 上的 v${latest} 新）` : `已是最新 v${p.version}`);
    },
    async login(c) {
      const p = await c.ping();
      if (!p.ok) return skip('需要外掛有回應');
      const r = await c.cookies();
      if (!r || !r.ok) return warn('讀不到登入狀態', '重新整理頁面後再檢測');
      return loginRow(r.data, c.now());
    },
    async backend(c) {
      if (!c.deep) return skip(DEEP_ONLY);
      const p = await c.ping();
      if (!p.ok) return skip('需要外掛有回應');
      const r = await c.call('/page_meta?url=' + encodeURIComponent(PROBE_URL));
      if (!r || !r.ok) return bad('外掛沒有把請求送到後台', '重新整理頁面後再檢測');
      const d = r.data || {}, st = d.status || 0, text = String(d.text != null ? d.text : d.snippet || '');
      if (st === 401 || st === 403) return bad(`後台說沒有登入（HTTP ${st}）`, '在新分頁登入網新發文台後再檢測');
      if (st >= 200 && st < 300 && /<(!doctype|html)/i.test(text)) return bad('後台回了網頁（可能被導去登入頁）', '在新分頁登入網新發文台後再檢測');
      if (st >= 500 || !st) return warn(`後台暫時有問題（HTTP ${st || '?'}）`, '稍後再試；持續發生請通知管理者');
      return ok(`後台有回應（HTTP ${st}）`);
    },
    async imgWorker(c) {
      const r = await c.config();
      if (r.error) return bad('連不上圖床 Worker', '確認網路；網路正常的話，可能是 Worker 的 ALLOWED_ORIGIN 不是本頁網址');
      if (r.status === 404) return warn('圖床 Worker 是舊版（沒有 /config）', 'Worker 是舊版，請重新部署 worker/index.js');
      if (!r.json || !r.json.ok) return bad(`圖床 Worker 回應異常（HTTP ${r.status}）`, '稍後再試；持續發生請重新部署 worker/index.js');
      return ok(r.json.data && r.json.data.password === false ? '可連線（免密碼模式）' : '可連線（需要密碼）');
    },
    async imgLogin(c) {
      const s = c.imgSession(), now = c.now();
      if (s) return s.exp * 1000 - now < 86400000 ? warn(`已登入，${fmtLeft(s.exp * 1000, now)}`, '快到期了；上傳圖片時會自動延長，或點右上角圖床狀態重新登入') : ok(`已登入，${fmtLeft(s.exp * 1000, now)}`);
      const r = await c.config();
      if (r.json && r.json.ok && r.json.data && r.json.data.password === false) return ok('免密碼模式，上傳時自動登入');
      return warn('圖床未登入', '點右上角「圖床」狀態輸入密碼（上傳圖片、後端預覽與 Rundown 都需要）');
    },
    async rundown(c) {
      if (!c.rundownEnabled()) return skip('沒有開啟 Rundown 自動排入');
      if (!c.deep) return skip(DEEP_ONLY);
      const s = c.imgSession();
      if (!s) return warn('需要先登入圖床（Rundown 經由圖床 Worker 轉送）', '點右上角「圖床」狀態登入後再檢測');
      let r;
      try {
        r = await c.fetch(c.imgBase + '/rundown', { method: 'POST', headers: { 'Authorization': 'Bearer ' + s.session, 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ping' }) });
      } catch (e) { return bad('連不上圖床 Worker', '確認網路後再檢測'); }
      if (r.status === 401) return warn('圖床登入已過期', '點右上角「圖床」狀態重新登入後再檢測');
      const j = await r.json().catch(() => null);
      if (r.status === 404) return bad('圖床 Worker 沒有 /rundown', 'Worker 是舊版，請重新部署 worker/index.js');
      if (!j) return bad(`Rundown 回應看不懂（HTTP ${r.status}）`, '稍後再試；持續發生請通知管理者');
      if (!j.ok) return bad('Rundown 失敗：' + (j.error || '原因不明'), '檢查 Worker 的 RUNDOWN_URL／RUNDOWN_TOKEN，以及 Apps Script 是否已部署');
      return ok(`連線成功：${(j.data && j.data.title) || '試算表'}`);
    }
  };

  const once = fn => { let p = null; return () => (p || (p = Promise.resolve().then(fn))); };
  function withTimeout(promise, ms) {
    let t;
    const timer = new Promise(resolve => { t = setTimeout(() => resolve(bad(`逾時（${Math.round(ms / 1000)} 秒沒有回應）`, '網路可能很慢或服務沒有回應，稍後再檢測')), ms); });
    return Promise.race([promise, timer]).finally(() => clearTimeout(t));
  }

  // deps：{ fetch, selfUrl, online(), ping(), cookies(), call(path), extErrorKind(e), latestExtVersion(), imgBase, imgSession(), rundownEnabled(), now(), mobile }
  // opts：{ deep：是否做較花資源的檢查（後台、Rundown），timeout：每項逾時毫秒，only：只跑這些項目，onRow(id, row, rows) }
  // 回傳 [{ id, label, status, text, hint }]（順序固定）
  async function run(deps, opts) {
    const o = Object.assign({ deep: false, timeout: TIMEOUT }, opts);
    const c = Object.assign({ now: () => Date.now(), extErrorKind: () => '', online: () => true }, deps, { deep: !!o.deep });
    c.ping = once(async () => { try { return (await deps.ping()) || { ok: false, error: 'empty_response' }; } catch (e) { return { ok: false, error: errMsg(e) }; } });
    c.config = once(async () => {
      try {
        const r = await deps.fetch(deps.imgBase + '/config', { cache: 'no-store' });
        return { status: r.status, json: await r.json().catch(() => null) };
      } catch (e) { return { error: errMsg(e) || 'network' }; }
    });
    const items = ITEMS.filter(([id]) => !o.only || o.only.includes(id));
    const rows = items.map(([id, label]) => ({ id, label, status: 'wait', text: '檢測中…', hint: '' }));
    await Promise.all(items.map(async ([id], i) => {
      let r;
      try { r = await withTimeout(checks[id](c), o.timeout); } catch (e) { r = bad('檢測時發生錯誤：' + errMsg(e), '重新整理頁面後再檢測'); }
      Object.assign(rows[i], r);
      if (o.onRow) try { o.onRow(id, rows[i], rows); } catch (e) { /* 畫面更新失敗不影響其他項目 */ }
    }));
    return rows;
  }

  // 結果 → 一句總結
  function summary(rows) {
    const bads = rows.filter(r => r.status === 'bad').length, warns = rows.filter(r => r.status === 'warn').length;
    if (rows.some(r => r.status === 'wait')) return '檢測中…';
    if (!bads && !warns) return '全部正常';
    return [bads ? `${bads} 項異常` : '', warns ? `${warns} 項要注意` : ''].filter(Boolean).join('・');
  }

  return { TIMEOUT, PROBE_URL, ICON, ITEMS, checks, run, summary, cmpVer, loginRow };
});

// ---- 瀏覽器：設定彈窗裡的「一鍵檢測」面板，以及回應外掛側邊欄的檢測請求 ----
(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.Health) return;
  const H = window.Health, $ = id => document.getElementById(id);
  const REPO_MANIFEST = 'https://raw.githubusercontent.com/unnn3ing-oss/-schedulenewnet/main/extension/manifest.json';
  const timed = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {});

  function deps() {
    return {
      fetch: (url, init) => fetch(url, Object.assign({}, timed(H.TIMEOUT), init)),
      selfUrl: new URL('icons/icon16.png?hc=' + Date.now(), location.href).href,
      online: () => navigator.onLine !== false,
      ping: () => Ext.ping(3000),
      cookies: () => Ext.cookies(),
      call: path => Ext.call(path, 'GET'),
      extErrorKind: e => (window.SendFlow ? SendFlow.extErrorKind(e) : ''),
      latestExtVersion: async () => {
        const r = await fetch(REPO_MANIFEST, Object.assign({ cache: 'no-store' }, timed(H.TIMEOUT)));
        if (!r.ok) throw new Error('http_' + r.status);
        return (await r.json()).version;
      },
      imgBase: window.ImgHost ? ImgHost.BASE : '',
      imgSession: () => (window.ImgHost ? ImgHost.session() : null),
      rundownEnabled: () => !!(window.Rundown && Rundown.enabled && Rundown.enabled()),
      mobile: /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent)
    };
  }

  // 一列：圖示＋項目＋結果，異常時下一行是怎麼處理
  function renderRow(li, r) {
    li.className = 'hc-row ' + r.status;
    li.dataset.id = r.id;
    const ic = document.createElement('span'); ic.className = 'hc-ic'; ic.textContent = H.ICON[r.status] || '';
    const lb = document.createElement('b'); lb.textContent = r.label;
    const tx = document.createElement('span'); tx.className = 'hc-text'; tx.textContent = r.text;
    li.replaceChildren(ic, lb, tx);
    if (r.hint) { const h = document.createElement('small'); h.className = 'hc-hint'; h.textContent = '👉 ' + r.hint; li.append(h); }
  }
  function render(list, rows) {
    while (list.children.length > rows.length) list.lastChild.remove();
    rows.forEach((r, i) => renderRow(list.children[i] || list.appendChild(document.createElement('li')), r));
  }

  let running = null, lastRun = 0;
  async function runPanel(deep) {
    const list = $('hcList'), btn = $('hcRun'), sum = $('hcSum');
    if (!list || running) return running;
    btn.disabled = true; sum.textContent = '檢測中…'; sum.className = 'hc-sum';
    running = H.run(deps(), { deep, onRow: (id, r, rows) => { render(list, rows); sum.textContent = H.summary(rows); } })
      .then(rows => {
        render(list, rows);
        const s = H.summary(rows);
        sum.textContent = (deep ? '' : '快速檢測：') + s + `（${new Date().toLocaleTimeString('zh-TW', { hour12: false })}）`;
        sum.className = 'hc-sum ' + (rows.some(r => r.status === 'bad') ? 'bad' : rows.some(r => r.status === 'warn') ? 'warn' : 'ok');
        return rows;
      })
      .catch(() => [])
      .finally(() => { running = null; lastRun = Date.now(); btn.disabled = false; });
    // 初始列（全部「檢測中」）
    render(list, H.ITEMS.map(([id, label]) => ({ id, label, status: 'wait', text: '檢測中…', hint: '' })));
    return running;
  }

  function wire() {
    if (!$('hcRun')) return;
    $('hcRun').addEventListener('click', () => runPanel(true));
    // 打開設定就先做一次快速檢測（不打後台、不連試算表）；30 秒內開過就不重跑
    const setBtn = $('setBtn');
    if (setBtn) setBtn.addEventListener('click', () => { if (Date.now() - lastRun > 30000) runPanel(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  // 外掛側邊欄（父頁 chrome-extension://）請嵌入的網頁版跑檢測：只回結果文字，不含 cookie 值或憑證
  if (window.self !== window.top) {
    window.addEventListener('message', e => {
      const d = e.data;
      if (e.source !== window.parent || !/^chrome-extension:\/\//.test(e.origin) || !d || d.source !== 'snn-sp' || d.op !== 'health') return;
      H.run(deps(), { deep: !!d.deep, timeout: Number(d.timeout) || H.TIMEOUT })
        .then(rows => window.parent.postMessage({ source: 'snn-web-health', id: d.id, rows }, e.origin))
        .catch(() => {});
    });
  }

  Object.assign(H, { deps, render, runPanel });
})();
