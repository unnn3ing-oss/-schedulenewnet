// 連線驗證頁：透過外掛（extension/bridge.js）呼叫網新後台，判斷 B1／B1o／B2 哪一種送法可用。
(function () {
  const ORIGIN = location.origin;
  const $ = id => document.getElementById(id);
  const MODES = [
    { key: 'b1', label: 'B1 外掛直接送' },
    { key: 'b1o', label: 'B1o 外掛直接送＋改 Origin' },
    { key: 'b2', label: 'B2 經網新分頁送' }
  ];
  const pending = new Map();
  let seq = 0, extReady = false, lastReport = null;

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || d.source !== 'snn-ext') return;
    if (d.type === 'ready') { setExt(true, d.version); return; }
    if (pending.has(d.nonce)) { pending.get(d.nonce)(d); pending.delete(d.nonce); }
  });

  function call(op, payload, timeout) {
    return new Promise(resolve => {
      const nonce = 'v' + Date.now().toString(36) + (seq++);
      const timer = setTimeout(() => { pending.delete(nonce); resolve({ ok: false, error: 'no_extension' }); }, timeout || 30000);
      pending.set(nonce, r => { clearTimeout(timer); resolve(r); });
      window.postMessage({ source: 'snn-web', nonce, op, payload }, ORIGIN);
    });
  }

  function setExt(ok, version) {
    extReady = ok;
    const el = $('ext');
    el.className = 'status ' + (ok ? 'ok' : 'bad');
    el.textContent = ok ? `外掛：已連線（v${version}）` : '外掛：沒有偵測到。請照上面第 2 步載入 extension 資料夾後重新整理本頁。';
  }

  // 判斷一次呼叫的結果
  function judge(r) {
    if (!r.ok) return { cls: 'bad', text: r.error === 'no_extension' ? '外掛沒回應' : '送出失敗：' + r.error };
    const d = r.data;
    const html = /text\/html/i.test(d.contentType) || /^\s*<(!doctype|html)/i.test(d.snippet);
    if (d.status >= 200 && d.status < 300 && !html) return { cls: 'ok', text: '成功（有帶到登入）' };
    if (d.status >= 200 && d.status < 300 && html) return { cls: 'warn', text: '回了網頁，可能被導去登入頁' };
    if (d.status === 401 || d.status === 403) return { cls: 'bad', text: `沒帶到登入（${d.status}）` };
    if (d.status === 404) return { cls: 'warn', text: '找不到端點（404），請試「API 路徑前綴」' };
    if (d.status === 400 || d.status === 422) return { cls: 'ok', text: `有到後端、參數被拒（${d.status}），登入應該是過的` };
    return { cls: 'warn', text: `狀態 ${d.status}` };
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function run() {
    if (!extReady) { const p = await call('ping', {}, 1500); if (p.ok) setExt(true, p.version); else { setExt(false); return; } }
    const prefix = $('prefix').value.trim().replace(/\/+$/, '');
    const article = $('article').value.trim();
    const calls = [];
    if (article) calls.push({ name: 'page_meta', path: `${prefix}/page_meta?url=${encodeURIComponent(article)}`, method: 'GET' });
    calls.push({ name: 'guard/check', path: `${prefix}/guard/check`, method: 'POST', body: { ip: 'newsnet', title_lines: ['連線測試'], caption: '連線測試', text: '' } });
    $('runBtn').disabled = true;
    $('resultCard').hidden = false;
    $('rows').innerHTML = '';
    $('verdict').className = 'verdict';
    $('verdict').textContent = '驗證中…（B2 可能會在背景開一個網新分頁）';
    const report = [];
    for (const m of MODES) {
      for (const c of calls) {
        const r = await call('call', { mode: m.key, path: c.path, method: c.method, body: c.body }, 45000);
        const j = judge(r);
        report.push({ mode: m.key, endpoint: c.name, verdict: j.cls, result: r });
        const d = r.data || {};
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${esc(m.label)}</td><td>${esc(c.name)}</td><td>${esc(d.status ?? '—')}</td><td><span class="tag ${j.cls}">${esc(j.text)}</span></td><td class="snip">${esc((d.snippet || r.error || '').slice(0, 200))}</td>`;
        $('rows').appendChild(tr);
      }
    }
    lastReport = { at: new Date().toISOString(), prefix, ua: navigator.userAgent, report };
    const okModes = MODES.filter(m => report.filter(x => x.mode === m.key).every(x => x.verdict === 'ok')).map(m => m.label);
    $('verdict').className = 'verdict' + (okModes.length ? ' ok' : '');
    $('verdict').textContent = okModes.length ? `可用的送法：${okModes.join('、')}` : '三種送法都沒有完全成功，請按下方「複製完整結果」回報。';
    $('runBtn').disabled = false;
  }

  async function showCookies() {
    const r = await call('cookies', {}, 3000);
    $('cookieCard').hidden = false;
    if (!r.ok) { $('cookies').textContent = '讀不到（' + (r.error === 'no_extension' ? '外掛沒回應' : r.error) + '）'; return; }
    const list = r.data;
    const has = list.some(c => c.name === 'queen_session');
    $('cookies').innerHTML = `<p class="${has ? '' : 'muted'}">${has ? '✓ 有 queen_session（後台登入）' : '✗ 沒有 queen_session，請先登入網新發文台'}</p>` +
      `<div class="tablewrap"><table><thead><tr><th>名稱</th><th>SameSite</th><th>HttpOnly</th><th>到期</th></tr></thead><tbody>${list.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.sameSite)}</td><td>${c.httpOnly ? '✓' : ''}</td><td>${esc(c.expires)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  $('runBtn').addEventListener('click', run);
  $('cookieBtn').addEventListener('click', showCookies);
  $('copyBtn').addEventListener('click', () => {
    if (!lastReport) return;
    navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2)).then(() => { $('copyBtn').textContent = '已複製'; setTimeout(() => { $('copyBtn').textContent = '複製完整結果（回報用）'; }, 1500); });
  });
  setTimeout(() => { if (!extReady) call('ping', {}, 1500).then(p => setExt(!!p.ok, p.version)); }, 300);
})();
