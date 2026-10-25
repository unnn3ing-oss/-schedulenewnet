const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../web/sendflow.js');
const S = require('../web/sched.js');
const R = require('../web/records.js');

const NOW = new Date(2026, 9, 25, 14, 3, 0);
const ext = (status, text, extra) => ({ ok: true, data: Object.assign({ status, contentType: 'application/json', text }, extra) });

test('parseJson：最多 3 層、非 JSON 回 null', () => {
  assert.deepEqual(F.parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(F.parseJson(JSON.stringify(JSON.stringify({ detail: 'x' }))), { detail: 'x' });
  assert.deepEqual(F.parseJson('"純文字錯誤"'), { message: '純文字錯誤' });
  assert.equal(F.parseJson('<html>'), null);
  assert.equal(F.parseJson(''), null);
});

test('niceError：HTML 換成通用訊息、取 detail／message／error', () => {
  const html = '<!doctype html><html><body>' + 'x'.repeat(5000) + '</body></html>';
  assert.equal(F.niceError(502, html), '後端回傳錯誤頁（HTTP 502），請稍後再試');
  assert.equal(F.niceError(400, '{"detail":"排程時間太近"}'), 'HTTP 400：排程時間太近');
  assert.equal(F.niceError(422, '{"detail":[{"msg":"field required"}]}'), 'HTTP 422：field required');
  assert.equal(F.niceError(500, JSON.stringify(JSON.stringify({ error: { message: '深層' } }))), 'HTTP 500：深層');
  assert.match(F.niceError(401, ''), /沒有登入網新/);
  assert.ok(F.niceError(500, 'y'.repeat(1000)).length < 200);
});

test('apiResult', () => {
  assert.equal(F.apiResult({ ok: false, error: 'no_extension' }).ok, false);
  assert.match(F.apiResult({ ok: false, error: 'path_not_allowed' }).error, /0\.5\.0/);
  assert.deepEqual(F.apiResult(ext(200, '{"post_url":"https://fb.com/1"}')).json, { post_url: 'https://fb.com/1' });
  assert.equal(F.apiResult(ext(200, '<html>login</html>')).ok, false);
  assert.equal(F.apiResult(ext(200, '{"error":"bad"}')).ok, false);
  assert.equal(F.apiResult(ext(200, '{"ok":false,"message":"no"}')).error, 'no');
  assert.equal(F.apiResult(ext(200, '', { image: 'data:image/png;base64,AA' })).image, 'data:image/png;base64,AA');
  assert.equal(F.apiResult(ext(502, '<html>bad gateway</html>')).error, '後端回傳錯誤頁（HTTP 502），請稍後再試');
});

test('parseGuard：常見欄位、含 error 視為過期、格式不認得', () => {
  const g = F.parseGuard(F.apiResult(ext(200, '{"level":"RED","check_id":"c9","reasons":["標題聳動",{"msg":"未查證"}]}')));
  assert.deepEqual(g, { ok: true, level: 'red', checkId: 'c9', reasons: ['標題聳動', '未查證'] });
  assert.equal(F.parseGuard(F.apiResult(ext(200, '{"data":{"light":"黃燈","id":7}}'))).level, 'yellow');
  assert.equal(F.parseGuard(F.apiResult(ext(200, '{"data":{"light":"黃燈","id":7}}'))).checkId, '7');
  assert.equal(F.parseGuard(F.apiResult(ext(200, '{"level":"green","error":"timeout"}'))).ok, false);
  assert.equal(F.parseGuard(F.apiResult(ext(200, '{"foo":1}'))).ok, false);
  assert.equal(F.parseGuard({ ok: false, error: '外掛沒回應' }).error, '外掛沒回應');
});

test('sendOutcome：post_url 只收 https', () => {
  assert.deepEqual(F.sendOutcome(F.apiResult(ext(200, '{"post_url":"https://www.facebook.com/1_2","post_id":"1_2"}'))), { ok: true, link: 'https://www.facebook.com/1_2', postId: '1_2', message: '' });
  assert.equal(F.sendOutcome(F.apiResult(ext(200, '{"post_url":"javascript:alert(1)"}'))).link, '');
  assert.equal(F.sendOutcome(F.apiResult(ext(200, '{"message":"已排程"}'))).message, '已排程');
  assert.equal(F.sendOutcome(F.apiResult(ext(500, 'oops'))).ok, false);
});

const green = { ok: true, level: 'green', checkId: 'a', reasons: [] };
const yellow = { ok: true, level: 'yellow', checkId: 'a', reasons: ['用語較聳動'] };
const red = { ok: true, level: 'red', checkId: 'a', reasons: ['可能違反守則'] };

test('泡泡：列出各台與時間、綠燈可送', () => {
  const at = S.combine('2026-10-25', '2130');
  const b = F.bubble({ targets: [{ code: 'news', at: null }, { code: 'shaokang', at }], guard: green, ack: false, now: NOW });
  assert.equal(b.title, '確定送出 2 台？');
  assert.deepEqual(b.rows.map(r => [r.label, r.when, r.short]), [['新聞', '立即發布', '立即'], ['少康', '排程 21:30', '21:30']]);
  assert.equal(b.canConfirm, true); assert.equal(b.needAck, false);
  assert.equal(b.guardText, '守則綠燈');
});

test('泡泡：黃燈提醒後可送', () => {
  const b = F.bubble({ targets: [{ code: 'news', at: null }], guard: yellow, ack: false, now: NOW });
  assert.equal(b.canConfirm, true); assert.equal(b.guardText, '守則黃燈：用語較聳動');
});

test('泡泡：紅燈必須勾「我知道風險」', () => {
  const t = [{ code: 'news', at: null }];
  const no = F.bubble({ targets: t, guard: red, ack: false, now: NOW });
  assert.equal(no.needAck, true); assert.equal(no.canConfirm, false);
  assert.ok(no.blockers.some(x => /我知道風險/.test(x)));
  assert.equal(F.bubble({ targets: t, guard: red, ack: true, now: NOW }).canConfirm, true);
});

test('泡泡：判讀失敗不能送；排程太近擋下並標出是哪一台；沒選台', () => {
  const failed = F.bubble({ targets: [{ code: 'news', at: null }], guard: { ok: false, error: '判讀失敗：timeout' }, ack: true, now: NOW });
  assert.equal(failed.canConfirm, false); assert.equal(failed.guardText, '判讀失敗：timeout');
  const soon = F.bubble({ targets: [{ code: 'ent', at: new Date(NOW.getTime() + 10 * 60000) }], guard: green, ack: false, now: NOW });
  assert.equal(soon.canConfirm, false); assert.match(soon.rows[0].error, /20 分鐘/); assert.match(soon.blockers[0], /^娛樂：/);
  assert.equal(F.bubble({ targets: [], guard: green, now: NOW }).canConfirm, false);
});

test('狀態機：兩段式、點外面／改內容回第 1 步', () => {
  let s = 'idle';
  s = F.next(s, { type: 'click' }); assert.equal(s, 'checking');
  assert.equal(F.next(s, { type: 'click' }), 'checking', '判讀中再按無效');
  assert.equal(F.next(s, { type: 'edit' }), 'idle', '判讀中改內容作廢');
  assert.equal(F.next(s, { type: 'guard', stale: true }), 'idle');
  s = F.next(s, { type: 'guard', stale: false }); assert.equal(s, 'armed');
  assert.equal(F.next(s, { type: 'outside' }), 'idle');
  assert.equal(F.next(s, { type: 'edit' }), 'idle');
  assert.equal(F.next(s, { type: 'click', canConfirm: false }), 'armed', '紅燈沒勾：按了不動');
  assert.equal(F.next(s, { type: 'click', canConfirm: false, guardFailed: true }), 'checking', '判讀失敗：重判');
  s = F.next(s, { type: 'click', canConfirm: true }); assert.equal(s, 'sending');
  assert.equal(F.next(s, { type: 'edit' }), 'sending', '送出中改內容不影響');
  assert.equal(F.next(s, { type: 'outside' }), 'sending');
  assert.equal(F.next(s, { type: 'abort' }), 'idle');
  s = F.next(s, { type: 'sent' }); assert.equal(s, 'done');
  assert.equal(F.next(s, { type: 'resend' }), 'sending', '單台重送');
  assert.equal(F.next(s, { type: 'click' }), 'checking');
  assert.equal(F.next('idle', { type: 'sent' }), 'idle');
});

test('summary', () => {
  assert.equal(F.summary(['ok', 'ok', 'fail']), '2 台成功・1 台失敗');
  assert.equal(F.summary(['ok']), '1 台成功');
  assert.equal(F.summary([]), '');
});

test('Records：新增、更新單台、上限、壞資料', () => {
  const mem = new Map();
  const store = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
  const rec = R.create(store);
  const id = rec.add({ mode: 'single', title: 't', pages: [] });
  rec.updatePage(id, 'news', { status: 'fail', error: 'x' });
  rec.updatePage(id, 'news', { status: 'ok', link: 'https://fb.com/1', error: '' });
  rec.updatePage(id, 'weather', { status: 'ok' });
  const [r] = rec.list();
  assert.equal(r.id, id); assert.equal(r.mode, 'single');
  assert.deepEqual(r.pages.map(p => [p.code, p.status]), [['news', 'ok'], ['weather', 'ok']]);
  assert.equal(r.pages[0].link, 'https://fb.com/1');
  assert.equal(rec.updatePage('nope', 'news', {}), false);
  for (let i = 0; i < R.MAX + 5; i++) rec.add({ title: String(i) });
  assert.equal(rec.list().length, R.MAX);
  mem.set(R.KEY, '{bad');
  assert.deepEqual(rec.list(), []);
});
