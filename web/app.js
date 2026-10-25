// 正式介面（PR A：外殼＋新增發文彈窗＋作圖框＋快速帶入）。送出、AI、守則判讀在後續 PR。
(function () {
  const $ = id => document.getElementById(id);
  const C = window.NEWSNET_CONFIG;
  const overlay = $('overlay'), modal = $('modal');
  const state = { mode: 'frame', template: 'newsnet_news', articleId: '', cardStyle: C.textCardStyles[0].key, openedBy: null,
    pages: Object.fromEntries(C.pages.map(p => [p.code, { on: false, sched: false, time: '' }])) };

  // ---- 小工具 ----
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }
  Editor.onError = err => toast(({ not_image: '這不是圖片檔', too_big: '圖片太大（上限 30 MB）', bad_image: '讀不到這張圖片' })[err.message] || '載入圖片失敗');
  Editor.active = () => !overlay.hidden && state.mode === 'frame';
  const pad = n => String(n).padStart(2, '0');

  // ---- 外掛狀態 ----
  async function refreshExt() {
    const pill = $('extPill'), text = $('extText'), help = $('extHelp');
    const p = await Ext.ping(1500);
    if (!p.ok) { pill.className = 'pill bad'; text.textContent = '未偵測到外掛'; help.hidden = false; return; }
    help.hidden = true;
    const c = await Ext.cookies();
    const q = c.ok && Array.isArray(c.data) ? c.data.find(x => x.name === 'queen_session') : null;
    if (!q) { pill.className = 'pill warn'; text.textContent = '外掛已連線・尚未登入網新'; return; }
    const exp = q.expires === 'session' ? null : Date.parse(q.expires);
    const days = exp ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : null;
    pill.className = 'pill ok';
    text.textContent = '外掛已連線・' + (days === null ? '已登入' : `登入剩 ${days} 天`);
  }

  // ---- 標題行與字數 ----
  const lineEls = () => [...document.querySelectorAll('#lines .line')];
  const lineInputs = () => [...document.querySelectorAll('#lines .ln')];
  const getLines = () => lineInputs().map(i => i.value);
  function updateCounters() {
    const limits = Rules.limitsFor(state.template);
    $('limitNote').textContent = `每行上限 ${limits.join('／')}（全形 1、半形 0.5）`;
    lineEls().forEach((row, i) => {
      const v = row.querySelector('.ln').value, w = Rules.charWidth(v), lim = limits[i];
      row.querySelector('.cnt').textContent = `${w % 1 ? w.toFixed(1) : w}/${lim}`;
      row.classList.toggle('over', w > lim);
    });
    Editor.setGuideLines(getLines());
  }
  function setLines(lines) {
    const els = lineEls();
    if (lines.length > 3) lines = [lines[0], lines[1], lines.slice(2).join('')];   // 最多 3 行，多的併進第 3 行（會標紅提醒）
    lineInputs().forEach((inp, i) => { inp.value = lines[i] || ''; });
    const show3 = !!lines[2];
    if (show3) { els[2].hidden = false; $('addLineBtn').hidden = true; }
    updateCounters();
  }
  $('addLineBtn').addEventListener('click', () => { lineEls()[2].hidden = false; $('addLineBtn').hidden = true; lineInputs()[2].focus(); });
  $('lines').addEventListener('input', updateCounters);

  // ---- 版型 / 模式 ----
  function setActive(container, btn) { [...container.children].forEach(b => { if (b.tagName === 'BUTTON') b.classList.toggle('active', b === btn); }); }
  $('tplSwitch').addEventListener('click', e => {
    const b = e.target.closest('button[data-tpl]');
    if (!b) return;
    state.template = b.dataset.tpl;
    setActive($('tplSwitch'), b);
    Editor.setTemplate(state.template);
    updateCounters();
  });
  $('modeSwitch').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    setActive($('modeSwitch'), b);
    const text = state.mode === 'text';
    $('framePane').hidden = text; $('textPane').hidden = !text; $('titleBlock').hidden = text;
    if (text) drawTextCard();
  });
  $('guideToggle').addEventListener('change', e => Editor.showGuides(e.target.checked));
  $('pickBtn').addEventListener('click', () => $('fileInput').click());
  $('clearImgBtn').addEventListener('click', () => Editor.clearImage());
  Editor.onChange(() => { $('clearImgBtn').disabled = !Editor.hasImage(); });
  Editor.mountFxBar($('fxBar'));

  // ---- 純文字底圖（示意：實際以後端 /render_text_card 為準）----
  // 底色按 HSB 排序（QPT app.js 的 hexToHSB 與排序規則）
  function hexToHSB(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let hue = 0;
    if (delta !== 0) {
      if (max === r) hue = ((g - b) / delta) % 6; else if (max === g) hue = (b - r) / delta + 2; else hue = (r - g) / delta + 4;
      hue *= 60; if (hue < 0) hue += 360;
    }
    return { hue, saturation: max === 0 ? 0 : delta / max, brightness: max };
  }
  const NEUTRAL_SATURATION = 0.15, PINK_HUE_START = 320;
  const redFamilyHue = h => (h >= PINK_HUE_START ? h - 360 : h);
  const styles = C.textCardStyles.slice().sort((a, b) => {
    const ha = hexToHSB(a.bg), hb = hexToHSB(b.bg);
    const an = ha.saturation < NEUTRAL_SATURATION, bn = hb.saturation < NEUTRAL_SATURATION;
    if (an !== bn) return an ? -1 : 1;
    if (an) return ha.brightness - hb.brightness;
    return redFamilyHue(ha.hue) - redFamilyHue(hb.hue) || hb.saturation - ha.saturation;
  });
  const sw = $('swatches');
  styles.forEach(s => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw'; b.dataset.key = s.key; b.title = s.label; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', s.label);
    b.style.background = s.bg;
    b.setAttribute('aria-checked', String(s.key === state.cardStyle));
    b.addEventListener('click', () => { state.cardStyle = s.key; sw.querySelectorAll('.sw').forEach(x => x.setAttribute('aria-checked', String(x === b))); drawTextCard(); });
    sw.appendChild(b);
  });
  function drawTextCard() {
    const cv = $('textCanvas'), c = cv.getContext('2d'), st = C.textCardStyles.find(s => s.key === state.cardStyle);
    c.fillStyle = st.bg; c.fillRect(0, 0, cv.width, cv.height);
    const text = $('cardText').value.trim() || '在這裡輸入卡面文字';
    const size = 84, maxW = 900;
    c.font = `700 ${size}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif`;
    c.fillStyle = st.fg; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 12; c.shadowOffsetY = 4;
    const rows = [];
    text.split('\n').forEach(para => {
      let cur = '';
      for (const ch of para) { if (cur && c.measureText(cur + ch).width > maxW) { rows.push(cur); cur = ''; } cur += ch; }
      rows.push(cur);
    });
    const lh = size * 1.45, y0 = cv.height / 2 - (rows.length - 1) * lh / 2;
    rows.forEach((r, i) => c.fillText(r, cv.width / 2, y0 + i * lh));
    c.shadowColor = 'transparent';
  }
  $('cardText').addEventListener('input', drawTextCard);

  // ---- 快速帶入 ----
  const hint = (msg, cls) => { const h = $('urlHint'); h.textContent = msg || ''; h.className = 'hint' + (cls ? ' ' + cls : ''); };
  $('url').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); quickFill(); } });
  $('url').addEventListener('input', () => { state.articleId = Rules.articleId($('url').value); });
  $('fillBtn').addEventListener('click', quickFill);

  // page_meta 回傳格式未確認：接受常見欄位名，並看一層 data／meta／result
  function pickMeta(obj) {
    const pools = [obj, obj && obj.data, obj && obj.meta, obj && obj.result].filter(o => o && typeof o === 'object');
    const first = keys => { for (const o of pools) for (const k of keys) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim(); return ''; };
    return { title: first(['title', 'og_title', 'ogTitle']), image: first(['image', 'og_image', 'ogImage', 'hero']) };
  }
  function metaError(r) {
    if (!r.ok) return r.error === 'no_extension' ? '未偵測到外掛，無法帶入' : '外掛回報錯誤：' + r.error;
    const d = r.data || {};
    if (d.status === 401 || d.status === 403) return '沒有登入網新發文台，請先登入後再試';
    if (d.status === 404) return '後端找不到這個端點，請回報';
    if (d.status >= 400) return `後端回應 ${d.status}，請確認網址或稍後再試`;
    return '';
  }
  let filling = false;
  async function quickFill() {
    if (filling) return;
    const url = $('url').value.trim();
    state.articleId = Rules.articleId(url);
    if (!url) { hint('請先貼文章網址', 'bad'); return; }
    filling = true; $('fillBtn').disabled = true; hint('帶入中…');
    try {
      const r = await Ext.call('/page_meta?url=' + encodeURIComponent(url));
      const err = metaError(r);
      if (err) { hint(err, 'bad'); return; }
      const d = r.data;
      const raw = d.text != null ? d.text : d.snippet;
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { /* 不是 JSON */ }
      const meta = obj ? pickMeta(obj) : { title: '', image: '' };
      if (!meta.title && !meta.image) {
        hint(/<(!doctype|html)/i.test(raw || '') ? '後端回了網頁（可能被導去登入頁），請先登入網新發文台' : '讀不到標題或圖片（回應格式不認得），請手動填寫', 'bad');
        return;
      }
      if (meta.title) {
        if (state.mode === 'text') { if (!$('cardText').value) { $('cardText').value = meta.title; drawTextCard(); } }
        else setLines(Rules.overrideLines(meta.title));   // 與 QPT 相同：有換行照原樣，沒有才 breakTitle
      }
      let msg = '已帶入' + (meta.title ? '標題' : '') + (state.articleId ? `（文章 ${state.articleId}）` : ''), cls = 'ok';
      if (meta.image && state.mode === 'frame') {
        const im = await Ext.fetchImage(meta.image);
        if (im.ok && im.data && im.data.image) { try { await Editor.loadUrl(im.data.image); msg += '與主圖'; } catch (e) { msg += '，但主圖讀不出來'; cls = 'bad'; } }
        else { msg += '；主圖沒抓到（' + (im.error === 'host_not_allowed' ? '圖片網域不在允許範圍' : im.error === 'no_extension' ? '外掛沒回應，請更新外掛到 0.4.0 以上' : im.error) + '），請手動上傳'; cls = 'bad'; }
      }
      hint(msg, cls);
    } finally { filling = false; $('fillBtn').disabled = false; }
  }

  // ---- 粉專按鈕（送出之後再串接；現在只有狀態與介面）----
  const MIN_LEAD = C.ip.minLeadMinutes, DEF_LEAD = C.ip.defaultLeadMinutes;
  const fmtDate = d => `${d.getMonth() + 1}/${d.getDate()}`;
  const parseTime = (s, base) => {   // '2130' 或 '21:30' → Date（日期取 base）
    const m = /^(\d{1,2}):?(\d{2})$/.exec(s.trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return null;
    const d = new Date(base); d.setHours(+m[1], +m[2], 0, 0); return d;
  };
  const addMin = (d, n) => new Date(d.getTime() + n * 60000);
  const pgEls = {};
  function renderPage(code) {
    const st = state.pages[code], el = pgEls[code];
    el.root.classList.toggle('on', st.on);
    el.main.setAttribute('aria-pressed', String(st.on));
    el.box.textContent = st.on ? '✓' : '';
    el.mode.hidden = !st.on;
    el.mode.textContent = (st.sched ? `排程 ${st.time}` : '立即') + ' ▾';
  }
  C.pages.forEach(p => {
    const root = document.createElement('div'); root.className = 'pg';
    const main = document.createElement('button'); main.type = 'button';
    const box = document.createElement('span'); box.className = 'box';
    main.append(box, p.label);
    const mode = document.createElement('button'); mode.type = 'button'; mode.className = 'pg-mode'; mode.hidden = true;
    mode.setAttribute('aria-haspopup', 'menu');
    root.append(main, mode); $('pages').appendChild(root);
    pgEls[p.code] = { root, main, box, mode };
    main.addEventListener('click', () => { state.pages[p.code].on = !state.pages[p.code].on; closePops(); renderPage(p.code); });
    mode.addEventListener('click', e => { e.stopPropagation(); openMenu(p.code); });
    renderPage(p.code);
  });
  const menu = $('modeMenu'), pop = $('timePop');
  let popFor = null;
  function place(el, anchor) {
    const mr = modal.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    el.hidden = false;
    el.style.left = Math.max(8, Math.min(ar.left - mr.left, mr.width - el.offsetWidth - 8)) + 'px';
    el.style.top = (ar.top - mr.top - el.offsetHeight - 8) + 'px';
  }
  function closePops() { menu.hidden = true; pop.hidden = true; popFor = null; }
  function openMenu(code) {
    popFor = code; pop.hidden = true;
    const st = state.pages[code];
    menu.querySelectorAll('button').forEach(b => b.classList.toggle('cur', (b.dataset.m === 'sched') === st.sched));
    place(menu, pgEls[code].mode);
    menu.querySelector('button').focus();
  }
  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-m]');
    if (!b || !popFor) return;
    const code = popFor, st = state.pages[code];
    if (b.dataset.m === 'now') { st.sched = false; closePops(); renderPage(code); pgEls[code].mode.focus(); return; }
    st.sched = true;
    if (!st.time) { const d = addMin(new Date(), DEF_LEAD); d.setMinutes(Math.ceil(d.getMinutes() / 10) * 10, 0, 0); st.time = `${pad(d.getHours())}:${pad(d.getMinutes())}`; st.date = d; }
    renderPage(code); menu.hidden = true; openPop(code);
  });
  function openPop(code) {
    const st = state.pages[code];
    $('tpDate').textContent = fmtDate(st.date || new Date());
    $('tpTime').value = st.time;
    updateTimeHint(code);
    place(pop, pgEls[code].mode);
    $('tpTime').focus(); $('tpTime').select();
  }
  function updateTimeHint(code) {
    const st = state.pages[code], earliest = addMin(new Date(), MIN_LEAD);
    $('tpHint').textContent = `直接打 4 碼（2130＝21:30）・最早 ${pad(earliest.getHours())}:${pad(earliest.getMinutes())}（現在＋${MIN_LEAD} 分）`;
    const d = parseTime($('tpTime').value, st.date || new Date());
    $('tpHint').className = 'hint' + (d && d < earliest ? ' bad' : '');
  }
  $('tpTime').addEventListener('input', () => {
    const st = state.pages[popFor]; if (!st) return;
    const v = $('tpTime').value;
    const d = parseTime(v, st.date || new Date());
    if (d) { st.time = `${pad(d.getHours())}:${pad(d.getMinutes())}`; renderPage(popFor); }
    updateTimeHint(popFor);
  });
  $('tpTime').addEventListener('blur', () => { const st = state.pages[popFor]; if (st && st.time) $('tpTime').value = st.time; });
  $('tpTime').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const code = popFor; closePops(); if (code) pgEls[code].mode.focus(); } });
  pop.addEventListener('click', e => {
    const b = e.target.closest('button[data-add]');
    if (!b || !popFor) return;
    const st = state.pages[popFor];
    const base = parseTime(st.time, st.date || new Date()) || new Date();
    const d = addMin(base, +b.dataset.add);
    st.date = d; st.time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $('tpDate').textContent = fmtDate(d); $('tpTime').value = st.time;
    renderPage(popFor); updateTimeHint(popFor);
  });
  modal.addEventListener('mousedown', e => { if (!menu.hidden || !pop.hidden) if (!e.target.closest('.menu,.timepop,.pg-mode')) closePops(); });

  // ---- 開關彈窗 ----
  function isDirty() {
    return !!($('url').value.trim() || getLines().some(l => l.trim()) || $('caption').value.trim() || $('cardText').value.trim() || Editor.hasContent());
  }
  function resetAll() {
    $('url').value = ''; $('caption').value = ''; $('cardText').value = ''; hint('');
    state.articleId = '';
    lineInputs().forEach(i => { i.value = ''; });
    lineEls()[2].hidden = true; $('addLineBtn').hidden = false;
    Editor.reset();
    Object.values(state.pages).forEach(s => { s.on = false; s.sched = false; s.time = ''; delete s.date; });
    C.pages.forEach(p => renderPage(p.code));
    closePops(); updateCounters(); drawTextCard();
  }
  function openModal() {
    state.openedBy = document.activeElement;
    overlay.hidden = false; document.body.classList.add('locked');
    updateCounters();
    $('url').focus();
  }
  function closeModal() {
    $('confirm').hidden = true; overlay.hidden = true; document.body.classList.remove('locked');
    resetAll();
    if (state.openedBy && state.openedBy.focus) state.openedBy.focus();
  }
  function requestClose() {
    if (!isDirty()) { closeModal(); return; }
    $('confirm').hidden = false; $('cfStay').focus();
  }
  $('newBtn').addEventListener('click', openModal);
  $('closeBtn').addEventListener('click', requestClose);
  $('cfStay').addEventListener('click', () => { $('confirm').hidden = true; $('closeBtn').focus(); });
  $('cfLeave').addEventListener('click', closeModal);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) requestClose(); });

  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!$('confirm').hidden) { $('confirm').hidden = true; return; }
      if (!menu.hidden || !pop.hidden) { const c = popFor; closePops(); if (c) pgEls[c].mode.focus(); return; }
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const scope = !$('confirm').hidden ? $('confirm') : modal;   // 焦點鎖在彈窗（確認視窗開著時鎖在確認視窗）
    const f = [...scope.querySelectorAll('a[href],button,input,textarea,select,[tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && !el.closest('[hidden]') && el.offsetParent !== null && el.type !== 'file');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!scope.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  Editor.setTemplate(state.template);
  updateCounters(); drawTextCard();
  window.App = { state, getLines, setLines };   // 後續 PR 與測試用
  refreshExt();
  setTimeout(() => { if ($('extPill').className === 'pill') refreshExt(); }, 2500);
})();
