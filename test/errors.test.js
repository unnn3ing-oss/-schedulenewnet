// 錯誤訊息中文化：web/sendflow.js 的 zhError／niceError，以及外掛 extension/updater.js 的 Updater.zhError
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const F = require('../web/sendflow.js');
const W = require('../web/rundown.js');

const hasCjk = s => /[　-鿿＀-￯]/.test(s);
const dom = (name, message) => Object.assign(new Error(message), { name });

test('zhError：外掛 background／bridge 的錯誤代碼都翻成中文', () => {
  const codes = ['unknown_op', 'path_not_allowed', 'method_not_allowed', 'unknown_mode', 'host_not_allowed', 'not_html', 'not_image',
    'too_big', 'timeout', 'empty_response', 'no_extension', 'need_login', 'bad_image', 'no_image', 'export_failed', 'http_404', 'http_500'];
  for (const c of codes) {
    const m = F.zhError(c);
    assert.ok(hasCjk(m), `${c} → ${m}`);
    assert.ok(!m.includes(c), `${c} 不該原樣出現：${m}`);
  }
  assert.equal(F.zhError('http_404'), '網址找不到（HTTP 404）');
  assert.equal(F.zhError('http_503'), '網站回應錯誤（HTTP 503）');
  // 原有兩句維持不變
  assert.equal(F.extError('no_extension'), '外掛沒回應，請確認外掛已安裝並更新到 0.5.0');
  assert.equal(F.extError('path_not_allowed'), '外掛版本太舊（不允許這個端點），請更新到 0.5.0');
});

test('zhError：瀏覽器常見英文錯誤（fetch、中斷、DOMException）', () => {
  const net = '網路連線失敗，請確認網路後再試';
  assert.equal(F.zhError('Failed to fetch'), net);
  assert.equal(F.zhError('NetworkError when attempting to fetch resource.'), net);
  assert.equal(F.zhError('Load failed'), net);
  assert.equal(F.zhError(new TypeError('Failed to fetch')), net);
  assert.match(F.zhError('The user aborted a request.'), /中斷/);
  assert.match(F.zhError('signal is aborted without reason'), /中斷/);
  assert.match(F.zhError(dom('AbortError', 'The operation was aborted.')), /中斷/);
  assert.match(F.zhError(dom('NotAllowedError', 'Write permission denied.')), /不允許.*權限/);
  assert.match(F.zhError(dom('QuotaExceededError', 'The quota has been exceeded.')), /空間不足/);
  assert.match(F.zhError(dom('SecurityError', 'Must be handling a user gesture to show a file picker.')), /安全限制/);
  assert.match(F.zhError(dom('NotFoundError', 'A requested file or directory could not be found.')), /找不到/);
  assert.match(F.zhError(dom('InvalidStateError', 'x')), /狀態已改變/);
  assert.match(F.zhError(dom('EncodingError', 'The source image cannot be decoded.')), /讀不到這張圖片/);
});

test('zhError：Chrome 斷線錯誤沿用 extError 的兩句', () => {
  assert.match(F.zhError("Cannot read properties of undefined (reading 'sendMessage')"), /重新整理頁面/);
  assert.match(F.zhError('The message port closed before a response was received.'), /結果不明/);
});

test('zhError：中文原樣保留、認不得的英文附原文、空值有預設', () => {
  assert.equal(F.zhError('排程時間太近'), '排程時間太近');
  assert.equal(F.zhError(new Error('沒有登入圖床')), '沒有登入圖床');
  assert.equal(F.zhError('boom'), '外掛發生未知錯誤（原文：boom）');
  assert.equal(F.zhError('Exception: oops', 'Rundown 試算表發生錯誤'), 'Rundown 試算表發生錯誤（原文：Exception: oops）');
  assert.ok(F.zhError('x'.repeat(500)).length < 200);
  for (const v of [undefined, null, '']) assert.equal(F.zhError(v), '發生未知錯誤');
  // 重複套用不會疊加
  for (const v of ['boom', 'timeout', 'Failed to fetch', 'http_500', '已排程']) assert.equal(F.zhError(F.zhError(v)), F.zhError(v));
});

