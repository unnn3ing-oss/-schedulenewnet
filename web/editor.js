// 作圖框編輯器。照片處理（點選／拖曳／貼上、滾輪與雙指縮放、拖曳平移且不露出空白邊）取自 quickpatterntool/app.js。
// 畫面上的預覽 = 照片＋馬賽克＋貼圖＋邊框疊圖（frames/news.png、ent.png）＋標題（QPT 的 WHZ-Heavy 標題畫法），讓小編看到套版後的樣子；
// 但 exportBlob（上傳圖床、交給後端）只畫「照片＋馬賽克＋貼圖」，**不含**疊圖與標題：後端會自己疊漸層、邊框與標題。
(function () {
  const $ = id => document.getElementById(id);
  const canvas = $('editorCanvas');
  const ctx = canvas.getContext('2d');
  const wrap = $('canvasWrap');
  const MAX_ZOOM = 5;
  const MAX_FILE = 30 * 1024 * 1024;

  const W = 1080, H = 1080;                 // 網新各版型都是 1080×1080
  const bg = { image: null, view: { zoom: 1, x: 0, y: 0 }, name: '' };
  const items = [];                       // 貼圖與馬賽克（畫布座標）
  const fx = Stickers.drawFx(items);
  const listeners = [];
  const emit = () => listeners.forEach(fn => fn());

  // ---- 照片幾何（QPT：coverGeometry / clampView）----
  function coverGeometry(image, view) {
    const s = Math.max(W / image.width, H / image.height) * view.zoom;
    const dw = image.width * s, dh = image.height * s;
    return { s, dw, dh, dx: (W - dw) / 2 + view.x, dy: (H - dh) / 2 + view.y };
  }
  function clampView(image, view) {
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
    const { dw, dh } = coverGeometry(image, view);
    const mx = (dw - W) / 2, my = (dh - H) / 2;
    view.x = Math.min(mx, Math.max(-mx, view.x));
    view.y = Math.min(my, Math.max(-my, view.y));
  }

  // 要上傳的那張：照片＋馬賽克＋貼圖
  function drawBase(c) {
    c.fillStyle = bg.image ? '#fff' : '#d9e2f2';
    c.fillRect(0, 0, W, H);
    if (bg.image) {
      const g = coverGeometry(bg.image, bg.view);
      c.drawImage(bg.image, g.dx, g.dy, g.dw, g.dh);
      fx.mosaic(c);
      fx.stickers(c);
    }
  }

  // ---- 預覽用的邊框疊圖與標題（只畫在畫面上，不輸出）----
  const frames = {};
  ['news', 'ent'].forEach(k => {
    const im = new Image();
    im.onload = () => render();
    im.src = `frames/${k}.png`;
    frames[k] = im;
  });
  let frame = 'news', titleLines = [];

  // ===== 標題畫法：底子複製自 quickpatterntool/app.js，字級與位置改成量自後端 /render 實際產圖（2026-10-26，1／2／3 行樣本）=====
  // 後端：同為 WHZ-Heavy、66px、白字置中、行距 93px，最後一行固定在 y≈931，往上疊（不是整塊置中）
  const SIZE = W;
  const FONT_STACK = `"WHZ-Heavy", "Microsoft JhengHei", "PMingLiU", sans-serif`;
  const whzFontReady = document.fonts ? document.fonts.load(`67px "WHZ-Heavy"`).catch(() => {}) : Promise.resolve();
  const LAST_LINE_Y = 931;     // 最後一行的中線（textBaseline: middle），量自後端產圖
  const LINE_HEIGHT = 93;      // 行距（px），量自後端產圖
  const TITLE_PX = 66;         // 字級（px），量自後端產圖（同字型寬度比 67px 小 1.5%）
  const TITLE_LIGHT = '#ffffff';
  function fitFontSize(targetCtx, lines, maxWidth, baseSize) {
    let size = baseSize;
    targetCtx.font = `${size}px ${FONT_STACK}`;
    const widest = Math.max(...lines.map(l => targetCtx.measureText(l).width));
    if (widest > maxWidth) {
      size = Math.max(24, Math.floor(size * maxWidth / widest));
    }
    return size;
  }
  function drawTitle(targetCtx, lines, baseSize, lastY, color = TITLE_LIGHT) {
    if (lines.length === 0) return;

    const paddingX = 30;   // 後端 15 個全形字（約 990px）不縮字
    const maxWidth = SIZE - paddingX * 2;
    const fontSize = fitFontSize(targetCtx, lines, maxWidth, baseSize);
    const lineHeight = LINE_HEIGHT * fontSize / baseSize;
    const n = lines.length;

    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    targetCtx.font = `${fontSize}px ${FONT_STACK}`;

    lines.forEach((line, i) => {
      const y = lastY - (n - 1 - i) * lineHeight;
      targetCtx.fillStyle = color;
      targetCtx.fillText(line, SIZE / 2, y);
    });
  }
  // ===== 複製結束 =====
  whzFontReady.then(() => render());

  function render() {
    drawBase(ctx);
    const ov = frames[frame];
    if (ov && ov.complete && ov.naturalWidth) ctx.drawImage(ov, 0, 0, W, H);
    drawTitle(ctx, titleLines, TITLE_PX, LAST_LINE_Y);
  }
  const changed = () => { render(); if (fxEditor) fxEditor.layout(); emit(); };

  // ---- 貼圖／馬賽克 ----
  let fxTiles = [];
  var fxEditor = Stickers.createEditor({
    canvas, wrap,
    items: () => items,
    ready: () => !!bg.image,
    changed,
    redraw: render,
    onLayout: () => setFxDisabled()
  });
  // T寶貼圖與馬賽克收在一顆按鈕裡：按了才彈出那一排，加一個、點外面或按 Esc 就收起來；沒有照片時按鈕停用
  let fxSlot = null, fxBtn = null;
  function setFxDisabled() {
    fxTiles.forEach(b => { b.disabled = !bg.image; });
    if (fxBtn) { fxBtn.disabled = !bg.image; if (!bg.image) closeFx(); }
  }
  const fxOpen = () => !!fxSlot && !fxSlot.hidden;
  function closeFx(focus) {
    if (!fxOpen()) return;
    fxSlot.hidden = true;
    fxBtn.setAttribute('aria-expanded', 'false');
    if (focus) fxBtn.focus();
  }
  function mountFxBar(slot, btn) {
    const { row, tiles } = Stickers.buildRow(fxEditor);
    fxTiles = tiles;
    const hint = document.createElement('div');
    hint.className = 'fx-hint';
    hint.textContent = Stickers.hintText;
    slot.appendChild(row);
    slot.appendChild(hint);
    if (btn) {
      fxSlot = slot; fxBtn = btn;
      slot.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        if (fxOpen()) return closeFx();
        slot.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
      });
      tiles.forEach(b => b.addEventListener('click', () => closeFx()));
      document.addEventListener('pointerdown', e => { if (fxOpen() && !slot.contains(e.target) && !btn.contains(e.target)) closeFx(); });
    }
    setFxDisabled();
  }
  fxEditor.sync();

  // ---- 載入照片 ----
  function setImage(img, name) {
    bg.image = img;
    bg.name = name || '';
    bg.view = { zoom: 1, x: 0, y: 0 };
    wrap.classList.add('has-image');
    setFxDisabled();
    fxEditor.sync(true);
    changed();
  }
  function loadSrc(src, name, revoke) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { if (revoke) URL.revokeObjectURL(src); setImage(img, name); resolve(); };
      img.onerror = () => { if (revoke) URL.revokeObjectURL(src); reject(new Error('bad_image')); };
      img.src = src;
    });
  }
  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) return Promise.reject(new Error('not_image'));
    if (file.size > MAX_FILE) return Promise.reject(new Error('too_big'));
    return loadSrc(URL.createObjectURL(file), file.name, true);
  }
  const loadUrl = dataUrl => loadSrc(dataUrl, 'quickfill', false);   // 只收 data:／blob: URL（不載入跨網域圖，免得畫布被污染）

  function clearImage() {
    bg.image = null; bg.name = '';
    items.length = 0;
    wrap.classList.remove('has-image');
    fxEditor.sync(true);
    setFxDisabled();
    changed();
  }

  // ---- 預覽的框（news 藍框／ent 粉框）與標題：只重畫畫面，不算「改了照片」（不觸發重新上傳）----
  function setFrame(f) { frame = f === 'ent' ? 'ent' : 'news'; render(); }
  function setTitleLines(lines) { titleLines = (lines || []).map(l => String(l).trim()).filter(Boolean); render(); }

  // ---- 匯出：JPEG q0.92，只有照片＋馬賽克＋貼圖（另開一張畫布畫，不含預覽的疊圖與標題）----
  function exportBlob() {
    return new Promise((resolve, reject) => {
      if (!bg.image) { reject(new Error('no_image')); return; }
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      drawBase(out.getContext('2d'));
      out.toBlob(b => b ? resolve(b) : reject(new Error('export_failed')), 'image/jpeg', 0.92);
    });
  }

  // ---- 平移／縮放（QPT wirePreviewPanZoom）----
  const toCanvas = (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    const k = W / r.width;
    return { x: (cx - r.left) * k, y: (cy - r.top) * k, k };
  };
  canvas.addEventListener('wheel', e => {
    if (!bg.image) return;
    e.preventDefault();
    const view = bg.view;
    const p = toCanvas(e.clientX, e.clientY);
    const before = coverGeometry(bg.image, view);
    const u = (p.x - before.dx) / before.s, v = (p.y - before.dy) / before.s;
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * Math.exp(-e.deltaY * 0.0015)));
    const after = coverGeometry(bg.image, { zoom: view.zoom, x: 0, y: 0 });
    view.x = p.x - u * after.s - after.dx;
    view.y = p.y - v * after.s - after.dy;
    clampView(bg.image, view);
    changed();
  }, { passive: false });

  let drag = null, pinch = null;
  const touches = new Map();
  const pinchGeom = () => {
    const [a, b] = [...touches.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  canvas.addEventListener('pointerdown', e => {
    wrap.focus();
    if (!bg.image || e.button !== 0) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (touches.size === 2) {
      drag = null;
      const g = pinchGeom(), p = toCanvas(g.cx, g.cy), before = coverGeometry(bg.image, bg.view);
      pinch = { dist0: Math.max(g.dist, 1), zoom0: bg.view.zoom, u: (p.x - before.dx) / before.s, v: (p.y - before.dy) / before.s };
      canvas.classList.add('panning');
    } else if (touches.size === 1) {
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: bg.view.x, vy: bg.view.y };
      canvas.classList.add('panning');
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size === 2) {
      const g = pinchGeom(), view = bg.view;
      view.zoom = Math.min(MAX_ZOOM, Math.max(1, pinch.zoom0 * g.dist / pinch.dist0));
      const p = toCanvas(g.cx, g.cy), after = coverGeometry(bg.image, { zoom: view.zoom, x: 0, y: 0 });
      view.x = p.x - pinch.u * after.s - after.dx;
      view.y = p.y - pinch.v * after.s - after.dy;
      clampView(bg.image, view);
      changed();
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const { k } = toCanvas(e.clientX, e.clientY);
    bg.view.x = drag.vx + (e.clientX - drag.sx) * k;
    bg.view.y = drag.vy + (e.clientY - drag.sy) * k;
    clampView(bg.image, bg.view);
    changed();
  });
  const endDrag = e => {
    const wasDown = touches.delete(e.pointerId);
    if (pinch && touches.size < 2) {
      pinch = null;
      if (touches.size) { const [[id, pos]] = [...touches.entries()]; drag = { id, sx: pos.x, sy: pos.y, vx: bg.view.x, vy: bg.view.y }; }
      else { drag = null; canvas.classList.remove('panning'); }
      return;
    }
    if (!wasDown || !drag || e.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('panning');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---- 選檔／拖放／貼上 ----
  const fileInput = $('fileInput');
  const fail = err => listeners.forEach(() => {}) || Editor.onError(err);
  const take = file => loadFile(file).catch(fail);
  canvas.addEventListener('click', () => { if (!bg.image) fileInput.click(); });
  $('ph').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) take(f); });
  wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('drag'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag'));
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    wrap.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) take(f);
  });
  document.addEventListener('paste', e => {
    if (!Editor.active()) return;
    const f = [...(e.clipboardData ? e.clipboardData.files : [])].find(x => /^image\//.test(x.type));
    if (!f) return;
    e.preventDefault();
    take(f);
  });

  window.Editor = {
    setFrame, setTitleLines, exportBlob, loadFile, loadUrl, clearImage, mountFxBar, fxOpen, closeFx,
    hasImage: () => !!bg.image,
    hasContent: () => !!bg.image || items.length > 0,
    size: () => [W, H],
    frame: () => frame,
    onChange: fn => listeners.push(fn),
    reset: () => { clearImage(); bg.view = { zoom: 1, x: 0, y: 0 }; },
    active: () => true,          // app.js 依目前模式覆寫：只有「作圖框」模式才吃貼上的圖
    onError: err => console.warn(err)   // app.js 覆寫成顯示提示
  };
  render();
})();
