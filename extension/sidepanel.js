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
  const folderEl = document.getElementById('upFolder');
  let latest = null, busy = false;

  // ---- 外掛內的彈窗（取代瀏覽器的 confirm／alert）----
  // modal({ title, body:[字串或節點], buttons:[{ label, value, primary }], progress:0～1 或 null })
  // 回傳按下的按鈕 value；按 Esc 回 'cancel'（進度中不能關）；換下一個畫面時前一個回 null
  const dlg = document.getElementById('upDlg');
  const dlgTitle = document.getElementById('upDlgTitle'), dlgBody = document.getElementById('upDlgBody');
  const dlgProg = document.getElementById('upDlgProg'), dlgBar = document.getElementById('upDlgBar'), dlgBtns = document.getElementById('upDlgBtns');
  let answer = null;
  const para = (text, cls) => { const p = document.createElement('p'); p.textContent = text; if (cls) p.className = cls; return p; };
  const code = text => { const c = document.createElement('code'); c.textContent = text; return c; };
  function setProgress(v) { dlgProg.hidden = v == null; if (v != null) dlgBar.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%'; }
  function modal({ title, body = [], buttons = [], progress = null }) {
    if (answer) answer(null);
    dlgTitle.textContent = title;
    dlgBody.replaceChildren(...body.map(x => (typeof x === 'string' ? para(x) : x)));
    setProgress(progress);
    dlgBtns.replaceChildren();
    const p = new Promise(resolve => { answer = v => { answer = null; resolve(v); }; });
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'btn' + (b.primary ? ' primary' : ''); el.textContent = b.label;
      el.addEventListener('click', () => answer && answer(b.value));
      dlgBtns.append(el);
    }
    if (!dlg.open) dlg.showModal();
    (dlgBtns.querySelector('.primary') || dlgBtns.querySelector('button') || dlg).focus();
    return p;
  }
  function closeModal() { if (answer) answer(null); if (dlg.open) dlg.close(); }
  dlg.addEventListener('cancel', e => { e.preventDefault(); if (!busy) { if (answer) answer('cancel'); dlg.close(); } });

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

  // 選過資料夾就記住（之後都更新到同一個位置）；還沒選過，按更新時彈窗會先帶著選
  async function refreshFolderHint() {
    hintEl.textContent = '';
    const saved = await Updater.hasSavedFolder();
    folderEl.hidden = !saved;
    applyBtn.textContent = saved ? '更新到最新版' : '選擇資料夾並更新';
  }

  // 選資料夾的說明：用安裝檔裝的在「文件」裡；不確定就看擴充功能詳細資料頁的「來源」
  function folderBody(saved) {
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'up-link'; link.textContent = '開啟擴充功能詳細資料頁（看「來源」那一行）';
    link.addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
    return [
      saved ? '之前記住的資料夾打不開（可能被移走、改名，或沒有允許存取），請重新選一次。' : '第一次更新要選這個外掛所在的資料夾，選一次就會記住，之後都直接更新到這裡。',
      '用安裝檔裝的，位置是「文件」裡的：', code('schedulenewnet-ext'),
      'Chrome 問「要讓這個擴充功能編輯檔案嗎」時，請按允許（有「每次都允許」就選它，之後就不會再問）。',
      link
    ];
  }
  // 選資料夾；選錯會說明並讓人重選。回傳資料夾，取消回 null
  async function chooseFolder(saved) {
    let msg = null;
    for (;;) {
      const a = await modal({ title: saved ? '重新選擇外掛資料夾' : '選擇外掛資料夾（只需一次）',
        body: msg ? [para(msg, 'bad'), ...folderBody(saved)] : folderBody(saved),
        buttons: [{ label: '取消', value: 'cancel' }, { label: '選擇資料夾', value: 'pick', primary: true }] });
      if (a !== 'pick') return null;
      try { const dir = await Updater.pickFolder(); await refreshFolderHint(); return dir; } catch (err) {
        if (err && err.name === 'AbortError') return null;
        msg = err && err.name === 'SecurityError' ? '沒有取得資料夾的存取權限，請再選一次並按允許。' : (err.message || String(err));
      }
    }
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
        offerUpdate();
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

  // 打開側邊欄查到新版：同一版只主動彈一次（按「稍後」就不再彈，卡片上的按鈕隨時能更新）
  const OFFER_KEY = 'snn-sp-offered';
  async function offerUpdate() {
    let seen = '';
    try { seen = localStorage.getItem(OFFER_KEY) || ''; } catch (e) { /* 存不了就每次都問 */ }
    if (seen === latest.sha || dlg.open) return;
    try { localStorage.setItem(OFFER_KEY, latest.sha); } catch (e) { /* 無妨 */ }
    const notes = (latest.notes || []).flatMap(n => [para(n.summary || '')].concat(n.items.length ? [list(n.items)] : []));
    const a = await modal({ title: updateHeadline(latest), body: notes.length ? notes : [latest.message || ''],
      buttons: [{ label: '稍後', value: 'later' }, { label: '立即更新', value: 'go', primary: true }] });
    if (a === 'go') apply(); else if (a) closeModal();
  }
  function list(items) { const ul = document.createElement('ul'); for (const t of items) { const li = document.createElement('li'); li.textContent = t; ul.append(li); } return ul; }

  // 下載 i/n 算前半、寫入 i/n 算後半
  function progressOf(msg) {
    const m = /^(下載|寫入) (\d+)\/(\d+)/.exec(msg);
    return m ? ((m[1] === '寫入' ? +m[3] : 0) + +m[2]) / (2 * +m[3]) : null;
  }

  async function apply() {
    if (!latest || !latest.hasUpdate || busy) return;
    applyBtn.disabled = checkBtn.disabled = true;
    try {
      // 記住的資料夾直接用（權限過期時 Chrome 會在這次點擊問一次）；沒有或打不開才請人選
      let dir = await Updater.getFolder();
      if (!dir) dir = await chooseFolder(await Updater.hasSavedFolder());
      if (!dir) { closeModal(); show('已取消，沒有更新任何檔案'); return; }
      busy = true;
      modal({ title: '更新中…', body: ['準備下載…', '請不要關閉側邊欄。'], progress: 0 });
      await Updater.apply(dir, latest, msg => {
        if (!busy) return;
        dlgBody.firstChild.textContent = msg; setProgress(progressOf(msg) ?? Number(dlgBar.style.width.replace('%', '')) / 100);
      }, async risks => {
        busy = false;
        const a = await modal({ title: '這次更新會增加權限', body: ['新版的 manifest.json 有以下變動：', list(risks), para('只有信任這份更新時才要繼續。', 'bad')],
          buttons: [{ label: '取消更新', value: 'cancel' }, { label: '繼續更新', value: 'go', primary: true }] });
        if (a !== 'go') return false;
        busy = true;
        modal({ title: '更新中…', body: ['寫入檔案…', '請不要關閉側邊欄。'], progress: 0.5 });
        return true;
      });
      modal({ title: '更新完成', body: [`已更新到 ${ver(latest.version) || '最新版'}，馬上重新載入外掛。`], progress: 1 });
      show('更新完成，重新載入擴充功能…');
      setTimeout(() => chrome.runtime.reload(), 900);
    } catch (err) {
      busy = false;
      const cancelled = err && err.name === 'AbortError';
      const msg = cancelled ? '已取消，沒有更新任何檔案' : err && err.name === 'SecurityError' ? '沒有取得資料夾的存取權限' : `更新失敗：${(err && err.message) || err}`;
      show(msg);
      applyBtn.disabled = checkBtn.disabled = false;
      if (cancelled) { closeModal(); return; }
      const a = await modal({ title: '沒有更新成功', body: [para(msg, 'bad'), '下載的檔案都驗證過才會寫入；如果是寫入途中出錯，按「重試」會再寫一次。'],
        buttons: [{ label: '關閉', value: 'close' }, { label: '重新選擇資料夾', value: 'repick' }, { label: '重試', value: 'retry', primary: true }] });
      if (a === 'retry') apply();
      else if (a === 'repick') { const d = await chooseFolder(true); if (d) apply(); else closeModal(); }
      else closeModal();
    } finally { busy = false; }
  }

  checkBtn.addEventListener('click', check);
  applyBtn.addEventListener('click', apply);
  document.getElementById('upRepick').addEventListener('click', async () => {
    const d = await chooseFolder(true);
    closeModal();
    if (d) show('已改用新選的資料夾，之後都更新到這裡');
  });
  check();   // 打開側邊欄就檢查一次
})();
