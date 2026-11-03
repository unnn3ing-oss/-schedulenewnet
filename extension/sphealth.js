// 側邊欄「狀態與更新」的一鍵檢測。
// 外掛本身的項目在這裡直接查（背景服務、網新登入 cookie、外掛版本）；網路、圖床、Rundown 等網頁那邊的項目，
// 請嵌入的網頁版（iframe，web/health.js）代跑後把結果傳回來（側邊欄是 chrome-extension:// 網域，讀不到網頁版的圖床登入）。
// 只顯示狀態文字，不顯示 cookie 值、憑證或密碼。
(function () {
  const $ = id => document.getElementById(id);
  const WEB_ORIGIN = 'https://unnn3ing-oss.github.io';
  const ICON = { ok: '✅', warn: '⚠️', bad: '❌', skip: '➖', wait: '⏳' };
  const api = window.SpHealth = { timeout: 8000, run };
  const row = (id, label, status, text, hint) => ({ id, label, status, text, hint: status === 'ok' || status === 'skip' ? '' : (hint || '') });
  const LOGIN_HINT = '在新分頁開啟網新發文台（按上方「舊版」）登入後，再檢測一次';

  function withTimeout(p, ms, fallback) {
    let t;
    return Promise.race([Promise.resolve(p).catch(e => fallback(e)), new Promise(r => { t = setTimeout(() => r(fallback(null)), ms); })]).finally(() => clearTimeout(t));
  }

  // ---- 外掛自己的項目 ----
  const own = {
    async sw() {
      const L = '外掛背景服務';
      const r = await new Promise(resolve => {
        try { chrome.runtime.sendMessage({ op: 'ping' }, res => resolve(chrome.runtime.lastError ? null : res)); } catch (e) { resolve(null); }
      });
      return r && r.ok ? row('sw', L, 'ok', `正常（v${r.version}）`) : row('sw', L, 'bad', '背景服務沒有回應', '到 chrome://extensions 按這個外掛的「重新載入」，再關掉側邊欄重開');
    },
    async login() {
      const L = '網新發文台登入';
      const list = await chrome.cookies.getAll({ url: 'https://digi-social-post.tvbs.ai/' });
      const c = list.find(x => x.name === 'queen_session');
      if (!c) return row('login', L, 'bad', '尚未登入（找不到登入 cookie）', LOGIN_HINT);
      if (!c.expirationDate) return row('login', L, 'ok', '已登入（關閉瀏覽器後失效）');
      const ms = c.expirationDate * 1000, days = Math.floor((ms - Date.now()) / 86400000);
      if (ms <= Date.now()) return row('login', L, 'bad', '登入已過期', LOGIN_HINT);
      if (days < 3) return row('login', L, 'warn', `已登入，但約 ${Math.max(0, days)} 天後到期`, '快到期了，有空時重新登入網新發文台');
      return row('login', L, 'ok', `已登入，約 ${days} 天後到期`);
    },
    async extUpdate() {
      const L = '外掛版本', v = chrome.runtime.getManifest().version;
      let info;
      try { info = await Updater.checkLatest(); } catch (e) { return row('extUpdate', L, 'warn', `v${v}，查不到 GitHub 上的最新版本`, (e && e.message) || '稍後再試'); }
      if (info.hasUpdate) return row('extUpdate', L, 'warn', `有新版${info.version ? ' v' + info.version : ''}（目前 v${v}）`, '按下方「版本更新」的「更新到最新版」');
      return row('extUpdate', L, 'ok', info.localNewer ? `v${v}（比 GitHub 上的新）` : `已是最新 v${v}`);
    }
  };

  // ---- 請嵌入的網頁版代跑網頁那邊的項目 ----
  let seq = 0;
  function askWeb(deep, ms) {
    const frame = $('app');
    return new Promise(resolve => {
      const id = 'h' + Date.now().toString(36) + (seq++);
      const done = v => { window.removeEventListener('message', on); clearTimeout(t); resolve(v); };
      const on = e => {
        const d = e.data;
        if (!frame || e.source !== frame.contentWindow || e.origin !== WEB_ORIGIN || !d || d.source !== 'snn-web-health' || d.id !== id || !Array.isArray(d.rows)) return;
        done(d.rows);
      };
      window.addEventListener('message', on);
      const t = setTimeout(() => done(null), ms);
      try { frame.contentWindow.postMessage({ source: 'snn-sp', op: 'health', id, deep: !!deep, timeout: Math.max(1000, ms - 1500) }, WEB_ORIGIN); } catch (e) { done(null); }
    });
  }
  // 網頁版傳回來的列只取需要的欄位、當純文字顯示
  const clean = r => row(String(r.id || ''), String(r.label || ''), ICON[r.status] ? r.status : 'warn', String(r.text || ''), String(r.hint || ''));
  // 這兩項側邊欄自己查得更準（版本比對檔案內容、cookie 直接讀），網頁版的就不重複列
  const DROP = ['extUpdate', 'login'];

  function renderRow(li, r) {
    li.className = 'hc-row ' + r.status;
    li.dataset.id = r.id;
    const ic = document.createElement('span'); ic.className = 'hc-ic'; ic.textContent = ICON[r.status] || '';
    const lb = document.createElement('b'); lb.textContent = r.label;
    const tx = document.createElement('span'); tx.className = 'hc-text'; tx.textContent = r.text;
    li.replaceChildren(ic, lb, tx);
    if (r.hint) { const h = document.createElement('small'); h.className = 'hc-hint'; h.textContent = '👉 ' + r.hint; li.append(h); }
  }
  function render(rows) {
    const list = $('hcList');
    while (list.children.length > rows.length) list.lastChild.remove();
    rows.forEach((r, i) => renderRow(list.children[i] || list.appendChild(document.createElement('li')), r));
  }
  function summary(rows) {
    if (rows.some(r => r.status === 'wait')) return ['檢測中…', ''];
    const b = rows.filter(r => r.status === 'bad').length, w = rows.filter(r => r.status === 'warn').length;
    if (!b && !w) return ['全部正常', 'ok'];
    return [[b ? `${b} 項異常` : '', w ? `${w} 項要注意` : ''].filter(Boolean).join('・'), b ? 'bad' : 'warn'];
  }

  let running = null, lastRun = 0;
  // deep：也測網新後台與 Rundown（按按鈕時）；打開分頁時的自動檢測不測
  function run(deep) {
    if (running) return running;
    const ms = api.timeout, btn = $('hcRun'), sum = $('hcSum');
    btn.disabled = true;
    const wait = (id, label) => row(id, label, 'wait', '檢測中…');
    const rows = [wait('sw', '外掛背景服務'), wait('web', '側邊欄裡的網頁版'), wait('login', '網新發文台登入'), wait('extUpdate', '外掛版本')];
    const paint = () => { render(rows); const [t, c] = summary(rows); sum.textContent = t; sum.className = 'hc-sum ' + c; };
    const set = r => { const i = rows.findIndex(x => x.id === r.id); if (i >= 0) rows[i] = r; paint(); };
    paint();
    const fail = (id, label) => e => row(id, label, 'bad', e ? '檢測時發生錯誤：' + ((e && e.message) || e) : `逾時（${Math.round(ms / 1000)} 秒沒有回應）`, '關掉側邊欄再打開後重新檢測');
    const jobs = [
      withTimeout(own.sw(), ms, fail('sw', '外掛背景服務')).then(set),
      withTimeout(own.login(), ms, fail('login', '網新發文台登入')).then(set),
      withTimeout(own.extUpdate(), ms, fail('extUpdate', '外掛版本')).then(set),
      askWeb(deep, ms).then(list => {
        if (!list) {
          set(row('web', '側邊欄裡的網頁版', 'warn', '嵌入的網頁版沒有回應，網路、圖床與 Rundown 無法檢測',
            '確認網路後關掉側邊欄再打開；網頁版還沒更新到有「一鍵檢測」的版本時也會這樣，可改在網頁版的「設定」裡檢測'));
          return;
        }
        set(row('web', '側邊欄裡的網頁版', 'ok', '已載入並有回應'));
        const i = rows.findIndex(x => x.id === 'web');
        rows.splice(i + 1, 0, ...list.map(clean).filter(r => r.id && !DROP.includes(r.id)));
        paint();
      })
    ];
    running = Promise.all(jobs).then(() => {
      const [t, c] = summary(rows);
      sum.textContent = (deep ? '' : '快速檢測：') + t + `（${new Date().toLocaleTimeString('zh-TW', { hour12: false })}）`;
      sum.className = 'hc-sum ' + c;
      return rows;
    }).catch(() => rows).finally(() => { running = null; lastRun = Date.now(); btn.disabled = false; });
    return running;
  }

  $('hcRun').addEventListener('click', () => run(true));
  // 切到「狀態與更新」就先快速檢測一次（30 秒內做過就不重跑）
  const auto = () => { if (!$('paneInfo').hidden && Date.now() - lastRun > 30000) run(false); };
  $('tabInfo').addEventListener('click', auto);
  // 打開時就停在這一頁：等嵌入的網頁版載入一下再跑
  if (!$('paneInfo').hidden) { $('app').addEventListener('load', () => setTimeout(auto, 300), { once: true }); setTimeout(auto, 4000); }
})();
