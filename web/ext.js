// 外掛橋接客戶端：沿用 verify.js 的 postMessage 協定（web: {source:'snn-web',nonce,op,payload} → ext: {source:'snn-ext',nonce,...}）
(function () {
  const ORIGIN = location.origin;
  const pending = new Map();
  let seq = 0, version = null;
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || d.source !== 'snn-ext') return;
    if (d.type === 'ready') { version = d.version; return; }
    if (pending.has(d.nonce)) { pending.get(d.nonce)(d); pending.delete(d.nonce); }
  });
  function send(op, payload, timeout) {
    return new Promise(resolve => {
      const nonce = 'a' + Date.now().toString(36) + (seq++);
      const timer = setTimeout(() => { pending.delete(nonce); resolve({ ok: false, error: 'no_extension' }); }, timeout || 30000);
      pending.set(nonce, r => { clearTimeout(timer); resolve(r); });
      window.postMessage({ source: 'snn-web', nonce, op, payload: payload || {} }, ORIGIN);
    });
  }
  window.Ext = {
    prefix: '',                                   // 後端 API 路徑前綴（驗證頁可調；預設根目錄）
    send,
    version: () => version,
    async ping(timeout) { const r = await send('ping', {}, timeout || 1500); if (r.ok) version = r.version; return r; },
    cookies: () => send('cookies', {}, 5000),
    // 走外掛 B1（背景直接 fetch，帶登入 cookie）；回 { ok, data:{status, contentType, snippet, text} } 或 { ok:false, error }
    call(path, method, body) { return send('call', { mode: 'b1', path: Ext.prefix + path, method: method || 'GET', body }, 45000); },
    // 下載 tvbs.com.tw 的圖片，回 { ok, data:{ image: dataURL } }（避免跨網域圖污染畫布）
    fetchImage: url => send('fetchImage', { url }, 45000)
  };
})();
