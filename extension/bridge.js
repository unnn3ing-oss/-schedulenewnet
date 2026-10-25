// 只注入 GitHub Pages 介面：把網頁的 postMessage 轉給外掛背景，再把結果傳回網頁。
(function () {
  const ORIGIN = location.origin;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const d = event.data;
    if (!d || d.source !== 'snn-web' || typeof d.nonce !== 'string') return;
    const reply = res => window.postMessage({ source: 'snn-ext', nonce: d.nonce, ...res }, ORIGIN);
    try {
      chrome.runtime.sendMessage({ op: d.op, payload: d.payload || {} }, res => {
        if (chrome.runtime.lastError) reply({ ok: false, error: chrome.runtime.lastError.message });
        else reply(res || { ok: false, error: 'empty_response' });
      });
    } catch (e) { reply({ ok: false, error: String(e && e.message || e) }); }
  });
  window.postMessage({ source: 'snn-ext', type: 'ready', version: chrome.runtime.getManifest().version }, ORIGIN);
})();
