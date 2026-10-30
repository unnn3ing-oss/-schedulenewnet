// 主畫面「送出紀錄」：分頁籤（全部／已排程／已發布／失敗）、分頁（每頁 20 筆，同 hottopic 的頁碼列）、各台狀態、
// 從列表重送失敗的台、複製標題、複製圖片（重新請後端產成品圖）、複製到新增發文、刪除紀錄。後端沒有列表端點，資料只來自這台瀏覽器的 Records（localStorage）。
// 排程時間過了只能「推測」已發布：本機無法確認後端真的有發出。
(function () {
  const $ = id => document.getElementById(id);
  const view = { tab: 'all', page: 1, busy: new Set() };
  let opts = { toast: () => {}, onCopy: () => {} };
  const now = () => new Date();
  const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pad = n => String(n).padStart(2, '0');
  const labelOf = (p) => p.label || (Rules.pageByCode(p.code) || {}).label || p.code;
  function sentWhen(iso, n) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const same = d.toDateString() === n.toDateString();
    return (same ? '今天 ' : `${d.getMonth() + 1}/${d.getDate()} `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---- 列表 ----
  function chip(rec, p, n) {
    const key = rec.id + '|' + p.code, label = labelOf(p);
    if (view.busy.has(key)) { const c = make('span', 'chip busy', `${label}・重送中…`); return c; }
    const st = Records.pageState(p, n);
    if (st === 'published') {
      const link = Records.postLink(p, n);
      const t = p.sentAt ? new Date(p.sentAt) : null, when = t && !isNaN(t) ? ' ' + Records.fmtMD(t) : '';   // 立即發布＝送出成功的時間
      if (!link) return make('span', 'chip ok', `${label}・已發布${when}`);
      const a = make('a', 'chip ok', `${label}・已發布${when} ↗`);
      a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = '開啟貼文';
      return a;
    }
    const at = Records.parseSchedule(p.schedule);
    if (st === 'scheduled') return make('span', 'chip', `${label}・排程 ${Records.fmtMD(at)}`);
    if (st === 'due') {
      const link = Records.postLink(p, n);   // 後端有回貼文連結／編號：時間到了就能點開（每分鐘重畫一次，見 mount）
      if (link) {
        const a = make('a', 'chip ok', `${label}・已發布 ${Records.fmtMD(at)} ↗`);
        a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.title = `開啟貼文（排程 ${Records.fmtMD(at)}；本機無法確認是否真的發出，打不開請到粉專確認）`;
        return a;
      }
      const c = make('span', 'chip due', `${label}・應已發布 ${Records.fmtMD(at)}（推測）`);
      c.title = `排程時間 ${Records.fmtMD(at)} 已過；本機無法確認是否真的發出，請到粉專確認`;
      return c;
    }
    if (st === 'failed') {
      const b = make('button', 'chip e', `${label}・失敗 ↻ 重送`);
      b.type = 'button'; b.dataset.rs = key; b.title = (p.error ? p.error + '・' : '') + '點一下重送這一台';
      b.setAttribute('aria-label', `${label}失敗，重送`);
      return b;
    }
    return make('span', 'chip', `${label}・未完成`);
  }
  function thumb(rec) {
    const box = make('div', 'rec-th' + (rec.mode === 'text_card' ? ' card' : rec.frame === 'ent' ? ' pk' : ''));
    if (Records.okThumb(rec.thumb)) { const im = make('img'); im.src = rec.thumb; im.alt = ''; im.loading = 'lazy'; box.append(im); }
    box.setAttribute('aria-hidden', 'true');
    return box;
  }
  function row(rec, n) {
    const el = make('article', 'rec'); el.dataset.id = rec.id;
    const t = Records.titleParts(rec), main = make('div', 'rec-main');
    const title = make('div', 'rec-t'); title.append(make('b', null, t.first));
    if (t.rest) title.append(' ', make('span', 'muted', t.rest));
    const meta = make('div', 'rec-m muted');
    meta.append([sentWhen(rec.at, n) + ' 送出', Records.modeLabel(rec), Records.frameLabel(rec)].filter(Boolean).join('・'));
    const act = make('span', 'rec-act');
    const btn = (text, key, cls) => { const b = make('button', cls || 'linkish', text); b.type = 'button'; b.dataset[key] = rec.id; return b; };
    const ct = btn('複製標題', 'ctitle', 'btn sm ghost rcopy');
    const ci = btn('複製圖片', 'cimg', 'btn sm ghost rcopy'), chk = Records.copyImageCheck(rec, n);
    if (view.busy.has('img|' + rec.id)) { ci.textContent = '產圖中…'; ci.disabled = true; ci.setAttribute('aria-busy', 'true'); }
    else if (!chk.ok) { ci.setAttribute('aria-disabled', 'true'); ci.title = chk.reason; }   // 不用 disabled：手機點了也能看到原因
    else ci.title = '複製 FB 上看到的成品圖（含框與標題）';
    act.append(ct, ci, btn('複製到新增發文', 'copy'), btn('刪除紀錄', 'del'));
    meta.append(act);
    main.append(title, meta);
    const chips = make('div', 'st2');
    (rec.pages || []).forEach(p => chips.append(chip(rec, p, n)));
    el.append(thumb(rec), main, chips);
    return el;
  }
  function renderPager(pages) {
    const box = $('recPager');
    box.hidden = pages <= 1;
    if (pages <= 1) { box.replaceChildren(); return; }
    const cur = view.page, btn = (page, text, label, extra) => {
      const b = make('button', null, text); b.type = 'button'; b.dataset.page = String(page); b.setAttribute('aria-label', label);
      if (extra === 'cur') b.setAttribute('aria-current', 'page'); else if (extra === 'off') b.disabled = true;
      return b;
    };
    const parts = [btn(cur - 1, '‹', '上一頁', cur <= 1 ? 'off' : '')];
    Records.pageWindow(cur, pages).forEach(n => parts.push(n === '…' ? make('span', 'gap', '…') : btn(n, String(n), `第 ${n} 頁`, n === cur ? 'cur' : '')));
    parts.push(btn(cur + 1, '›', '下一頁', cur >= pages ? 'off' : ''));
    box.replaceChildren(...parts);
  }
  function render() {
    const n = now(), all = Records.list(), c = Records.counts(all, n);
    $('recTabs').querySelectorAll('button[data-tab]').forEach(b => {
      const on = b.dataset.tab === view.tab;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
      const k = c[b.dataset.tab];
      b.querySelector('.n').textContent = k ? String(k) : '';
      b.classList.toggle('has-fail', b.dataset.tab === 'fail' && k > 0);
    });
    const list = Records.filter(all, view.tab, n), pages = Records.pageCount(list.length, Records.PAGE_SIZE);
    view.page = Records.clampPage(view.page, pages);
    $('recList').replaceChildren(...Records.slicePage(list, view.page, Records.PAGE_SIZE).map(r => row(r, n)));
    $('recEmpty').hidden = all.length > 0;
    $('recTabs').hidden = !all.length;
    $('recNone').hidden = !all.length || list.length > 0;
    $('recFoot').hidden = !list.length;
    $('recCnt').textContent = `共 ${list.length} 則`;
    renderPager(pages);
  }

  $('recTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    view.tab = b.dataset.tab; view.page = 1; render();
    $('recTabs').querySelector(`[data-tab="${view.tab}"]`).focus();
  });
  $('recPager').addEventListener('click', e => {
    const b = e.target.closest('button[data-page]');
    if (!b || b.disabled) return;
    const label = b.getAttribute('aria-label');
    view.page = +b.dataset.page; render();
    document.querySelector('.records').scrollIntoView({ block: 'start' });
    // 頁碼列整排換掉：焦點放回同一顆（到頭了就落在目前頁）
    const again = [...$('recPager').querySelectorAll('button')].find(x => x.getAttribute('aria-label') === label && !x.disabled) || $('recPager').querySelector('[aria-current]');
    if (again) again.focus({ preventScroll: true });
  });
  $('recList').addEventListener('click', e => {
    const rs = e.target.closest('[data-rs]'), cp = e.target.closest('[data-copy]'), del = e.target.closest('[data-del]');
    const ct = e.target.closest('[data-ctitle]'), ci = e.target.closest('[data-cimg]');
    if (ct) copyTitle(ct.dataset.ctitle);
    else if (ci) copyImage(ci.dataset.cimg);
    else if (rs) { const [id, code] = rs.dataset.rs.split('|'); openResend(id, code, rs); }
    else if (cp) { const rec = Records.get(cp.dataset.copy); if (rec) opts.onCopy(Records.copyInput(rec)); }
    else if (del) askDelete(del.dataset.del, del);
  });

  // ---- 複製標題、複製圖片 ----
  function copyTitle(id) {
    const rec = Records.get(id); if (!rec) return;
    const text = Records.titleText(rec);
    if (!text) { opts.toast('這筆紀錄沒有標題'); return; }
    const done = () => opts.toast('已複製標題');
    const legacy = () => {   // 沒有 Clipboard API（非 https 等）：用隱藏的 textarea 複製
      const ta = make('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* 不支援 */ }
      ta.remove();
      opts.toast(ok ? '已複製標題' : '複製失敗，瀏覽器不允許存取剪貼簿');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, legacy); else legacy();
  }
  // 後端回的 dataURL → PNG Blob（不是 PNG 就畫到畫布再轉）。CSP 不允許 fetch(data:)，自己解 base64
  function dataUrlBlob(url) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url || '');
    if (!m) throw new Error('後端回的圖格式不認得');
    const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }
  function toPng(url) {
    const blob = dataUrlBlob(url);
    if (blob.type === 'image/png') return Promise.resolve(blob);
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0);
        c.toBlob(b => (b ? resolve(b) : reject(new Error('轉成 PNG 失敗'))), 'image/png');
      };
      im.onerror = () => reject(new Error('讀不到後端回的圖'));
      im.src = url;
    });
  }
  // 重新打 /render 或 /render_text_card（同後端預覽，經外掛）→ PNG Blob；錯誤訊息沿用 SendFlow.apiResult
  async function renderPng(rq) {
    const res = SendFlow.apiResult(await Ext.call(rq.path, 'POST', rq.body));
    if (!res.ok || !res.image) throw new Error(res.error || '後端沒有回圖');
    return toPng(res.image);
  }
  function download(blob, name) {
    const a = make('a'), u = URL.createObjectURL(blob);
    a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);
  }
  // 要在點擊當下就呼叫 clipboard.write，並把「之後才拿到的圖」以 Promise 交給 ClipboardItem，Safari／Chrome 才認得是使用者操作
  function copyImage(id) {
    const rec = Records.get(id), key = 'img|' + id;
    if (!rec || view.busy.has(key)) return;
    const chk = Records.copyImageCheck(rec, now());
    if (!chk.ok) { opts.toast(chk.reason); return; }
    view.busy.add(key); render();
    const png = renderPng(chk.request);
    png.catch(() => {});   // 錯誤在下面統一處理
    const name = Records.imageFileName(rec);
    const canWrite = typeof ClipboardItem === 'function' && navigator.clipboard && typeof navigator.clipboard.write === 'function';
    const viaDownload = why => png.then(b => { download(b, name); opts.toast(`${why}，已下載 ${name}`); });
    const job = canWrite
      ? navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(() => opts.toast('已複製圖片，可直接貼上'),
        e => png.then(() => viaDownload('瀏覽器不允許複製圖片' + (e && e.name === 'NotAllowedError' ? '' : '（' + ((e && e.message) || e) + '）'))))
      : viaDownload('這個瀏覽器不支援複製圖片');
    job.catch(e => opts.toast('複製圖片失敗：' + ((e && e.message) || e))).finally(() => {
      view.busy.delete(key); render();
      const again = document.querySelector(`[data-cimg="${id}"]`); if (again && document.activeElement === document.body) again.focus();
    });
  }

  // ---- 對話框共用：Esc 關、焦點鎖、關了焦點回原處 ----
  let openDlg = null, returnTo = null;
  function showDlg(el, from, focusEl) { openDlg = el; returnTo = from || null; el.hidden = false; document.body.classList.add('locked'); (focusEl || el.querySelector('button')).focus(); }
  function hideDlg() {
    if (!openDlg) return;
    openDlg.hidden = true; openDlg = null; document.body.classList.remove('locked');
    const back = returnTo && document.contains(returnTo) ? returnTo : null;
    if (back) back.focus(); else if (rs && rs.key) { const b = document.querySelector(`[data-rs="${rs.key}"]`); if (b) b.focus(); }
    returnTo = null;
  }
  document.addEventListener('keydown', e => {
    if (!openDlg) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (openDlg === $('rsDlg')) rs = null; hideDlg(); return; }
    if (e.key !== 'Tab') return;
    const f = [...openDlg.querySelectorAll('button,input,a[href]')].filter(x => !x.disabled && !x.closest('[hidden]') && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!openDlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, true);
  [$('rsDlg'), $('rcDlg')].forEach(d => d.addEventListener('mousedown', e => { if (e.target === d) { if (d === $('rsDlg')) rs = null; hideDlg(); } }));

  // ---- 刪除紀錄（只刪本機）----
  let delId = '';
  function askDelete(id, from) {
    const rec = Records.get(id); if (!rec) return;
    delId = id;
    $('rcBody').textContent = `「${Records.titleParts(rec).first}」只會從這台瀏覽器的紀錄刪掉，不會影響已發布或已排程的貼文。`;
    showDlg($('rcDlg'), from, $('rcCancel'));
  }
  $('rcCancel').addEventListener('click', hideDlg);
  $('rcGo').addEventListener('click', () => {
    const ok = Records.remove(delId);
    returnTo = $('newBtn');
    hideDlg(); render();
    opts.toast(ok ? '已刪除紀錄' : '刪除失敗（瀏覽器儲存空間無法寫入）');
  });

  // ---- 從列表重送 ----
  // 燈號：紀錄裡有原本的判讀結果就沿用，沒有才重新打 /guard/check；紅燈一律要再勾「我知道風險」。
  // 排程的台：原本時間已過或不到 20 分鐘，要先選新時間（同新增發文的時間視窗：打 4 碼、↑↓ ±10 分）。
  let rs = null;   // { key, id, code, chk, at, guard, ack, checking, seq }
  function openResend(id, code, from) {
    if (view.busy.has(id + '|' + code)) return;
    const rec = Records.get(id), n = now(), chk = Records.resendCheck(rec, code, n);
    if (!chk.ok) { opts.toast(chk.reason); return; }
    const g = rec.guard && rec.guard.level ? { ok: true, level: rec.guard.level, checkId: rec.guard.checkId || '', reasons: rec.guard.reasons || [] } : null;
    rs = { key: id + '|' + code, id, code, chk, at: chk.kind === 'sched' && !chk.needTime ? chk.at : null, guard: g, ack: false, checking: false, seq: 0, fresh: false };
    const p = rec.pages.find(x => x.code === code);
    $('rsTitle').textContent = `重送${labelOf(p)}？`;
    $('rsWhat').textContent = `「${Records.titleParts(rec).first}」・上次失敗：${p.error || '未知錯誤'}`;
    $('rsAck').checked = false;
    const timeBox = chk.kind === 'sched';
    $('rsTime').hidden = !timeBox;
    if (timeBox) {
      $('rsDate').min = Sched.fmtDateInput(n); $('rsDate').max = Sched.fmtDateInput(Sched.latest(n));
      $('rsDate').value = Sched.fmtDateInput(rs.at || n);
      $('rsClock').value = rs.at ? Sched.fmtTime(rs.at) : '';
      const old = Records.parseSchedule(p.body.schedule || p.schedule);
      $('rsTimeNote').textContent = chk.needTime ? `原本的排程時間${old ? '（' + Records.fmtMD(old) + '）' : ''}已過或離現在不到 ${Sched.MIN_LEAD} 分鐘，請選新的時間` : '';
      $('rsTimeNote').hidden = !chk.needTime;
    }
    renderResend();
    showDlg($('rsDlg'), from, timeBox && chk.needTime ? $('rsClock') : $('rsCancel'));
    if (!g) recheck();
  }
  async function recheck() {
    const r = rs; if (!r) return;
    r.checking = true; r.guard = null; r.ack = false; $('rsAck').checked = false; renderResend();
    const my = ++r.seq, p = Records.get(r.id).pages.find(x => x.code === r.code);
    const g = SendFlow.parseGuard(SendFlow.apiResult(await Ext.call('/guard/check', 'POST', Records.guardBodyOf(p))));
    if (rs !== r || my !== r.seq) return;
    r.checking = false; r.guard = g; r.fresh = g.ok; renderResend();
  }
  function timeError(r, n) {
    if (r.chk.kind !== 'sched') return '';
    if (!r.at) return '請選新的排程時間（直接打 4 碼，2130＝21:30）';
    const e = Records.validateAt(Records.get(r.id), r.at, n);
    return e ? e.msg : '';
  }
  function renderResend() {
    const r = rs; if (!r) return;
    const n = now();
    const b = SendFlow.bubble({ targets: [{ code: r.code, at: null }], guard: r.checking ? { ok: false, error: '🛡 守則判讀中…' } : r.guard, ack: r.ack, now: n });
    const gl = $('rsGuard');
    gl.querySelector('i').className = 'l ' + (b.level || 'none');
    gl.querySelector('span').textContent = (r.guard && r.guard.ok && !r.fresh ? '沿用上次判讀・' : '') + b.guardText;
    $('rsAckRow').hidden = !b.needAck;
    const terr = timeError(r, n);
    if (r.chk.kind === 'sched') {
      $('rsHint').textContent = terr || `排程 ${Sched.fmtWhen(r.at, n)}・直接打 4 碼（2130＝21:30），↑↓ 每次 10 分`;
      $('rsHint').className = 'hint ' + (terr ? 'bad' : 'ok');
      $('rsClock').setAttribute('aria-invalid', String(!!terr));
    }
    const blockers = b.blockers.filter(x => !(b.needAck && /我知道風險/.test(x)) && !/再按一次/.test(x));
    if (b.needAck && !r.ack) blockers.push('紅燈要先勾「我知道風險」');
    if (terr && r.chk.kind === 'sched') blockers.push(terr);
    if (!r.checking && !(r.guard && r.guard.ok)) blockers.push('守則判讀失敗，按「重新判讀」再試一次');
    $('rsErr').replaceChildren(...[...new Set(blockers)].filter(x => x !== terr).map(x => make('p', 'hint bad', x)));   // 時間的錯誤已顯示在時間欄下方
    const guardFailed = !r.checking && !(r.guard && r.guard.ok);
    $('rsGo').textContent = r.checking ? '判讀中…' : guardFailed ? '重新判讀' : '確認重送';
    $('rsGo').disabled = r.checking || (!guardFailed && blockers.length > 0);
  }
  $('rsAck').addEventListener('change', () => { if (rs) { rs.ack = $('rsAck').checked; renderResend(); } });
  function takeTime() {
    if (!rs) return;
    rs.at = Sched.combine($('rsDate').value, $('rsClock').value);
    renderResend();
  }
  function setTime(at) { if (!rs) return; rs.at = at; $('rsDate').value = Sched.fmtDateInput(at); $('rsClock').value = Sched.fmtTime(at); renderResend(); }
  $('rsClock').addEventListener('input', () => { const v = Sched.formatTyping($('rsClock').value); if (v !== $('rsClock').value) $('rsClock').value = v; takeTime(); });
  $('rsDate').addEventListener('change', takeTime);
  $('rsClock').addEventListener('keydown', e => {
    if (!rs) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setTime(Sched.step(rs.at || Sched.defaultAt(now()), e.key === 'ArrowUp' ? 1 : -1));
    } else if (e.key === 'Enter') { e.preventDefault(); if (!$('rsGo').disabled) $('rsGo').click(); }
  });
  $('rsTime').addEventListener('click', e => {
    const b = e.target.closest('button[data-add]');
    if (!b || !rs) return;
    const base = rs.at || Sched.combine($('rsDate').value, Sched.fmtTime(now())) || now();
    setTime(new Date(base.getTime() + b.dataset.add * 60000));
  });
  $('rsCancel').addEventListener('click', () => { rs = null; hideDlg(); });
  $('rsGo').addEventListener('click', async () => {
    const r = rs; if (!r || r.checking) return;
    if (!(r.guard && r.guard.ok)) { recheck(); return; }
    renderResend();
    if ($('rsGo').disabled) return;
    const rec = Records.get(r.id), p = rec && rec.pages.find(x => x.code === r.code);
    if (!p || !p.body) { rs = null; hideDlg(); return; }
    const rq = Records.resendRequest(p, { at: r.chk.kind === 'sched' ? r.at : null, guard: r.guard, ack: r.ack });
    const label = labelOf(p);
    rs = null; hideDlg();
    view.busy.add(r.key); render();
    const out = SendFlow.sendOutcome(SendFlow.apiResult(await Ext.call(rq.path, 'POST', rq.body)));
    view.busy.delete(r.key);
    if (r.fresh) Records.update(r.id, { guard: { checkId: r.guard.checkId, level: r.guard.level, reasons: r.guard.reasons || [] } });
    const saved = Records.updatePage(r.id, r.code, { status: out.ok ? 'ok' : 'fail', link: out.link || '', postId: out.postId || '', error: out.error || '',
      kind: rq.body.schedule ? 'sched' : 'now', schedule: rq.body.schedule, path: rq.path, body: rq.body, sentAt: new Date().toISOString(), resent: (p.resent || 0) + 1 });
    render();
    opts.toast(out.ok ? `${label}${rq.body.schedule ? '已排程' : '已發布'}` : `${label}重送失敗：${out.error}`);
    if (!saved) opts.toast(`${label}已送出，但紀錄沒寫進去（瀏覽器儲存空間已滿）`);
    const again = document.querySelector(`[data-rs="${r.key}"]`) || document.querySelector(`.rec[data-id="${r.id}"] [data-copy]`);
    if (again) again.focus();
  });

  function mount(o) {
    opts = Object.assign(opts, o || {});
    Records.onChange(render);
    window.addEventListener('storage', e => { if (e.key === Records.KEY) render(); });   // 其他分頁送出
    setInterval(render, 60000);                                                          // 排程時間到了改成「已發布 ↗」或「應已發布（推測）」
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    render();
  }
  window.RecList = { mount, render, view };
})();