test('niceError：沒有原文時依狀態碼給中文說明；後端中文原樣保留、英文附原文', () => {
  assert.equal(F.niceError(404, ''), '後端找不到這個功能（HTTP 404），請回報');
  assert.equal(F.niceError(429, ''), '送出太頻繁，後端暫時擋下（HTTP 429），請等一下再試');
  assert.equal(F.niceError(500, ''), '後端發生錯誤（HTTP 500），請稍後再試');
  assert.equal(F.niceError(502, ''), '後端暫時連不上（HTTP 502），請稍後再試');
  assert.equal(F.niceError(503, ''), '後端暫時無法服務（HTTP 503），請稍後再試');
  assert.equal(F.niceError(504, ''), '後端處理逾時（HTTP 504），請稍後再試');
  assert.equal(F.niceError(418, ''), '後端拒絕了這次請求（HTTP 418），請稍後再試或回報');
  assert.equal(F.niceError(0, ''), '後端回應異常，請稍後再試');
  assert.equal(F.niceError(500, '{"detail":"產圖失敗"}'), 'HTTP 500：產圖失敗');
  assert.equal(F.niceError(500, 'Internal Server Error'), '後端發生錯誤（HTTP 500；原文：Internal Server Error）');
  assert.match(F.niceError(403, ''), /沒有登入網新/);
});

test('apiResult／parseGuard：外掛與後端的英文錯誤都變中文', () => {
  assert.equal(F.apiResult({ ok: false, error: 'Failed to fetch' }).error, '網路連線失敗，請確認網路後再試');
  assert.match(F.apiResult({ ok: false, error: 'unknown_op' }).error, /外掛版本太舊/);
  assert.equal(F.apiResult({ ok: false }).error, '發生未知錯誤');
  const ext = text => ({ ok: true, data: { status: 200, text } });
  assert.match(F.parseGuard(F.apiResult(ext('{"level":"green","error":"timeout"}'))).error, /逾時/);
});

test('backendError：後端／Apps Script 的英文不套瀏覽器判斷，加開頭附原文', () => {
  const ext = text => ({ ok: true, data: { status: 200, text } });
  assert.equal(F.apiResult(ext('{"ok":false,"error":"Graph API quota exceeded"}')).error, '後端回報錯誤（原文：Graph API quota exceeded）');
  assert.equal(F.apiResult(ext('{"ok":false,"error":"Permission denied for this page"}')).error, '後端回報錯誤（原文：Permission denied for this page）');
  assert.equal(F.backendError('已排程'), '已排程');
  assert.equal(F.backendError(''), '後端回報錯誤');
  assert.equal(W.describe({ ok: false, error: 'Exception: Network error' }, '新聞'), '新聞：Rundown 試算表發生錯誤（原文：Exception: Network error）');
});

test('zhError：舊紀錄裡的「外掛回報錯誤：英文」也翻成中文', () => {
  assert.equal(F.zhError('外掛回報錯誤：Failed to fetch'), '網路連線失敗，請確認網路後再試');
  assert.equal(F.zhError('外掛回報錯誤：boom'), '外掛發生未知錯誤（原文：boom）');
});

test('Rundown.describe：Apps Script 英文例外加上中文說明', () => {
  assert.equal(W.describe({ ok: false, error: 'Exception: Service Spreadsheets failed' }, '新聞'), '新聞：Rundown 試算表發生錯誤（原文：Exception: Service Spreadsheets failed）');
  assert.equal(W.describe({ ok: false, error: '找不到 2026/10 分頁' }, '新聞'), '新聞：找不到 2026/10 分頁');
});

test('外掛 Updater.zhError：資料夾／寫檔／下載錯誤變中文', () => {
  const ctx = { self: {}, crypto: globalThis.crypto, TextEncoder, TextDecoder, fetch: () => Promise.reject(new Error('no')) };
  ctx.self = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/updater.js'), 'utf8'), ctx);
  const Z = ctx.Updater.zhError;
  assert.match(Z(dom('NotAllowedError', 'The request is not allowed by the user agent or the platform in the current context.')), /存取權限/);
  assert.match(Z(dom('NotFoundError', 'A requested file or directory could not be found at the time an operation was processed.')), /找不到資料夾/);
  assert.match(Z(dom('NoModificationAllowedError', 'x')), /無法寫入/);
  assert.match(Z(dom('InvalidStateError', 'x')), /重試/);
  assert.match(Z(dom('QuotaExceededError', 'x')), /空間不足/);
  assert.match(Z(dom('SecurityError', 'Must be handling a user gesture to show a file picker.')), /安全限制/);
  assert.equal(Z(new TypeError('Failed to fetch')), '網路連線失敗，請確認網路後再試');
  assert.equal(Z(new Error('連不上 GitHub，請確認網路連線')), '連不上 GitHub，請確認網路連線');
  assert.equal(Z(new Error('weird'), '更新失敗'), '更新失敗（原文：weird）');
  assert.equal(Z(undefined, '更新失敗'), '更新失敗');
});
