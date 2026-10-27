// 分頁：「發文」是嵌入的網頁版、「狀態與更新」是登入狀態與版本更新；記住上次停在哪一頁
(function () {
  const tabs = { post: [document.getElementById('tabPost'), document.getElementById('panePost')],
    info: [document.getElementById('tabInfo'), document.getElementById('paneInfo')] };
  function show(name) {
    for (const [k, [tab, pane]] of Object.entries(tabs)) {
      tab.setAttribute('aria-selected', String(k === name));
      pane.hidden = k !== name;
    }
    try { localStorage.setItem('snn-sp-tab', name); } catch (e) { /* 存不了就算了 */ }
  }
  for (const [k, [tab]] of Object.entries(tabs)) tab.addEventListener('click', () => show(k));
  let saved = 'post';
  try { saved = localStorage.getItem('snn-sp-tab') === 'info' ? 'info' : 'post'; } catch (e) { /* 預設發文 */ }
  show(saved);
})();

// 標題：外掛名稱與版本
const manifest = chrome.runtime.getManifest();
document.getElementById('extName').textContent = manifest.name;
document.getElementById('extVer').textContent = `v${manifest.version}`;

// 登入狀態：只看 queen_session 在不在、還有幾天到期，不顯示 cookie 的值。
(async function () {
  const el = document.getElementById('loginStatus');
  const set = (text, cls) => { el.textContent = text; el.className = 'status ' + cls; };
  try {
    const list = await chrome.cookies.getAll({ url: 'https://digi-social-post.tvbs.ai/' });
    const c = list.find(x => x.name === 'queen_session');
    if (!c) return set('尚未登入：找不到 queen_session，請先登入網新發文台', 'bad');
    if (!c.expirationDate) return set('已登入（登入階段 cookie，關閉瀏覽器後失效）', 'ok');
    const days = Math.floor((c.expirationDate * 1000 - Date.now()) / 86400000);
    if (days < 0) set('登入已過期，請重新登入', 'bad');
    else if (days < 3) set(`已登入，但約 ${days} 天後到期`, 'warn');
    else set(`已登入，約 ${days} 天後到期`, 'ok');
  } catch (e) { set('讀不到登入狀態', 'bad'); }
})();

// 「版本更新」區塊（邏輯在 updater.js）
(function () {
  const statusEl = document.getElementById('upStatus');
  const hintEl = document.getElementById('upHint');
  const notesEl = document.getElementById('upNotes');
  const checkBtn = document.getElementById('upCheckBtn');
  const applyBtn = document.getElementById('upApplyBtn');
  const filesBox = document.getElementById('upFiles');
  const filesSummary = document.getElementById('upFilesSummary');
  const fileList = document.getElementById('upFileList');
  let latest = null;

  function show(msg, hasUpdate) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('has-update', !!hasUpdate);
  }
  const ver = v => (v ? `v${v}` : '');
  function updateHeadline(info) {
    const n = `${info.changed.length} 個檔案不同`;
    if (!info.version) return `有新版本（${n}）`;
    if (info.version === info.localVersion) return `有新版本（版本號仍是 ${ver(info.version)}，${n}）`;
    return `有新版本 ${ver(info.version)}（目前 ${ver(info.localVersion)}，${n}）`;
  }
  const fmtDate = iso => new Date(iso).toLocaleString('zh-TW', { hour12: false });

  // 版本說明（changelog.json）：最新版那一筆的簡述與條列
  function showNotes(notes) {
    notesEl.textContent = '';
    for (const n of notes || []) {
      const head = document.createElement('b');
      head.textContent = n.summary || '';
      notesEl.append(head);
      if (n.items.length) {
        const ul = document.createElement('ul');
        for (const t of n.items) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
        notesEl.append(ul);
      }
    }
    notesEl.hidden = !notesEl.childElementCount;
  }

  // 還沒選過資料夾時，先講明資料夾在哪（系統的選資料夾視窗會蓋住畫面）
  async function refreshFolderHint() {
    hintEl.textContent = '';
    if (await Updater.hasSavedFolder()) { applyBtn.textContent = '更新到最新版'; return; }
    applyBtn.textContent = '選擇資料夾並更新';
    hintEl.append('第一次更新要先選擇這個外掛所在的資料夾（只需選這一次）。資料夾位置在「詳細資料」頁的「來源」那一行。', document.createElement('br'));
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'up-link';
    link.textContent = '開啟擴充功能詳細資料頁';
    link.addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
    hintEl.append(link);
  }

  function showFiles(changed) {
    fileList.textContent = '';
    for (const f of changed) {
      const li = document.createElement('li');
      li.textContent = f.path;
      const tag = document.createElement('span');
      tag.className = 'up-tag';
      tag.textContent = f.status === 'new' ? '新增' : '修改';
      li.append(tag);
      fileList.append(li);
    }
    filesSummary.textContent = `要更新的檔案（${changed.length}）`;
    filesBox.hidden = !changed.length;
    filesBox.open = false;
  }

  async function check() {
    checkBtn.disabled = true;
    show('檢查中…');
    hintEl.textContent = '';
    filesBox.hidden = true;
    notesEl.hidden = true;
    try {
      latest = await Updater.checkLatest();
      if (latest.hasUpdate) {
        show(`${updateHeadline(latest)}：${(latest.notes[0] && latest.notes[0].summary) || latest.message}｜${fmtDate(latest.date)}`, true);
        applyBtn.hidden = false;
        showNotes(latest.notes);
        showFiles(latest.changed);
        await refreshFolderHint();
        document.getElementById('infoDot').hidden = false;
        chrome.action.setBadgeText({ text: '新' }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: '#d92d20' }).catch(() => {});
      } else {
        show(latest.localNewer ? `本機版本 ${ver(latest.localVersion)} 比 GitHub 上的 ${ver(latest.version)} 新，不需要更新` : `已是最新版本${latest.version ? ' ' + ver(latest.version) : ''}（${fmtDate(latest.date)}）`);
        applyBtn.hidden = true;
        document.getElementById('infoDot').hidden = true;
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
      }
    } catch (err) {
      show(err.message || String(err));
      applyBtn.hidden = true;
    } finally {
      checkBtn.disabled = false;
    }
  }

  async function apply() {
    if (!latest || !latest.hasUpdate) return;
    applyBtn.disabled = checkBtn.disabled = true;
    try {
      let dir = await Updater.getFolder();
      if (!dir) dir = await Updater.pickFolder();
      await Updater.apply(dir, latest, msg => show(msg), risks => confirm(
        `這次更新會增加權限。新版的 manifest.json 有以下變動：\n・${risks.join('\n・')}\n\n只有信任這份更新時才要繼續。`));
      show('更新完成，重新載入擴充功能…');
      setTimeout(() => chrome.runtime.reload(), 400);
    } catch (err) {
      if (err && err.name === 'AbortError') show('已取消，沒有更新任何檔案');
      else if (err && err.name === 'SecurityError') show('沒有取得資料夾的存取權限，請再試一次');
      else show(`更新失敗：${err.message || err}`);
      applyBtn.disabled = checkBtn.disabled = false;
    }
  }

  checkBtn.addEventListener('click', check);
  applyBtn.addEventListener('click', apply);
  check();   // 打開側邊欄就檢查一次
})();
