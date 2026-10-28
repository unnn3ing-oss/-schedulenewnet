// 「安裝外掛」全螢幕教學（沿用 QuickPatterntool 網頁版 deploy.js 的安裝部分）：
// 把 Chrome 擴充功能的最新版檔案「準備」到你的電腦上，再一步步教你到 chrome://extensions 載入。
//
// 網頁沒辦法直接替瀏覽器安裝擴充功能，所以這裡只負責準備檔案：
//   主要：下載一鍵安裝檔（web/installer.js，仿 videodownload）：檔案嵌在安裝檔裡，執行後放到固定資料夾、複製路徑、打開擴充功能頁
//   備案 A. 寫入資料夾：讓使用者選一個空資料夾，把檔案直接寫進去（File System Access API）
//   備案 B. 下載 ZIP：不能執行安裝檔、也不能選資料夾時
// 檔案清單取自 GitHub main 分支 extension/ 資料夾的最新內容，每個檔案都用 git blob SHA 驗證。
(function () {
  const REPO = { owner: 'unnn3ing-oss', repo: '-schedulenewnet', branch: 'main' };
  const EXT_NAME = '網新快速排程 連線驗證';   // extension/manifest.json 的 name
  const EXT_FOLDER = 'schedulenewnet-ext';    // 建議的資料夾名稱（ZIP 裡的最上層資料夾也用這個名稱）
  const PREFIX = 'extension/';                // 和 extension/updater.js 相同：只取 repo 的 extension/，路徑去掉這段
  const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;
  const RAW = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}`;

  // ---- 從 GitHub 取得檔案 -------------------------------------------------------
  async function getJson(url) {
    let res;
    try { res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' }); }
    catch (e) { throw new Error('連不上 GitHub，請確認網路連線'); }
    if (res.status === 403 || res.status === 429) throw new Error('GitHub 暫時限制查詢次數，請稍後再試');
    if (!res.ok) throw new Error(`連不上 GitHub（HTTP ${res.status}）`);
    return res.json();
  }

  // 和 updater.js 的 isSafePath 相同：相對路徑，不含 .、..、反斜線、冒號
  function isSafePath(p) {
    return typeof p === 'string' && !!p && !p.startsWith('/')
      && p.split('/').every(seg => seg && seg !== '.' && seg !== '..' && !/[\\:\0]/.test(seg));
  }

  async function gitBlobSha(bytes) {
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(header.length + bytes.length);
    all.set(header, 0);
    all.set(bytes, header.length);
    const digest = await crypto.subtle.digest('SHA-1', all);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  // 回傳 [{ path, bytes }]；每個檔案都用 git blob SHA 驗證內容，任何一個不符就整批取消
  async function fetchExtensionFiles(onProgress) {
    onProgress('取得最新版檔案清單…');
    const commit = await getJson(`${API}/commits/${REPO.branch}`);
    const tree = await getJson(`${API}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('檔案太多，GitHub 沒有回傳完整清單');
    const list = tree.tree.filter(t => t.type === 'blob' && t.path.startsWith(PREFIX))
      .map(t => ({ path: t.path.slice(PREFIX.length), repoPath: t.path, sha: t.sha }));
    if (!list.some(f => f.path === 'manifest.json')) throw new Error('GitHub 上找不到 manifest.json');
    if (list.some(f => !isSafePath(f.path))) throw new Error('GitHub 上的檔案清單含有不安全的路徑，已停止');
    const files = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      onProgress(`下載 ${i + 1}/${list.length}：${f.path}`);
      let res;
      try { res = await fetch(`${RAW}/${commit.sha}/${f.repoPath.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' }); }
      catch (e) { throw new Error('下載檔案失敗，請確認網路連線'); }
      if (!res.ok) throw new Error(`下載 ${f.path} 失敗（HTTP ${res.status}）`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if ((await gitBlobSha(bytes)) !== f.sha) throw new Error(`${f.path} 下載內容和 GitHub 上的不一致，已取消`);
      files.push({ path: f.path, bytes });
    }
    return files;
  }

  // ---- A. 寫入資料夾 -----------------------------------------------------------
  // 瀏覽器的「選資料夾」視窗沒有辦法預先填好資料夾名稱，所以改成：
  //   - 選到空資料夾，或本來就是這個擴充功能的資料夾 → 直接寫在裡面
  //   - 選到有其他東西的資料夾 → 在裡面建立（或沿用）名為 EXT_FOLDER 的子資料夾，只新增、不動其他檔案
  async function isOurs(dir) {
    try {
      const file = await (await dir.getFileHandle('manifest.json')).getFile();
      return JSON.parse(await file.text()).name === EXT_NAME;
    } catch (e) { return false; }   // 沒有 manifest.json 或不是 JSON，就不是我們的資料夾
  }
  async function isEmpty(dir) {
    for await (const _ of dir.entries()) return false;
    return true;
  }
  // 回傳 { dir, label }：實際要寫入的資料夾，以及給使用者看的路徑
  async function resolveTarget(picked) {
    if ((await isEmpty(picked)) || (await isOurs(picked))) return { dir: picked, label: picked.name };
    let sub = null;
    try { sub = await picked.getDirectoryHandle(EXT_FOLDER); } catch (e) { /* 還沒有同名資料夾 */ }
    if (sub) {
      if (!(await isEmpty(sub)) && !(await isOurs(sub))) {
        throw new Error(`「${picked.name}」裡已經有一個「${EXT_FOLDER}」資料夾，但裡面不是空的，也不是這個插件。請換一個資料夾，或把它改名。`);
      }
    } else {
      sub = await picked.getDirectoryHandle(EXT_FOLDER, { create: true });
    }
    return { dir: sub, label: `${picked.name}/${EXT_FOLDER}` };
  }

  async function writeFile(dir, path, bytes) {
    const parts = path.split('/');
    let cur = dir;
    for (const p of parts.slice(0, -1)) cur = await cur.getDirectoryHandle(p, { create: true });
    const handle = await cur.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  }

  // 先決定目標資料夾、再下載、全部驗證通過才開始寫入。回傳 { count, label }
  async function deployToFolder(picked, onProgress) {
    const target = await resolveTarget(picked);
    const files = await fetchExtensionFiles(onProgress);
    for (let i = 0; i < files.length; i++) {
      onProgress(`寫入 ${i + 1}/${files.length}：${files[i].path}`);
      await writeFile(target.dir, files[i].path, files[i].bytes);
    }
    return { count: files.length, label: target.label };
  }

  // ---- B. 打包 ZIP（不壓縮，只是把檔案裝在一起）-------------------------------------
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const local = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.bytes);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // 0x0800 = 檔名為 UTF-8
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, e.bytes.length, true); lh.setUint32(22, e.bytes.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      local.push(lh, name, e.bytes);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, e.bytes.length, true); ch.setUint32(24, e.bytes.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + e.bytes.length;
    }
    const centralSize = central.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }

  // 一鍵安裝檔：ZIP 不含最上層資料夾（安裝檔自己建 schedulenewnet-ext），版本取自 manifest.json
  async function buildInstaller(os, onProgress) {
    const files = await fetchExtensionFiles(onProgress);
    onProgress('打包安裝檔…');
    const manifest = files.find(f => f.path === 'manifest.json');
    let version;
    try { version = JSON.parse(new TextDecoder().decode(manifest.bytes)).version; } catch (e) { throw new Error('manifest.json 讀不懂，已停止'); }
    const zip = new Uint8Array(await buildZip(files.map(f => ({ name: f.path, bytes: f.bytes }))).arrayBuffer());
    return window.Installer.build(os, zip, version);
  }

  async function buildZipOfExtension(onProgress) {
    const files = await fetchExtensionFiles(onProgress);
    onProgress('打包 ZIP…');
    return { blob: buildZip(files.map(f => ({ name: `${EXT_FOLDER}/${f.path}`, bytes: f.bytes }))), count: files.length };
  }

  // ---- 全螢幕教學（步驟精靈）------------------------------------------------------------
  const overlay = document.getElementById('deployOverlay');
  if (!overlay) return;
  const openBtn = document.getElementById('deployBtn');
  const closeBtn = document.getElementById('deployCloseBtn');
  const installBtn = document.getElementById('deployInstallBtn');
  const pickBtn = document.getElementById('deployPickBtn');
  const zipBtn = document.getElementById('deployZipBtn');
  const copyUrlBtn = document.getElementById('deployCopyUrl');
  const copyCmdBtn = document.getElementById('deployCopyCmd');
  const statusEl = document.getElementById('deployStatus');
  const prevBtn = document.getElementById('deployPrevBtn');
  const nextBtn = document.getElementById('deployNextBtn');
  const countEl = document.getElementById('deployCount');
  const panes = [...overlay.querySelectorAll('.ds-pane')];
  const stepEls = [...overlay.querySelectorAll('#deploySteps .ds-step')];
  const loadFolderEl = document.getElementById('deployLoadFolder');
  // 示意動畫的時間點寫在 data-style（本站 CSP 不允許 style 屬性），用 CSSOM 套上
  overlay.querySelectorAll('[data-style]').forEach(el => el.dataset.style.split(';').forEach(d => {
    const i = d.indexOf(':');
    if (i > 0) el.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }));
  const TOTAL = panes.length;
  const html = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let step = 1;
  let busy = false;
  let opener = null;
  let replayTimer = null;

  // Mac 與 Windows 的按鍵、選單名稱不同：只顯示使用者那一邊
  const isMac = /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
  overlay.dataset.os = isMac ? 'mac' : 'win';
  overlay.querySelectorAll('.k-mod').forEach(el => { el.textContent = isMac ? '⌘' : 'Ctrl'; });
  overlay.querySelectorAll('[data-only]').forEach(el => { el.hidden = el.dataset.only !== overlay.dataset.os; });

  // 安裝檔放的固定位置（Installer.FOLDER）：「文件」資料夾裡（Windows 有 OneDrive 時實際路徑會不同，安裝檔會把真正的路徑複製好）
  const installedPath = isMac ? `~/Documents/${window.Installer.FOLDER}` : `C:\\Users\\你的帳號\\Documents\\${window.Installer.FOLDER}`;
  document.getElementById('deployInstallName').textContent = window.Installer.FILES[overlay.dataset.os];
  document.getElementById('deployMacCmd').textContent = window.Installer.macCommand;
  loadFolderEl.textContent = installedPath;

  const setStatus = (msg, kind) => { statusEl.textContent = msg; statusEl.className = 'ds-status' + (kind ? ` ${kind}` : ''); };
  const refreshNav = () => {
    prevBtn.disabled = busy || step === 1;
    nextBtn.disabled = busy;
    nextBtn.textContent = step === TOTAL ? '完成' : '下一步';
    countEl.textContent = `${step} / ${TOTAL}`;
  };
  const setBusy = b => { busy = b; installBtn.disabled = pickBtn.disabled = zipBtn.disabled = b; refreshNav(); };

  // 示意動畫：換到那一步時從頭播，播完停一下再重播；使用者設定「減少動態效果」就停在做完的畫面
  function stopReplay() { clearTimeout(replayTimer); replayTimer = null; }
  function play(pane) {
    stopReplay();
    panes.forEach(p => p.querySelector('.ds-art').classList.remove('play'));
    const art = pane.querySelector('.ds-art');
    if (reduceMotion.matches) return;
    const cycle = Number(pane.dataset.cycle) || 7000;
    art.style.setProperty('--end', `${(cycle - 600) / 1000}s`);
    void art.offsetWidth;   // 讓瀏覽器先套用「沒有 play」的樣式，再加回去才會重播
    art.classList.add('play');
    replayTimer = setTimeout(() => { if (overlay.hidden || panes[step - 1] !== pane) return; play(pane); }, cycle);
  }

  function goTo(n, focus = true) {
    step = Math.min(TOTAL, Math.max(1, n));
    panes.forEach((p, i) => { p.hidden = i !== step - 1; });
    stepEls.forEach((li, i) => {
      li.classList.toggle('done', i < step - 1);
      li.classList.toggle('current', i === step - 1);
      const b = li.querySelector('.ds-step-btn');
      if (i === step - 1) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    refreshNav();
    overlay.querySelector('.ds-main').scrollTop = 0;
    if (focus) panes[step - 1].querySelector('h3').focus({ preventScroll: true });
    play(panes[step - 1]);
  }

  const isOpen = () => !overlay.hidden;
  function close() {
    if (!isOpen()) return;
    stopReplay();
    overlay.hidden = true;
    html.classList.remove('ds-lock');
    if (opener && document.contains(opener)) opener.focus();
  }
  function open() {
    opener = document.activeElement;
    setStatus('');
    loadFolderEl.textContent = installedPath;
    overlay.hidden = false;
    html.classList.add('ds-lock');
    goTo(1, false);
    nextBtn.focus({ preventScroll: true });
  }

  if (openBtn) openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', () => { if (!busy) goTo(step - 1); });
  nextBtn.addEventListener('click', () => { if (busy) return; if (step === TOTAL) close(); else goTo(step + 1); });
  stepEls.forEach((li, i) => li.querySelector('.ds-step-btn').addEventListener('click', () => { if (!busy && i + 1 !== step) goTo(i + 1); }));
  reduceMotion.addEventListener('change', () => { if (isOpen()) play(panes[step - 1]); });

  document.addEventListener('keydown', e => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {   // 全螢幕蓋住整個網頁：Tab 只在這個畫面裡轉
      const items = [...overlay.querySelectorAll('button, a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!overlay.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
    if (typing || busy || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight' && step < TOTAL) goTo(step + 1);
    else if (e.key === 'ArrowLeft' && step > 1) goTo(step - 1);
  });

  // 不支援選資料夾的瀏覽器（Firefox、Safari）手動安裝只留 ZIP
  if (typeof window.showDirectoryPicker !== 'function') pickBtn.hidden = true;

  function save(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  installBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { name, text, type } = await buildInstaller(overlay.dataset.os, msg => setStatus(msg));
      save(new Blob([text], { type }), name);
      loadFolderEl.textContent = installedPath;
      setStatus(`已下載安裝檔「${name}」。請按「下一步」執行它。`, 'ok');
    } catch (err) {
      setStatus(err.message || String(err), 'err');
    } finally { setBusy(false); }
  });

  pickBtn.addEventListener('click', async () => {
    if (busy) return;
    let dir;
    try { dir = await window.showDirectoryPicker({ id: 'snn-extension', mode: 'readwrite' }); }
    catch (err) { if (err && err.name === 'AbortError') return; setStatus(`無法開啟這個資料夾：${err.message || err}`, 'err'); return; }
    setBusy(true);
    try {
      const { count, label } = await deployToFolder(dir, msg => setStatus(msg));
      loadFolderEl.textContent = label;
      setStatus(`已把 ${count} 個檔案寫入「${label}」。請跳到步驟 3「開發人員模式」繼續（到擴充功能頁：chrome://extensions）。`, 'ok');
    } catch (err) {
      setStatus(err.message || String(err), 'err');
    } finally { setBusy(false); }
  });

  zipBtn.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { blob, count } = await buildZipOfExtension(msg => setStatus(msg));
      save(blob, `${EXT_FOLDER}.zip`);
      loadFolderEl.textContent = EXT_FOLDER;
      setStatus(`已下載 ZIP（${count} 個檔案）。請先解壓縮，解壓縮後的資料夾就是「${EXT_FOLDER}」，再跳到步驟 3「開發人員模式」（到擴充功能頁：chrome://extensions）。`, 'ok');
    } catch (err) {
      setStatus(err.message || String(err), 'err');
    } finally { setBusy(false); }
  });

  // 複製按鈕共用：按下後短暫顯示結果
  function bindCopy(btn, text) {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
      let ok = false;
      try { await navigator.clipboard.writeText(typeof text === 'function' ? text() : text); ok = true; } catch (e) { /* 剪貼簿被拒絕 */ }
      btn.textContent = ok ? '已複製 ✓' : '複製失敗，請手動輸入';
      setTimeout(() => { btn.textContent = label; }, 1600);
    });
  }
  bindCopy(copyUrlBtn, 'chrome://extensions');
  bindCopy(copyCmdBtn, window.Installer.macCommand);

  window.Deploy = { fetchExtensionFiles, deployToFolder, buildZip, buildZipOfExtension, buildInstaller, crc32, REPO, EXT_FOLDER, open, close, isOpen };
})();
