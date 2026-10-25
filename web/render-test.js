// 自製圖測試：把舊版 /render 請求的 image_url 換成瀏覽器產生的 data URL，看後端收不收。
(function () {
  const ORIGIN = location.origin;
  const $ = id => document.getElementById(id);
  const pending = new Map();
  let seq = 0, extReady = false, testDataUrl = '', lastReport = null;
  // 放在 GitHub Pages 的測試圖：看後端肯不肯抓外部網站的圖（自建暫存圖床的前提）
  const PUBLIC_IMG = new URL('test-image.jpg', location.href).href;

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || d.source !== 'snn-ext') return;
    if (d.type === 'ready') { setExt(true, d.version); return; }
    if (pending.has(d.nonce)) { pending.get(d.nonce)(d); pending.delete(d.nonce); }
  });
  function call(op, payload, timeout) {
    return new Promise(resolve => {
      const nonce = 'r' + Date.now().toString(36) + (seq++);
      const timer = setTimeout(() => { pending.delete(nonce); resolve({ ok: false, error: 'no_extension' }); }, timeout || 60000);
      pending.set(nonce, r => { clearTimeout(timer); resolve(r); });
      window.postMessage({ source: 'snn-web', nonce, op, payload }, ORIGIN);
    });
  }
  function setExt(ok, version) {
    extReady = ok;
    $('ext').className = 'status ' + (ok ? 'ok' : 'bad');
    $('ext').textContent = ok
      ? (version >= '0.2.0' ? `外掛：已連線（v${version}）` : `外掛：v${version} 太舊，請到 chrome://extensions 按外掛的「重新載入」後重新整理本頁`)
      : '外掛：沒有偵測到，請先載入 extension 資料夾後重新整理本頁。';
  }

  // 產生測試圖：漸層＋馬賽克＋黃色圓形貼圖＋時間戳記，一眼就能認出來
  function makeTestImage() {
    const c = document.createElement('canvas');
    c.width = c.height = 1080;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 1080, 1080);
    grad.addColorStop(0, '#7dd3fc'); grad.addColorStop(1, '#7c3aed');
    g.fillStyle = grad; g.fillRect(0, 0, 1080, 1080);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) {
      g.fillStyle = (x + y) % 2 ? '#94a3b8' : '#cbd5e1'; g.fillRect(140 + x * 30, 300 + y * 30, 30, 30);
    }
    g.fillStyle = '#facc15'; g.beginPath(); g.arc(800, 280, 130, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1f2a3d'; g.font = 'bold 120px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', 800, 285);
    const now = new Date();
    g.fillStyle = '#fff'; g.font = 'bold 76px sans-serif';
    g.fillText('DATA URL TEST', 540, 640);
    g.font = 'bold 56px sans-serif';
    g.fillText(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`, 540, 730);
    return c.toDataURL('image/jpeg', 0.9);
  }
  function setTestImage(url, info) {
    testDataUrl = url;
    $('testImg').src = url;
    $('imgInfo').textContent = `${info}・約 ${Math.round(url.length * 0.75 / 1024)} KB`;
  }
  $('file').addEventListener('change', () => {
    const f = $('file').files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setTestImage(r.result, `自選圖：${f.name}`);
    r.readAsDataURL(f);
  });

  function parsePayload() {
    const raw = $('payload').value.trim();
    if (!raw) return { error: '請先貼上舊版 render 的請求內容' };
    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || !('image_url' in p)) return { error: '內容裡沒有 image_url，請確認複製的是 render 那一筆' };
      return { payload: p };
    } catch (e) { return { error: '不是正確的 JSON：' + e.message }; }
  }
  $('payload').addEventListener('input', () => {
    const r = parsePayload();
    $('payloadHint').className = 'hint' + (r.error ? ' bad' : '');
    $('payloadHint').textContent = r.error || `✓ 讀到 template=${r.payload.template || '（空）'}、crop=${r.payload.crop ? '有' : '無'}`;
  });

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function run() {
    if (!extReady) { const p = await call('ping', {}, 1500); if (p.ok) setExt(true, p.version); else { setExt(false); return; } }
    const parsed = parsePayload();
    if (parsed.error) { $('payloadHint').className = 'hint bad'; $('payloadHint').textContent = parsed.error; return; }
    const base = parsed.payload;
    const prefix = $('prefix').value.trim().replace(/\/+$/, '');
    const cases = [
      { name: 'A 原始請求（對照組）', body: base },
      { name: 'B 自製圖＋原本的取景框', body: { ...base, image_url: testDataUrl } },
      { name: 'C 自製圖＋取景框清空', body: { ...base, image_url: testDataUrl, crop: null } },
      { name: 'D 公開網址圖＋原本的取景框', body: { ...base, image_url: PUBLIC_IMG } },
      { name: 'E 公開網址圖＋取景框清空', body: { ...base, image_url: PUBLIC_IMG, crop: null } }
    ];
    $('runBtn').disabled = true;
    $('resultWrap').hidden = false;
    $('results').innerHTML = '';
    $('verdict').className = 'verdict';
    $('verdict').textContent = '測試中…';
    const report = [];
    for (const c of cases) {
      const r = await call('call', { mode: 'b1', path: `${prefix}/render`, method: 'POST', body: c.body }, 90000);
      const d = r.data || {};
      const img = !!d.image;
      report.push({ case: c.name, ok: r.ok, status: d.status, contentType: d.contentType, image: img, error: r.error, snippet: d.snippet });
      const box = document.createElement('div');
      box.className = 'res';
      box.innerHTML = `<b>${esc(c.name)}</b><span class="tag ${img ? 'ok' : 'bad'}">${img ? '有回圖' : '沒有回圖'}・${esc(d.status ?? r.error ?? '—')}</span>` +
        (img ? `<img alt="${esc(c.name)} 結果">` : `<pre>${esc((d.snippet || r.error || '').slice(0, 400))}</pre>`);
      if (img) box.querySelector('img').src = d.image;
      $('results').appendChild(box);
    }
    lastReport = { at: new Date().toISOString(), prefix, testImageKB: Math.round(testDataUrl.length * 0.75 / 1024), report };
    const [a, b, cc, d, e] = report;
    let v, ok = false;
    if (!a.image) v = '對照組 A 就沒有回圖：請確認貼上的是 render 請求、API 前綴正確，再試一次。';
    else if (b.image || cc.image) { v = 'B 或 C 有回圖 → 請看圖：如果是測試圖加上網新的框和標題，代表後端收 data URL。'; ok = true; }
    else if (d.image || e.image) { v = 'D 或 E 有回圖 → 請看圖：如果是綠色「PUBLIC URL TEST」測試圖加上網新的框和標題，代表後端會抓外部網址，自建暫存圖床可行。'; ok = true; }
    else v = 'A 有回圖、B～E 都沒有 → 後端不收 data URL，也不抓外部網址，請按「複製文字結果」貼給我。';
    $('verdict').className = 'verdict' + (ok ? ' ok' : '');
    $('verdict').textContent = v;
    $('runBtn').disabled = false;
  }

  $('runBtn').addEventListener('click', run);
  $('copyBtn').addEventListener('click', () => {
    if (!lastReport) return;
    navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2)).then(() => { $('copyBtn').textContent = '已複製'; setTimeout(() => { $('copyBtn').textContent = '複製文字結果（回報用）'; }, 1500); });
  });
  setTestImage(makeTestImage(), '自動產生的測試圖');
  setTimeout(() => { if (!extReady) call('ping', {}, 1500).then(p => setExt(!!p.ok, p.version)); }, 300);
})();
