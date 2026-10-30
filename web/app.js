// 正式介面。PR A：外殼＋新增發文彈窗＋作圖框＋快速帶入；PR B：圖床上傳、後端預覽、AI 小編文、守則判讀、兩段式送出、本機紀錄；
// PR C：送出紀錄列表（web/reclist.js）、從紀錄複製到新增發文。
(function () {
  const $ = id => document.getElementById(id);
  const C = window.NEWSNET_CONFIG;
  const overlay = $('overlay'), modal = $('modal');
  const state = { mode: 'frame', frame: 'news', articleId: '', summary: '', cardStyle: C.textCardStyles[0].key, openedBy: null,
    // 每台：on 勾選、sched 排程（at 為時間）、status ''｜sending｜ok｜fail、result 送出結果
    pages: Object.fromEntries(C.pages.map(p => [p.code, { on: false, sched: false, at: null, status: '', result: null }])) };

  // ---- 小工具 ----
  let toastTimer = 0;
  // action：{ label, fn }＝失敗時原地「重試」；有按鈕就停久一點
  function toast(msg, action) {
    const t = $('toast'), text = document.createElement('span');
    text.textContent = msg;
    t.replaceChildren(text);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label || '重試';
      b.addEventListener('click', () => { t.hidden = true; clearTimeout(toastTimer); action.fn(); });
      t.append(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3500);
  }
  const hideToast = () => { clearTimeout(toastTimer); $('toast').hidden = true; };
  Editor.onError = err => toast(({ not_image: '這不是圖片檔', too_big: '圖片太大（上限 30 MB）', bad_image: '讀不到這張圖片' })[err.message] || '載入圖片失敗');
  Editor.active = () => !overlay.hidden && state.mode === 'frame';
  const pad = n => String(n).padStart(2, '0');

  // ---- 外掛狀態 ----
  async function refreshExt() {
    const pill = $('extPill'), text = $('extText');
    const p = await Ext.ping(1500);
    if (!p.ok) { pill.className = 'pill bad'; text.textContent = '未偵測到外掛'; return false; }
    const c = await Ext.cookies();
    const q = c.ok && Array.isArray(c.data) ? c.data.find(x => x.name === 'queen_session') : null;
    if (!q) { pill.className = 'pill warn'; text.textContent = '外掛已連線・尚未登入網新'; return; }
    const exp = q.expires === 'session' ? null : Date.parse(q.expires);
    const days = exp ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : null;
    pill.className = 'pill ok';
    text.textContent = '外掛已連線・' + (days === null ? '已登入' : `登入剩 ${days} 天`);
    return true;
  }
  // 嵌在外掛側邊欄裡（iframe）：外掛一定已經裝好，不顯示「安裝插件」，也不自動跳安裝教學
  const inPanel = window.self !== window.top;
  if (inPanel) document.documentElement.classList.add('in-panel');
  // 首次載入：偵測不到外掛（再等一下重試一次，外掛的橋接可能晚一點才注入）就打開安裝教學；手機不能裝 Chrome 擴充功能，不跳
  async function checkExtOnLoad() {
    if (await refreshExt()) return;
    await new Promise(r => setTimeout(r, 1500));
    if (await refreshExt()) return;
    if (inPanel || /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent) || !overlay.hidden || Deploy.isOpen()) return;
    Deploy.open();
  }

  // ---- 標題：一個輸入框、一行一句（作圖框與純文字底圖共用）；每行字數顯示在框外右側 ----
  const titleEl = $('title');
  const tpl = () => Rules.frameTemplate(state.frame);
  const rows = () => titleEl.value.replace(/\r/g, '').split('\n');
  const getLines = () => rows().map(l => l.trim()).filter(Boolean);   // 送出／判讀／預覽用：去掉空行
  function updateCounters() {
    const limits = Rules.limitsFor(tpl());
    $('limitNote').textContent = `每行上限 ${limits.join('／')}（全形 1、半形 0.5），最多 ${limits.length} 行`;
    const rs = rows();
    titleEl.rows = Math.max(3, rs.length);
    let n = 0, bad = false;
    const spans = rs.map(r => {
      const el = document.createElement('span');
      if (!r.trim()) return el;               // 空行：不算一行，計數留白
      const w = Rules.charWidth(r.trim()), lim = limits[n++];
      const over = lim === undefined || w > lim;   // 第 4 行起一律標紅
      el.textContent = `${w % 1 ? w.toFixed(1) : w}/${lim === undefined ? '—' : lim}`;
      if (lim === undefined) el.title = `標題最多 ${limits.length} 行`;
      el.classList.toggle('over', over);
      bad = bad || over;
      return el;
    });
    $('titleCnts').replaceChildren(...spans);
    titleEl.classList.toggle('over', bad);
    titleEl.setAttribute('aria-invalid', String(bad));
    Editor.setTitleLines(getLines());
    if (state.mode === 'text') drawTextCard();
    const ds = Rundown.defaultSlug(getLines());
    $('slug').placeholder = ds ? `空白＝${ds}（標題前 4 字）` : '空白＝標題前 4 字';
  }
  function setLines(lines) { titleEl.value = lines.join('\n'); updateCounters(); }
  titleEl.addEventListener('input', updateCounters);

  // ---- 小編文的【標題】那一行跟著標題框走（QPT 的 learnSeps／titleAsOneLine：沒改過的相鄰兩行照文章原本的接法，新的用空格接）----
  // auto：上次自動填進去的小編文（之後自動改【標題】、AI 產生也會跟著更新）；小編自己改過就對不上，帶入時不覆蓋
  // ai：上次 AI 產生、放在最上面的文字（再按一次 AI 產生就換掉它，不會疊兩份）；title：上次同步進【】的標題
  const cap = { auto: '', ai: '', title: null };
  Article.bindTitle(titleEl);
  function syncCaptionTitle() {
    const el = $('caption'), t = Article.titleAsOneLine();
    const r = Article.replaceTitleLine(el.value, t, cap.title);
    if (r.index < 0) return;   // 小編把【…】那一行刪掉了：不再補回來
    cap.title = t;
    if (r.text === el.value) return;
    if (el.value === cap.auto) cap.auto = r.text;
    el.value = r.text;
  }
  titleEl.addEventListener('input', syncCaptionTitle);

  // ---- 版型 / 模式 ----
  function setActive(container, btn) { [...container.children].forEach(b => { if (b.tagName === 'BUTTON') b.classList.toggle('active', b === btn); }); }
  // 新聞（藍框）／娛樂（粉框）：只決定預覽的疊圖與送給後端的 template（所有勾選的粉專都用同一個）
  function setFrame(frame) {
    state.frame = frame === 'ent' ? 'ent' : 'news';
    setActive($('frameSwitch'), $('frameSwitch').querySelector(`[data-frame="${state.frame}"]`));
    Editor.setFrame(state.frame);
    updateCounters(); flowEdit();
  }
  function setMode(mode) {
    state.mode = mode === 'text' ? 'text' : 'frame';
    setActive($('modeSwitch'), $('modeSwitch').querySelector(`[data-mode="${state.mode}"]`));
    const text = state.mode === 'text';
    $('framePane').hidden = text; $('textPane').hidden = !text;   // 右欄（網址、標題、小編文）兩種模式共用，內容不清
    if (text) drawTextCard();
    flowEdit();
  }
  $('frameSwitch').addEventListener('click', e => { const b = e.target.closest('button[data-frame]'); if (b) setFrame(b.dataset.frame); });
  $('modeSwitch').addEventListener('click', e => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('clearImgBtn').addEventListener('click', () => Editor.clearImage());
  Editor.onChange(() => { $('clearImgBtn').hidden = !Editor.hasImage(); });
  Editor.mountFxBar($('fxBar'), $('fxBtn'));

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
    b.addEventListener('click', () => setCardStyle(s.key));
    sw.appendChild(b);
  });
  // 色票一行排不下就左右滑：觸控板／手機原生可滑，滑鼠滾輪轉成水平捲動
  sw.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || sw.scrollWidth <= sw.clientWidth) return;
    e.preventDefault(); sw.scrollLeft += e.deltaY;
  }, { passive: false });
  function setCardStyle(key) {
    if (!C.textCardStyles.some(s => s.key === key)) return;
    state.cardStyle = key;
    sw.querySelectorAll('.sw').forEach(x => x.setAttribute('aria-checked', String(x.dataset.key === key)));
    const cur = sw.querySelector(`.sw[data-key="${key}"]`);
    if (cur && sw.clientWidth) {   // 只捲色票列本身，不動到整頁
      const l = cur.offsetLeft - sw.offsetLeft, r = l + cur.offsetWidth;
      if (l < sw.scrollLeft) sw.scrollLeft = l - 8; else if (r > sw.scrollLeft + sw.clientWidth) sw.scrollLeft = r - sw.clientWidth + 8;
    }
    drawTextCard(); flowEdit();
  }
  // 後端 /render_text_card 實測（font: hanwang＝WHZ-Heavy）：76px、行距 110（76×1.45）、一行最多 11 個全形字、
  // 整塊置中在 y≈524（不論幾行）、深色陰影右下偏移約 5px、底部白色 wordmark（從後端圖裁下，位置 476,955）
  const TC = { px: 76, lineH: 110, maxW: 880, centerY: 524, baseOff: 23, shadow: 'rgba(0,0,0,.85)', blur: 5, off: 5, wordmarkAt: [476, 955] };
  const wordmark = new Image();
  wordmark.onload = () => drawTextCard();
  wordmark.src = 'frames/wordmark_newsnet.png';
  if (document.fonts) document.fonts.load(`${TC.px}px "WHZ-Heavy"`).then(() => drawTextCard(), () => {});
  function drawTextCard() {
    const cv = $('textCanvas'), c = cv.getContext('2d'), st = C.textCardStyles.find(s => s.key === state.cardStyle);
    c.fillStyle = st.bg; c.fillRect(0, 0, cv.width, cv.height);
    const text = getLines().join('\n') || '在右邊輸入標題';   // 卡面文字＝標題（照輸入框的分行）
    c.font = `${TC.px}px "WHZ-Heavy","Microsoft JhengHei",sans-serif`;
    c.fillStyle = st.fg; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.shadowColor = TC.shadow; c.shadowBlur = TC.blur; c.shadowOffsetX = TC.off; c.shadowOffsetY = TC.off;
    const rows = [];
    text.split('\n').forEach(para => {
      let cur = '';
      for (const ch of para) { if (cur && c.measureText(cur + ch).width > TC.maxW) { rows.push(cur); cur = ''; } cur += ch; }
      rows.push(cur);
    });
    const y0 = TC.centerY - (rows.length - 1) * TC.lineH / 2 + TC.baseOff;
    rows.forEach((r, i) => c.fillText(r, cv.width / 2, y0 + i * TC.lineH));
    c.shadowColor = 'transparent'; c.shadowOffsetX = c.shadowOffsetY = 0;
    if (wordmark.complete && wordmark.naturalWidth) c.drawImage(wordmark, TC.wordmarkAt[0], TC.wordmarkAt[1]);
  }

  // ---- 快速帶入 ----
  const hint = (msg, cls) => { const h = $('urlHint'); h.textContent = msg || ''; h.className = 'hint' + (cls ? ' ' + cls : ''); };
  $('url').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); quickFill(); } });
  $('url').addEventListener('input', () => { state.articleId = Rules.articleId($('url').value); });
  $('fillBtn').addEventListener('click', quickFill);
  // 貼上網址就直接帶入（等貼上的值寫進欄位後再讀）
  $('url').addEventListener('paste', () => setTimeout(() => { if (/^https?:\/\/\S+$/i.test($('url').value.trim())) quickFill(); }, 0));

  // page_meta 回傳格式未確認：接受常見欄位名，並看一層 data／meta／result
  function pickMeta(obj) {
    const pools = [obj, obj && obj.data, obj && obj.meta, obj && obj.result].filter(o => o && typeof o === 'object');
    const first = keys => { for (const o of pools) for (const k of keys) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim(); return ''; };
    return { title: first(['title', 'og_title', 'ogTitle']), image: first(['image', 'og_image', 'ogImage', 'hero']),
      summary: first(['description', 'og_description', 'ogDescription', 'summary']) };   // 摘要給 AI 產生小編文用
  }
  function metaError(r) {
    if (!r.ok) return r.error === 'no_extension' ? '未偵測到外掛，無法帶入' : '外掛回報錯誤：' + r.error;
    const d = r.data || {};
    if (d.status === 401 || d.status === 403) return '沒有登入網新發文台，請先登入後再試';
    if (d.status === 404) return '後端找不到這個端點，請回報';
    if (d.status >= 400) return `後端回應 ${d.status}，請確認網址或稍後再試`;
    return '';
  }
  // 帶入時標題、小編文、圖片先放骨架（灰底 shimmer），各自拿到結果就拿掉
  function skel(el, on) { el.classList.toggle('is-skel', on); if (el.tagName === 'TEXTAREA') el.readOnly = on; el.setAttribute('aria-busy', String(on)); }
  const skelEls = () => [$('title'), $('caption'), $('canvasWrap')];
  let filling = false;
  async function quickFill() {
    if (filling) return;
    const url = $('url').value.trim();
    state.articleId = Rules.articleId(url);
    if (!url) { hint('請先貼文章網址', 'bad'); return; }
    filling = true; $('fillBtn').disabled = true; hint('帶入中…'); hideToast();
    const capCur = $('caption').value;
    skel($('title'), true); skel($('canvasWrap'), true);
    if (!capCur.trim() || capCur === cap.auto) skel($('caption'), true);
    const fail = msg => { hint(msg, 'bad'); toast('帶入失敗', { label: '重試', fn: quickFill }); };
    try {
      const artP = Ext.fetchArticle(url);   // 和 page_meta 同時抓：小編文的圖說與 hashtag 從文章網頁解析（同 QPT）
      const r = await Ext.call('/page_meta?url=' + encodeURIComponent(url));
      const err = metaError(r);
      if (err) { fail(err); return; }
      const d = r.data;
      const raw = d.text != null ? d.text : d.snippet;
      let obj = null;
      try { obj = JSON.parse(raw); } catch (e) { /* 不是 JSON */ }
      const meta = obj ? pickMeta(obj) : { title: '', image: '' };
      if (!meta.title && !meta.image) {
        fail(/<(!doctype|html)/i.test(raw || '') ? '後端回了網頁（可能被導去登入頁），請先登入網新發文台' : '讀不到標題或圖片（回應格式不認得），請手動填寫');
        return;
      }
      state.summary = meta.summary || '';
      if (meta.title) {   // 與 QPT 相同：有換行照原樣，沒有才 breakTitle；兩種模式共用
        const lines = Rules.overrideLines(meta.title);
        Article.learnSeps(Article.overrideOneLine(meta.title), lines);   // 小編文的【標題】接回原標題的樣子
        setLines(lines);
        syncCaptionTitle();
      }
      skel($('title'), false);
      let msg = '已帶入' + (meta.title ? '標題' : '') + (state.articleId ? `（文章 ${state.articleId}）` : ''), cls = 'ok';
      const imP = meta.image ? Ext.fetchImage(meta.image) : null;
      if (meta.image) {   // 不論目前是作圖框或純文字底圖都先載入主圖，之後切到作圖框不用再按一次帶入
        const im = await imP;
        if (im.ok && im.data && im.data.image) { try { await Editor.loadUrl(im.data.image); msg += state.mode === 'frame' ? '與主圖' : '與主圖（切到作圖框即可使用）'; } catch (e) { msg += '，但主圖讀不出來'; cls = 'bad'; } }
        else { msg += '；主圖沒抓到（' + (im.error === 'host_not_allowed' ? '圖片網域不在允許範圍' : im.error === 'no_extension' ? '外掛沒回應，請更新外掛到 0.4.0 以上' : im.error) + '），請手動上傳'; cls = 'bad'; }
      }
      skel($('canvasWrap'), false);
      const c = await fillCaption(artP, url);
      hint(msg + '；' + c.msg, c.bad ? 'bad' : cls);
      flowEdit();
    } finally { filling = false; $('fillBtn').disabled = false; skelEls().forEach(el => skel(el, false)); }
  }

  // 帶入的小編文＝QPT 的圖文格式：【標題】／圖說（例：（圖／TVBS））／#標籤 #標籤 #標籤。
  // 圖說與 hashtag 從文章網頁解析（外掛 fetchArticle 下載、Article.parseArticle 解析）；小編改過就不覆蓋，只更新【標題】那一行。
  async function fillCaption(artP, url) {
    const res = await artP;
    let art = null, old = false, fail = '';
    if (res.ok && res.data && typeof res.data.html === 'string') {
      try { art = Article.parseArticle(res.data.html, res.data.url || url); } catch (e) { fail = '文章網頁讀不懂'; }
    } else if (/^(unknown_op|no_extension|empty_response)$/.test(res.error)) old = true;
    else fail = `文章網頁沒抓到（${({ host_not_allowed: '網址不是 tvbs.com.tw', not_html: '不是網頁', too_big: '網頁太大', timeout: '逾時' })[res.error] || res.error}）`;
    const caption = art ? Article.mainCaption(art) : '', tags = art ? art.tags : [];
    const notes = [];
    if (art && !caption) notes.push('沒抓到圖說');
    if (art && !Article.pickTags(tags).length) notes.push('沒抓到 2～3 字的 hashtag');
    const el = $('caption'), cur = el.value;
    const fill = !cur.trim() || cur === cap.auto;
    if (fill) {
      const t = Article.titleAsOneLine();
      el.value = cap.auto = Article.formatCopy({ title: t, caption, tags });
      cap.ai = ''; cap.title = t;
    } else syncCaptionTitle();
    let msg = fill ? (art ? '小編文已帶入' + (notes.length ? `，但${notes.join('、')}` : '標題、圖說、hashtag') : '小編文只帶入標題')
      : '小編文已改過，沒有覆蓋（只更新【標題】那一行）';
    if (old) msg += '・外掛版本太舊，請更新到 0.6.0 才能帶入圖說與 hashtag';
    else if (fail) msg += '・' + fail;
    return { msg, bad: old || !!fail };
  }

  // ---- 粉專按鈕：點名稱勾選；▾ 選立即／排程（排程才開時間視窗）----
  const now = () => new Date();
  const labelOf = code => Rules.pageByCode(code).label;
  const pgEls = {};
  function renderPage(code) {
    const st = state.pages[code], el = pgEls[code];
    const done = st.status === 'ok', fail = st.status === 'fail', busy = st.status === 'sending';
    el.root.classList.toggle('on', st.on && !done && !fail);
    el.root.classList.toggle('done', done); el.root.classList.toggle('fail', fail); el.root.classList.toggle('busy', busy);
    el.main.setAttribute('aria-pressed', String(st.on));
    el.main.disabled = done || busy;
    el.box.textContent = st.on ? '✓' : '';
    el.mode.hidden = !st.on;
    el.mode.disabled = busy;
    el.retry.hidden = !fail;
    el.mode.title = fail && st.result ? st.result.error : '';
    if (done) el.mode.textContent = st.sched ? `✓ 排程 ${Sched.fmtWhen(st.at, now())}` : '✓ 已發布' + (st.result && st.result.link ? ' ↗' : '');
    else if (fail) el.mode.textContent = '✗ 失敗 ▾';
    else if (busy) el.mode.textContent = '送出中…';
    else el.mode.textContent = (st.sched && st.at ? `排程 ${Sched.fmtWhen(st.at, now())}` : '立即') + ' ▾';
  }
  C.pages.forEach(p => {
    const root = document.createElement('div'); root.className = 'pg';
    const main = document.createElement('button'); main.type = 'button';
    const box = document.createElement('span'); box.className = 'box';
    main.append(box, p.label);
    const mode = document.createElement('button'); mode.type = 'button'; mode.className = 'pg-mode'; mode.hidden = true;
    mode.setAttribute('aria-haspopup', 'menu');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'retry'; retry.hidden = true;
    retry.textContent = '↻ 重送'; retry.setAttribute('aria-label', `重送${p.label}`);
    root.append(main, mode, retry); $('pages').appendChild(root);
    pgEls[p.code] = { root, main, box, mode, retry };
    main.addEventListener('click', () => {
      const st = state.pages[p.code];
      st.on = !st.on; st.status = ''; st.result = null;
      closePops(); renderPage(p.code); flowEdit();
      if (st.on) schedulePreGuard(PRE_GUARD_PAGE_MS);   // 勾粉專通常是最後一步：1 秒就先判
    });
    mode.addEventListener('click', e => {
      e.stopPropagation();
      const st = state.pages[p.code];
      if (st.status === 'ok') { if (!st.sched && st.result && st.result.link) window.open(st.result.link, '_blank', 'noopener'); return; }   // 排程的貼文還沒上線，不開連結
      openMenu(p.code);
    });
    retry.addEventListener('click', () => resend(p.code));
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
    if (b.dataset.m === 'now') { st.sched = false; closePops(); renderPage(code); flowEdit(); pgEls[code].mode.focus(); return; }
    st.sched = true;
    if (!st.at || Sched.validate(st.at, now())) st.at = Sched.defaultAt(now());   // 預填 現在＋30 分
    renderPage(code); flowEdit(); menu.hidden = true; openPop(code);
  });

  // 時間視窗：日期預設今天（可改，最多到 3 天後）；時間直接打 4 碼（2130→21:30），↑↓ ±10 分
  function openPop(code) {
    const st = state.pages[code], n = now();
    $('tpDate').min = Sched.fmtDateInput(n); $('tpDate').max = Sched.fmtDateInput(Sched.latest(n));
    $('tpDate').value = Sched.fmtDateInput(st.at);
    $('tpTime').value = Sched.fmtTime(st.at);
    updateTimeHint();
    place(pop, pgEls[code].mode);
    $('tpTime').focus(); $('tpTime').select();
  }
  function updateTimeHint() {
    const n = now(), at = Sched.combine($('tpDate').value, $('tpTime').value), err = Sched.validate(at, n);
    $('tpHint').textContent = err ? err.msg : `排程 ${Sched.fmtWhen(at, n)}・直接打 4 碼（2130＝21:30），↑↓ 每次 10 分`;
    $('tpHint').className = 'hint ' + (err ? 'bad' : 'ok');
    $('tpTime').setAttribute('aria-invalid', String(!!err));
    return !err;
  }
  function setAt(at) {   // 由按鍵／快捷鈕改時間：兩個欄位一起更新
    const st = state.pages[popFor]; if (!st) return;
    st.at = at;
    $('tpDate').value = Sched.fmtDateInput(at); $('tpTime').value = Sched.fmtTime(at);
    renderPage(popFor); flowEdit(); updateTimeHint();
  }
  function takeInputs() {   // 由打字／選日期改時間：合法的時間才寫回（超出範圍也寫，送出前會擋並在視窗裡標紅）
    const st = state.pages[popFor]; if (!st) return;
    const at = Sched.combine($('tpDate').value, $('tpTime').value);
    if (at) { st.at = at; renderPage(popFor); flowEdit(); }
    updateTimeHint();
  }
  $('tpTime').addEventListener('input', () => {
    const v = Sched.formatTyping($('tpTime').value);
    if (v !== $('tpTime').value) $('tpTime').value = v;
    takeInputs();
  });
  $('tpDate').addEventListener('change', takeInputs);
  $('tpTime').addEventListener('blur', () => { const st = state.pages[popFor]; if (st && st.at) $('tpTime').value = Sched.fmtTime(st.at); });
  $('tpTime').addEventListener('keydown', e => {
    const st = state.pages[popFor]; if (!st) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setAt(Sched.step(Sched.combine($('tpDate').value, $('tpTime').value) || st.at, e.key === 'ArrowUp' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!updateTimeHint()) return;   // 不合法：留在視窗裡，提示已標紅
      const code = popFor; closePops(); pgEls[code].mode.focus();
    }
  });
  pop.addEventListener('click', e => {
    const b = e.target.closest('button[data-add]');
    if (!b || !popFor) return;
    const st = state.pages[popFor];
    setAt(new Date((Sched.combine($('tpDate').value, $('tpTime').value) || st.at).getTime() + b.dataset.add * 60000));
  });
  modal.addEventListener('mousedown', e => { if (!menu.hidden || !pop.hidden) if (!e.target.closest('.menu,.timepop,.pg-mode')) closePops(); });

  // ---- 圖床：預覽與送出共用同一次上傳（照片／貼圖沒變就不重傳）----
  // 背景預先上傳：照片／貼圖停手 PRE_UPLOAD_MS 後就先傳（已登入圖床或免密碼模式才傳，不跳登入視窗），送出時直接用
  const PRE_UPLOAD_MS = 1500, URL_MARGIN_MS = 10 * 60000;
  let editorVer = 0, upCache = null, upPending = null, preTimer = 0;
  const cacheOk = () => upCache && upCache.ver === editorVer && !(upCache.exp && Date.parse(upCache.exp) - Date.now() < URL_MARGIN_MS);
  function uploadNow(silent) {
    const ver = editorVer;
    if (upPending && upPending.ver === ver) return upPending.p;
    const p = Editor.exportBlob()
      .then(blob => (silent ? ImgHost.upload(blob) : ImgHost.ensureUpload(blob)))
      .then(d => { if (ver === editorVer) upCache = { ver, url: d.url, exp: d.expiresAt || '' }; return d.url; })
      .finally(() => { if (upPending && upPending.p === p) upPending = null; });
    upPending = { ver, p };
    return p;
  }
  async function ensureUploaded() {
    if (cacheOk()) return upCache.url;
    if (upPending && upPending.ver === editorVer) {
      try { return await upPending.p; } catch (e) { /* 背景那次失敗：下面正式再傳一次（需要時跳登入） */ }
      if (cacheOk()) return upCache.url;
    }
    return uploadNow(false);
  }
  function schedulePreUpload() {
    clearTimeout(preTimer);
    preTimer = setTimeout(() => {
      if (overlay.hidden || state.mode === 'text' || !Editor.hasImage() || !(ImgHost.session() || ImgHost.passwordFree()) || cacheOk()) return;
      uploadNow(true).catch(() => { /* 背景失敗不打擾；送出時會再傳並顯示原因 */ });
    }, PRE_UPLOAD_MS);
  }
  function renderImgPill() {
    const s = ImgHost.session(), free = ImgHost.passwordFree();   // 免密碼模式：不用登入，顯示已連線
    $('imgPill').className = 'pill img-pill ' + (s || free ? 'ok' : 'warn');
    $('imgText').textContent = free ? '圖床已連線' : s ? '圖床已登入' : '圖床未登入';
    $('imgPill').setAttribute('aria-label', $('imgText').textContent);
  }
  ImgHost.onChange(renderImgPill);
  $('imgPill').addEventListener('click', () => ImgHost.prompt().catch(() => {}));
  renderImgPill();
  setInterval(renderImgPill, 60000);

  // ---- 後端預覽（/render、/render_text_card）----
  let previewKey = '', previewing = false;
  const previewHint = (msg, cls) => { $('bePrevHint').textContent = msg || ''; $('bePrevHint').className = 'hint' + (cls ? ' ' + cls : ''); };
  const previewKeyNow = () => JSON.stringify([Payload.previewRequest(Object.assign(currentInput(), { imageUrl: '' })), state.mode === 'text' ? 0 : editorVer]);
  function markPreviewStale() {
    if (!$('bePrev').hidden && previewKey && !previewing && previewKey !== previewKeyNow()) previewHint('內容已改，按「後端預覽」更新', 'bad');
  }
  async function preview() {
    if (previewing) return;
    const input = currentInput();
    if (input.mode === 'single' && !input.hasImage) { toast('需要照片'); return; }
    if (input.mode === 'text_card' && !input.cardText.trim()) { toast('請填文字內容'); return; }
    previewing = true; $('previewBtn').disabled = $('previewTextBtn').disabled = true;
    $('bePrev').hidden = false;
    const tplName = $('frameSwitch').querySelector('.active').textContent;
    $('bePrevCap').textContent = input.mode === 'single' ? `後端產圖・${tplName}` : '後端產圖・純文字底圖';
    try {
      const key = previewKeyNow();
      if (input.mode === 'single') {
        previewHint('上傳圖片到圖床…');
        try { input.imageUrl = await ensureUploaded(); } catch (e) { previewHint(e.message, 'bad'); return; }
      }
      previewHint('後端產圖中…');
      const rq = Payload.previewRequest(input);
      const res = SendFlow.apiResult(await Ext.call(rq.path, 'POST', rq.body));
      if (!res.ok || !res.image) { previewHint(res.error || '後端沒有回圖', 'bad'); $('bePrevImg').hidden = true; toast('後端預覽失敗', { label: '重試', fn: preview }); return; }
      $('bePrevImg').src = res.image; $('bePrevImg').hidden = false;
      previewKey = key;
      previewHint(previewKey === previewKeyNow() ? '' : '內容已改，按「後端預覽」更新', previewKey === previewKeyNow() ? '' : 'bad');
    } finally {
      previewing = false; $('previewBtn').disabled = false; $('previewTextBtn').disabled = false;
    }
  }
  $('previewBtn').addEventListener('click', preview);
  $('previewTextBtn').addEventListener('click', preview);
  $('bePrevClose').addEventListener('click', () => { $('bePrev').hidden = true; previewKey = ''; });

  // ---- AI 小編文（/ai_caption：generate 產生、proofread 校錯字）----
  const capHint = (msg, cls) => { $('capHint').textContent = msg || ''; $('capHint').className = 'hint' + (cls ? ' ' + cls : ''); };
  async function aiCaption(kind) {
    const input = currentInput(), body = Payload.aiCaptionBody(kind, input);
    if (kind === 'generate' && !body.title) { capHint('請先填標題', 'bad'); return; }
    if (kind === 'proofread' && !body.text.trim()) { capHint('請先寫小編文', 'bad'); return; }
    $('aiGenBtn').disabled = $('aiFixBtn').disabled = true;
    capHint(kind === 'generate' ? 'AI 產生中…' : '校對中…');
    const before = $('caption').value;
    try {
      const res = SendFlow.apiResult(await Ext.call('/ai_caption', 'POST', body));
      if (!res.ok) { capHint(res.error, 'bad'); toast(kind === 'generate' ? 'AI 產生失敗' : '校錯字失敗', { label: '重試', fn: () => aiCaption(kind) }); return; }
      const { text, hashtags, note } = Payload.aiCaptionResult(res.json || SendFlow.parseJson(res.text));
      if (!text) { capHint(note || 'AI 回應格式不認得，請手動撰寫', 'bad'); return; }
      if ($('caption').value !== before) { capHint('等待期間小編文被改過，沒有套用 AI 結果', 'bad'); return; }
      if (kind === 'proofread' && text === before.trim()) { capHint('沒有找到錯字', 'ok'); return; }
      if (kind === 'generate') {   // AI 文字放最上面：上次 AI 產生的還在最上面就換掉，否則加在最前面；下面的【標題】、圖說、hashtag 不動
        const rest = cap.ai && (before === cap.ai || before.startsWith(cap.ai + '\n')) ? before.slice(cap.ai.length + 1) : before;
        const next = Payload.mergeHashtags(rest ? text + '\n' + rest : text, hashtags);
        if (before === cap.auto) cap.auto = next;
        cap.ai = text;
        $('caption').value = next;
      } else $('caption').value = text;
      flowEdit();
      capHint((kind === 'generate' ? '已產生（放在最上面），可以直接修改' : '已套用校對結果，請再看一次') + (note ? `（AI 備註：${note}）` : ''), 'ok');
    } finally { $('aiGenBtn').disabled = $('aiFixBtn').disabled = false; }
  }
  $('aiGenBtn').addEventListener('click', () => aiCaption('generate'));
  $('aiFixBtn').addEventListener('click', () => aiCaption('proofread'));

  // ---- 全部送出（兩段式）：第 1 次自動判讀＋泡泡列出各台，第 2 次才逐台送 ----
  const flow = { state: 'idle', seq: 0, key: '', guard: null, ack: false, targets: [], recordId: '' };
  const sendBtn = $('sendBtn'), bub = $('bubble');
  function currentInput() {
    const card = state.mode === 'text';
    const lines = getLines();
    return { mode: card ? 'text_card' : 'single', frame: state.frame, lines, caption: $('caption').value,
      url: $('url').value.trim(), cardText: lines.join('\n'), cardStyle: state.cardStyle, summary: state.summary, hasImage: Editor.hasImage() };
  }
  const pending = () => C.pages.filter(p => state.pages[p.code].on && state.pages[p.code].status !== 'ok').map(p => p.code);
  const targetOf = code => { const st = state.pages[code]; return { code, at: st.sched ? st.at : null }; };
  const sendMsg = (msg, cls) => { $('sendMsg').textContent = msg; $('sendMsg').className = 'guard ' + (cls || 'muted'); };
  const setFlow = ev => { flow.state = SendFlow.next(flow.state, ev); renderFlow(); };
  const bubbleNow = () => SendFlow.bubble({ targets: flow.targets.map(targetOf), guard: flow.guard, ack: flow.ack, now: now() });

  function renderFlow() {
    const s = flow.state, list = pending(), unsent = list.filter(c => !state.pages[c].status);
    sendBtn.hidden = s === 'done' && !unsent.length;
    sendBtn.classList.toggle('arm', s === 'armed');
    sendBtn.textContent = s === 'checking' ? '判讀中…' : s === 'sending' ? '送出中…' : s === 'armed' ? '確認送出' : '全部送出' + (list.length ? `（${list.length} 台）` : '');
    sendBtn.disabled = s === 'checking' || s === 'sending' || (s !== 'armed' && !list.length);
    $('sendTip').hidden = sendBtn.hidden || !/^(idle|done)$/.test(s) || list.length > 0;
    $('clearBtn').hidden = !C.pages.some(p => /^(ok|fail)$/.test(state.pages[p.code].status));
    renderBubble();
  }
  const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function renderBubble() {
    if (flow.state !== 'armed') { bub.hidden = true; return; }
    const b = bubbleNow();
    bub.replaceChildren();
    bub.append(make('b', 'bub-title', b.title));
    const table = make('table');
    b.rows.forEach(r => {
      const tr = make('tr');
      const light = make('td', 'lt'); light.append(make('i', 'l ' + (b.level || 'none')));
      const when = make('td', null, r.when);
      if (r.error) when.append(make('div', 'err', r.error));
      tr.append(make('td', null, r.label), when, light);
      table.append(tr);
    });
    bub.append(table);
    const g = make('p', 'g-line'); g.append(make('i', 'l ' + (b.level || 'none')), make('span', null, b.guardText));
    bub.append(g);
    if (b.needAck) {
      const ck = make('label', 'ck'), box = make('input'); box.type = 'checkbox'; box.id = 'ackChk'; box.checked = flow.ack;
      box.addEventListener('change', () => { flow.ack = box.checked; renderFlow(); $('ackChk').focus(); });
      ck.append(box, make('span', null, '我知道風險'));
      bub.append(ck);
    }
    b.blockers.filter(x => !(b.needAck && /我知道風險/.test(x))).forEach(x => bub.append(make('p', 'err', x)));
    bub.append(make('p', 'foot', !flow.guard || !flow.guard.ok ? '再按一次重新判讀・點其他地方取消' : '再按一次送出・點其他地方取消'));
    bub.hidden = false;
    sendBtn.disabled = !b.canConfirm && !!(flow.guard && flow.guard.ok);
  }

  // 背景預先判讀：內容齊了、有勾粉專、停手 PRE_GUARD_MS（勾粉專後 PRE_GUARD_PAGE_MS）先打 /guard/check（同樣內容只判一次）。
  // 按「全部送出」時內容沒變就直接用這次的燈號；泡泡、紅燈勾「我知道風險」、內容一改就作廢都和原本一樣
  const PRE_GUARD_MS = 2500, PRE_GUARD_PAGE_MS = 1000, PRE_GUARD_TTL = 10 * 60000;
  const LIGHT = { green: '綠燈', yellow: '黃燈', red: '紅燈' };
  let preGuard = null, guardTimer = 0, preShown = false;   // preGuard：{ key, p, guard, at, bg }
  function guardFor(input, bg) {
    const key = Payload.guardKey(input), c = preGuard;
    if (c && c.key === key && (!c.guard || Date.now() - c.at < PRE_GUARD_TTL)) return c;
    const entry = { key, guard: null, at: 0, bg };
    entry.p = Ext.call('/guard/check', 'POST', Payload.guardBody(input)).then(res => {
      const g = SendFlow.parseGuard(SendFlow.apiResult(res));
      entry.guard = g; entry.at = Date.now();
      if (!g.ok && preGuard === entry) preGuard = null;   // 失敗不留，下次重打
      return g;
    });
    preGuard = entry;
    return entry;
  }
  function schedulePreGuard(ms) {
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => {
      if (overlay.hidden || !Ext.version() || !/^(idle|done)$/.test(flow.state) || !pending().length) return;
      const input = currentInput();
      if (Payload.validateInput(input) || (input.mode !== 'text_card' && !input.caption.trim())) return;
      const e = guardFor(input, true);
      e.p.then(g => {
        if (!g.ok || preGuard !== e || !/^(idle|done)$/.test(flow.state) || e.key !== Payload.guardKey(currentInput())) return;
        sendMsg(`🛡 已先判讀：守則${LIGHT[g.level]}，按「全部送出」確認`, g.level === 'green' ? 'ok' : 'muted');
        preShown = true;
      }).catch(() => { /* 背景失敗不打擾；送出時會再判讀並顯示原因 */ });
    }, ms || PRE_GUARD_MS);
  }

  // 內容（標題、小編文、照片、時間、粉專…）有改：泡泡作廢、回到第 1 步
  function flowEdit() {
    if (flow.state === 'armed' || flow.state === 'checking') {
      flow.seq++;
      setFlow({ type: 'edit' });
      sendMsg('內容有改，送出前會重新判讀');
    } else {
      if (preShown && !(preGuard && preGuard.key === Payload.guardKey(currentInput()))) { preShown = false; sendMsg('🛡 送出時自動判讀'); }
      renderFlow();
    }
    markPreviewStale();
    schedulePreGuard();
  }
  modal.addEventListener('input', e => { if (!e.target.closest('#bubble,#timePop')) flowEdit(); });
  Editor.onChange(() => { editorVer++; $('previewBtn').hidden = !Editor.hasImage(); $('previewBtn').disabled = previewing; schedulePreUpload(); flowEdit(); });
  document.addEventListener('mousedown', e => {
    if (flow.state !== 'armed' || e.target.closest('#sendArea') || ImgHost.isOpen()) return;
    flow.seq++;
    setFlow({ type: 'outside' });
    sendMsg('已取消，要送出請再按一次');
  });

  sendBtn.addEventListener('click', () => {
    if (flow.state === 'armed') {
      const b = bubbleNow();
      if (b.canConfirm) { send(flow.targets, false); return; }
      if (!flow.guard || !flow.guard.ok) { check(flow.targets); return; }   // 判讀失敗：再判一次
      return;
    }
    if (flow.state === 'idle' || flow.state === 'done') check(pending());
  });

  // 第 1 步：檢查內容 → /guard/check → 顯示泡泡
  async function check(codes) {
    const input = currentInput();
    const err = !codes.length ? '請先選粉專' : Payload.validateInput(input);
    if (err) { sendMsg(err, 'bad'); return; }
    flow.targets = codes.slice(); flow.ack = false; flow.guard = null;
    setFlow({ type: 'click', guardFailed: true });
    sendMsg('🛡 守則判讀中…'); preShown = false;
    const my = ++flow.seq, key = Payload.guardKey(input);
    // 背景已判好（或正在判）同樣內容就沿用；背景那次失敗才在這裡重打一次
    let e = guardFor(input, false), g = await e.p;
    if (!g.ok && e.bg) { e = guardFor(input, false); g = await e.p; }
    if (my !== flow.seq || flow.state !== 'checking') return;   // 期間被取消或內容被改
    const stale = key !== Payload.guardKey(currentInput());
    flow.guard = g; flow.key = key;
    setFlow({ type: 'guard', stale });
    sendMsg(stale ? '判讀期間內容有改，燈號作廢，請再按一次' : '請看泡泡確認各台與時間', stale ? 'bad' : '');
  }

  // 紀錄縮圖：預覽畫布（含框與標題）縮成 144×144 的 JPEG dataURL，約 20 KB 以內；做不出來就不存
  function makeThumb() {
    try {
      const src = state.mode === 'text' ? $('textCanvas') : $('editorCanvas');
      const c = document.createElement('canvas'); c.width = c.height = 144;
      c.getContext('2d').drawImage(src, 0, 0, 144, 144);
      for (const q of [0.75, 0.6, 0.45, 0.3]) { const u = c.toDataURL('image/jpeg', q); if (Records.okThumb(u)) return u; }
    } catch (e) { /* 畫布被污染等：不存縮圖 */ }
    return '';
  }

  // 第 2 步：上傳圖（作圖框）→ 每台各送一次 /publish 或 /schedule
  async function send(codes, direct) {
    const input = currentInput();
    if (!flow.guard || !flow.guard.ok || Payload.guardKey(input) !== flow.key) { flow.seq++; flow.state = 'idle'; renderFlow(); sendMsg('內容有改，請再按一次重新判讀', 'bad'); return; }
    const late = codes.map(targetOf).find(t => t.at && Sched.validate(t.at, now()));
    if (late) { sendMsg(`${labelOf(late.code)}：${Sched.validate(late.at, now()).msg}`, 'bad'); renderFlow(); return; }
    setFlow({ type: direct ? 'resend' : 'click', canConfirm: true });
    hideToast();
    // 確定進度：上傳圖（還沒傳好才算一步）＋每台一步＋Rundown（開著才算）
    const total = (input.mode === 'single' && !cacheOk() ? 1 : 0) + codes.length + (Rundown.enabled() ? 1 : 0);
    let step = 0;
    const tick = () => { progress(++step, total); };
    progress(0, total);
    const prev = Object.fromEntries(codes.map(c => [c, state.pages[c].status]));
    codes.forEach(c => { state.pages[c].status = 'sending'; renderPage(c); });
    if (input.mode === 'single') {
      sendMsg('上傳圖片到圖床…');
      const needed = !cacheOk();
      try { input.imageUrl = await ensureUploaded(); } catch (e) {
        codes.forEach(c => { state.pages[c].status = prev[c]; renderPage(c); });
        setFlow({ type: 'abort' });
        progress(null);
        sendMsg('圖片沒有上傳：' + e.message, 'bad');
        toast('圖片沒有上傳', { label: '重試', fn: () => resendCodes(codes) });
        return;
      }
      if (needed) tick();
    }
    input.guard = { checkId: flow.guard.checkId, level: flow.guard.level, ack: flow.ack };
    const reqs = Payload.buildRequests(input, codes.map(targetOf));
    // 本機紀錄：同一篇（直到清空頁面）只有一筆；每次送出都把內容、縮圖、燈號更新成這次送出的版本
    const recInfo = { mode: input.mode, frame: state.frame, title: input.mode === 'single' ? getLines().filter(Boolean).join(' ') : input.cardText.trim().slice(0, 60),
      lines: getLines(), caption: input.caption, cardStyle: state.cardStyle, slug: Rundown.cleanSlug($('slug').value), articleId: Rules.articleId(input.url), url: input.url,
      imgExp: input.mode === 'single' && upCache ? upCache.exp : '', thumb: makeThumb(),
      render: Payload.previewRequest(input),   // 列表「複製圖片」用同一個請求重新產成品圖（只存網址與文字）
      guard: { checkId: flow.guard.checkId, level: flow.guard.level, reasons: flow.guard.reasons || [] } };
    if (!flow.recordId) flow.recordId = Records.add(Object.assign(recInfo, { pages: [] }));
    else Records.update(flow.recordId, recInfo);
    if (Records.error() === 'quota') toast('瀏覽器儲存空間不足，已刪掉舊紀錄或縮圖');
    for (const [i, rq] of reqs.entries()) {
      const st = state.pages[rq.code];
      sendMsg(`送出${labelOf(rq.code)}…（${i + 1}/${reqs.length}）`);
      const out = SendFlow.sendOutcome(SendFlow.apiResult(await Ext.call(rq.path, 'POST', rq.body)));
      st.status = out.ok ? 'ok' : 'fail'; st.result = out;
      Records.updatePage(flow.recordId, rq.code, { label: labelOf(rq.code), kind: rq.body.schedule ? 'sched' : 'now', schedule: rq.body.schedule,
        status: st.status, link: out.link || '', postId: out.postId || '', error: out.error || '', sentAt: new Date().toISOString(), path: rq.path, body: rq.body });
      renderPage(rq.code);
      tick();
    }
    const rd = await toRundown(reqs, recInfo);
    progress(null);
    setFlow({ type: 'sent' });
    const sent = C.pages.map(p => p.code).filter(c => /^(ok|fail)$/.test(state.pages[c].status));
    const failed = sent.filter(c => state.pages[c].status === 'fail');
    const sum = SendFlow.summary(sent.map(c => state.pages[c].status));
    const base = failed.length ? sum + '：' + failed.map(c => `${labelOf(c)} ${state.pages[c].result.error}`).join('；') : sum + '・要發下一篇請按「清空頁面」';
    sendMsg(base + (rd.msg ? '｜' + rd.msg : ''), failed.length || rd.bad ? 'bad' : 'ok');
    if (failed.length) toast(`${failed.length} 台送出失敗`, { label: '重試', fn: () => resendCodes(failed) });
  }
  // 送出進度條：null＝收起來
  function progress(done, total) {
    const p = $('sendProg');
    p.hidden = done == null;
    if (done == null) return;
    p.max = Math.max(1, total); p.value = done;
    p.setAttribute('aria-valuetext', `已完成 ${done}/${total}`);
  }

  // 這次送成功的台各自寫進 FB RUNDOWN 對應區段（開關打開才做）；排程用排程時間、立即用送出當下。擠看看、氣象沒有區段，略過
  async function toRundown(reqs, info) {
    if (!Rundown.enabled()) return { msg: '' };
    const sent = reqs.filter(rq => state.pages[rq.code].status === 'ok').map(rq => ({ code: rq.code, at: rq.body.schedule || new Date() }));
    const { entries } = Rundown.entries({ articleId: info.articleId, slug: info.slug, lines: info.lines }, sent);
    if (!entries.length) return { msg: '' };
    sendMsg('寫入 Rundown…');
    try { return await toRundownSend(entries); } finally { progress($('sendProg').max, $('sendProg').max); }
  }
  async function toRundownSend(entries) {
    let j;
    try { j = await Rundown.add(entries); } catch (e) {
      entries.forEach(en => Records.updatePage(flow.recordId, en.page, { rundown: { ok: false, error: e.message } }));
      return { msg: 'Rundown 沒寫入：' + e.message, bad: true };
    }
    const res = Array.isArray(j && j.results) ? j.results : [];
    entries.forEach((en, i) => { const r = res[i] || { ok: false, error: '沒有回應' };
      Records.updatePage(flow.recordId, en.page, { rundown: { ok: !!r.ok, status: r.status || '', cell: r.cell || '', time: r.time || '', error: r.error || '' } }); });
    return { msg: 'Rundown：' + entries.map((en, i) => Rundown.describe(res[i], Rundown.PAGES[en.page])).join('；'), bad: entries.some((en, i) => !(res[i] && res[i].ok)) };
  }

  // 失敗的台各自重送：內容沒改、燈號仍有效就直接送；否則先重新判讀（泡泡只列這一台）
  function resendCodes(codes) {
    if (flow.state === 'sending' || flow.state === 'checking') return;
    closePops();
    const g = flow.guard;
    const valid = g && g.ok && flow.key === Payload.guardKey(currentInput()) && (g.level !== 'red' || flow.ack);
    if (valid) send(codes, true); else check(codes);
  }
  const resend = code => resendCodes([code]);

  // ---- 開關彈窗 ----
  let confirmFn = null;
  function askConfirm(title, body, okText, fn) {
    $('cfTitle').textContent = title; $('cfBody').textContent = body; $('cfLeave').textContent = okText;
    confirmFn = fn;
    $('confirm').hidden = false; $('cfStay').focus();
  }
  function isDirty() {
    return !!($('url').value.trim() || getLines().length || $('caption').value.trim() || Editor.hasContent());
  }
  const allSent = () => C.pages.some(p => state.pages[p.code].status === 'ok') && !pending().length;
  function resetAll() {
    $('url').value = ''; $('caption').value = ''; titleEl.value = ''; $('slug').value = ''; hint(''); capHint('');
    state.articleId = ''; state.summary = '';
    cap.auto = cap.ai = ''; cap.title = null; Article.learnSeps('', []);
    Editor.reset();
    Object.values(state.pages).forEach(s => { s.on = false; s.sched = false; s.at = null; s.status = ''; s.result = null; });
    C.pages.forEach(p => renderPage(p.code));
    Object.assign(flow, { state: 'idle', key: '', guard: null, ack: false, targets: [], recordId: '' }); flow.seq++;
    upCache = null; previewKey = ''; $('bePrev').hidden = true; $('bePrevImg').hidden = true;
    clearTimeout(guardTimer); preGuard = null; preShown = false;
    sendMsg('🛡 送出時自動判讀');
    closePops(); updateCounters(); drawTextCard(); renderFlow();
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
    if (flow.state === 'sending') { toast('送出中，請等全部送完'); return; }
    if (!isDirty() || allSent()) { closeModal(); return; }
    const some = C.pages.some(p => state.pages[p.code].status);
    askConfirm('關閉新增發文？', some ? '還有沒送出或失敗的粉專，關閉後會清掉。' : '目前填的內容還沒送出，關閉後會清掉。', '放棄並關閉', closeModal);
  }
  $('clearBtn').addEventListener('click', () => {
    if (flow.state === 'sending') return;
    if (!pending().length) { resetAll(); $('url').focus(); return; }
    askConfirm('清空頁面？', '還有沒送出或失敗的粉專，清空後要重新填。', '清空', () => { $('confirm').hidden = true; resetAll(); $('url').focus(); });
  });
  $('newBtn').addEventListener('click', openModal);
  // 送出紀錄「複製到新增發文」：帶入標題、小編文、網址、版型、模式（圖不帶，要重新選）
  function openWith(inp) {
    if (!overlay.hidden) return;
    resetAll();
    setMode(inp.mode); setFrame(inp.frame);
    if (inp.cardStyle) setCardStyle(inp.cardStyle);
    $('url').value = inp.url || ''; state.articleId = Rules.articleId(inp.url);
    titleEl.value = (inp.lines || []).join('\n'); $('caption').value = inp.caption || ''; $('slug').value = inp.slug || '';
    openModal();
    hint(inp.mode === 'frame' ? '已從紀錄帶入文字，照片請重新選' : '已從紀錄帶入文字', 'ok');
  }
  RecList.mount({ toast, onCopy: openWith });

  // Rundown 開關（存在這台瀏覽器）；Apps Script 網址與金鑰在 Worker Secrets
  const rdOn = $('rdOn');
  const syncRd = v => { rdOn.checked = !!v.on; $('slug').disabled = !v.on; $('rdBox').classList.toggle('off', !v.on); };
  syncRd(Rundown.settings()); Rundown.onChange(syncRd);
  rdOn.addEventListener('change', () => {
    Rundown.save({ on: rdOn.checked });
    toast(rdOn.checked ? '送出成功後會自動排入 Rundown' : '已關閉 Rundown 自動排入');
  });
  $('rdSetBtn').addEventListener('click', () => Rundown.open());
  $('closeBtn').addEventListener('click', requestClose);
  $('cfStay').addEventListener('click', () => { $('confirm').hidden = true; $('closeBtn').focus(); });
  $('cfLeave').addEventListener('click', () => (confirmFn || closeModal)());
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) requestClose(); });

  document.addEventListener('keydown', e => {
    const login = ImgHost.isOpen(), rdSet = Rundown.isOpen();
    if (overlay.hidden && !login && !rdSet) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (login) { ImgHost.cancel(); return; }
      if (rdSet) { Rundown.close(); $('rdSetBtn').focus(); return; }
      if (!$('confirm').hidden) { $('confirm').hidden = true; return; }
      if (Editor.fxOpen()) { Editor.closeFx(true); return; }
      if (!menu.hidden || !pop.hidden) { const c = popFor; closePops(); if (c) pgEls[c].mode.focus(); return; }
      if (flow.state === 'armed') { flow.seq++; setFlow({ type: 'outside' }); sendMsg('已取消，要送出請再按一次'); sendBtn.focus(); return; }
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    // 焦點鎖在最上層：圖床登入 > 確認視窗 > 彈窗
    const scope = login ? $('imgLogin') : rdSet ? $('rdDlg') : !$('confirm').hidden ? $('confirm') : modal;
    const f = [...scope.querySelectorAll('a[href],button,input,textarea,select,[tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && !el.closest('[hidden]') && el.offsetParent !== null && el.type !== 'file');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!scope.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  Editor.setFrame(state.frame);
  updateCounters(); drawTextCard(); renderFlow();
  window.App = { state, flow, getLines, setLines, currentInput, openWith };   // 後續 PR 與測試用
  checkExtOnLoad();
})();
