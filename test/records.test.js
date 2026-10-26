const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../web/records.js');
const S = require('../web/sched.js');

const NOW = new Date(2026, 9, 25, 14, 0, 0);   // 2026-10-25 14:00（本機時區）
const iso = (d, min) => new Date(d.getTime() + min * 60000).toISOString();
const sch = min => S.toScheduleString(new Date(NOW.getTime() + min * 60000));
function memStore(limit) {
  const mem = new Map();
  return { mem, getItem: k => (mem.has(k) ? mem.get(k) : null), removeItem: k => mem.delete(k),
    setItem(k, v) { if (limit && String(v).length > limit) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } mem.set(k, String(v)); } };
}
const THUMB = 'data:image/jpeg;base64,' + 'A'.repeat(4000);
const body = (code, extra) => Object.assign({ ip: 'newsnet', mode: 'single', page: code, image_url: 'https://img/i/1.jpg', title_lines: ['第一行', '第二行'], caption: 'cap', text: '',
  schedule: '', guard: { check_id: 'c1', level: 'red', ack: true } }, extra);

test('pageState：已發布／排程中／排程時間已過（推測）／失敗', () => {
  assert.equal(R.pageState({ status: 'ok', kind: 'now' }, NOW), 'published');
  assert.equal(R.pageState({ status: 'ok', kind: 'sched', schedule: sch(30) }, NOW), 'scheduled');
  assert.equal(R.pageState({ status: 'ok', kind: 'sched', schedule: sch(-1) }, NOW), 'due');
  assert.equal(R.pageState({ status: 'fail', kind: 'sched', schedule: sch(30) }, NOW), 'failed');
  assert.equal(R.pageState({ status: 'sending' }, NOW), 'unknown');
  assert.equal(R.fmtMD(new Date(2026, 0, 5, 9, 7)), '01/05 09:07');
  assert.equal(R.parseSchedule('bad'), null);
});

test('分頁籤篩選與數量：一筆可同時屬於多個分頁籤', () => {
  const list = [
    { id: 'a', pages: [{ status: 'ok', kind: 'now' }, { status: 'ok', kind: 'sched', schedule: sch(60) }, { status: 'fail', kind: 'now' }] },
    { id: 'b', pages: [{ status: 'ok', kind: 'sched', schedule: sch(-60) }] },   // 時間已過：算已發布（推測）
    { id: 'c', pages: [{ status: 'fail', kind: 'sched', schedule: sch(60) }] },
    { id: 'd' }                                                                    // 舊資料沒有 pages
  ];
  assert.deepEqual(R.counts(list, NOW), { all: 4, sched: 1, pub: 2, fail: 2 });
  assert.deepEqual(R.filter(list, 'fail', NOW).map(r => r.id), ['a', 'c']);
  assert.deepEqual(R.filter(list, 'pub', NOW).map(r => r.id), ['a', 'b']);
  assert.deepEqual(R.filter(list, 'nope', NOW).length, 4);
});

test('分頁：每頁 20、頁碼列（同 hottopic）', () => {
  const list = Array.from({ length: 45 }, (_, i) => i);
  assert.equal(R.PAGE_SIZE, 20);
  assert.equal(R.pageCount(45), 3); assert.equal(R.pageCount(0), 1); assert.equal(R.pageCount(20), 1);
  assert.deepEqual(R.slicePage(list, 3), [40, 41, 42, 43, 44]);
  assert.equal(R.clampPage(9, 3), 3); assert.equal(R.clampPage('x', 3), 1); assert.equal(R.clampPage(0, 3), 1);
  assert.deepEqual(R.pageWindow(1, 3), [1, 2, 3]);
  assert.deepEqual(R.pageWindow(5, 10), [1, '…', 4, 5, 6, '…', 10]);
  assert.deepEqual(R.pageWindow(1, 10), [1, 2, '…', 10]);
});

test('新的在前、原地更新、刪除、get', () => {
  let t = NOW.getTime();
  const rec = R.create(memStore(), () => new Date(t += 1000));
  const a = rec.add({ title: 'A', pages: [] }), b = rec.add({ title: 'B', pages: [] });
  assert.deepEqual(rec.list().map(r => r.title), ['B', 'A']);
  rec.updatePage(a, 'news', { status: 'fail', body: body('news') });
  rec.updatePage(a, 'news', { status: 'fail', error: 'x' });
  rec.updatePage(a, 'news', { status: 'ok', link: 'https://fb.com/1' });
  assert.equal(rec.list().length, 2, '重送不新增紀錄');
  assert.deepEqual(rec.list().map(r => r.title), ['B', 'A'], '更新不改變順序');
  const ra = rec.get(a);
  assert.equal(ra.pages.length, 1);
  assert.equal(ra.pages[0].status, 'ok');
  assert.equal(ra.pages[0].body, undefined, '成功的台不需要再重送：拿掉 body 省空間');
  assert.ok(rec.update(b, { caption: 'c' }));
  assert.equal(rec.get(b).caption, 'c');
  assert.ok(rec.remove(a));
  assert.equal(rec.remove(a), false);
  assert.deepEqual(rec.list().map(r => r.id), [b]);
  assert.equal(rec.get('nope'), null);
});

test('上限 200 筆、縮圖 7 天與格式檢查', () => {
  const store = memStore();
  let t = NOW.getTime() - 10 * 864e5;
  const rec = R.create(store, () => new Date(t));
  const old = rec.add({ title: 'old', thumb: THUMB });
  t = NOW.getTime();
  const fresh = rec.add({ title: 'fresh', thumb: THUMB });
  const bad = rec.add({ title: 'bad', thumb: 'javascript:alert(1)' });
  const big = rec.add({ title: 'big', thumb: 'data:image/jpeg;base64,' + 'A'.repeat(R.THUMB_CHARS) });
  assert.equal(rec.get(old).thumb, undefined, '超過 7 天的縮圖丟掉');
  assert.equal(rec.get(fresh).thumb, THUMB);
  assert.equal(rec.get(bad).thumb, undefined);
  assert.equal(rec.get(big).thumb, undefined, '超過約 20 KB 不存');
  for (let i = 0; i < R.MAX + 5; i++) rec.add({ title: String(i), thumb: THUMB });
  const all = rec.list();
  assert.equal(all.length, R.MAX);
  assert.equal(all.filter(r => r.thumb).length, R.THUMB_KEEP, '只有最新的幾筆帶縮圖');
});

test('QuotaExceeded：先丟縮圖，再砍舊紀錄；寫不進去回 false 不丟例外', () => {
  const store = memStore(60000);
  let t = NOW.getTime();
  const rec = R.create(store, () => new Date(t += 1000));
  for (let i = 0; i < 12; i++) rec.add({ title: 'r' + i, thumb: THUMB, pages: [{ code: 'news', status: 'ok' }] });
  assert.ok(store.mem.get(R.KEY).length <= 60000);
  assert.equal(rec.list()[0].title, 'r11', '最新的一定留著');
  const id = rec.add({ title: 'huge', caption: 'x'.repeat(59000) });
  assert.ok(rec.get(id), '砍舊紀錄後寫得進去');
  assert.equal(rec.error(), 'quota');
  assert.ok(rec.list().length < 13);
  const tiny = R.create(memStore(10), () => NOW);
  assert.doesNotThrow(() => tiny.add({ title: 'x' }));
  assert.deepEqual(tiny.list(), []);
});

test('相容 PR B 舊紀錄：沒有 lines／frame／thumb／body 也能顯示、篩選、複製', () => {
  const store = memStore();
  const oldRec = { id: 'r1', at: iso(NOW, -60), mode: 'single', title: '颱風假最新！北北基桃 明天照常上班上課', articleId: '3012345', url: 'https://news.tvbs.com.tw/life/3012345',
    pages: [{ code: 'news', label: '新聞', kind: 'now', schedule: '', status: 'ok', link: 'https://www.facebook.com/1', error: '' },
      { code: 'weather', label: '氣象', kind: 'now', schedule: '', status: 'fail', error: 'HTTP 502' }] };
  const oldCard = { id: 'r2', at: iso(NOW, -30), mode: 'text_card', title: '【快訊】北市\n明天停班停課', pages: [] };
  store.setItem(R.KEY, JSON.stringify([oldCard, oldRec, null, 'x', { noId: 1 }]));
  const rec = R.create(store, () => NOW);
  const list = rec.list();
  assert.deepEqual(list.map(r => r.id), ['r2', 'r1'], '壞資料略過、新的在前');
  assert.deepEqual(R.titleParts(oldRec), { first: '颱風假最新！北北基桃 明天照常上班上課', rest: '' });
  assert.deepEqual(R.titleParts(oldCard), { first: '【快訊】北市', rest: '明天停班停課' });
  assert.deepEqual(R.titleParts({ lines: ['一', ' ', '二', '三'] }), { first: '一', rest: '二 三' });
  assert.equal(R.titleParts({}).first, '（無標題）');
  assert.equal(R.modeLabel(oldRec), '作圖框'); assert.equal(R.frameLabel(oldRec), '');
  assert.equal(R.modeLabel(oldCard), '純文字底圖');
  assert.equal(R.frameLabel({ mode: 'single', frame: 'ent' }), '粉框');
  assert.deepEqual(R.counts(list, NOW), { all: 2, sched: 0, pub: 1, fail: 1 });
  assert.match(R.resendCheck(oldRec, 'weather', NOW).reason, /舊版紀錄/);
  assert.deepEqual(R.copyInput(oldRec), { mode: 'frame', frame: 'news', lines: ['颱風假最新！北北基桃 明天照常上班上課'], caption: '', url: oldRec.url, cardStyle: '' });
  assert.deepEqual(R.copyInput(oldCard).lines, ['【快訊】北市', '明天停班停課']);
  assert.equal(R.copyInput(oldCard).mode, 'text');
  // 舊紀錄可以照常更新（PR B 的 updatePage）
  rec.updatePage('r1', 'weather', { status: 'ok' });
  assert.equal(rec.get('r1').pages[1].status, 'ok');
});

test('copyInput：新紀錄帶標題、小編文、網址、版型、模式（不帶圖）', () => {
  const r = { mode: 'single', frame: 'ent', lines: ['金鐘61', '峮峮合體'], caption: '#金鐘', url: 'https://news.tvbs.com.tw/entertainment/3012399', cardStyle: 'red',
    thumb: THUMB, pages: [{ code: 'ent', body: body('ent') }] };
  const c = R.copyInput(r);
  assert.deepEqual(c, { mode: 'frame', frame: 'ent', lines: ['金鐘61', '峮峮合體'], caption: '#金鐘', url: r.url, cardStyle: 'red' });
  assert.equal('image' in c || 'imageUrl' in c || 'thumb' in c, false);
  // 沒有 lines 時從存的 body 還原分行
  assert.deepEqual(R.copyInput({ mode: 'single', title: 'x y', pages: [{ code: 'news', body: body('news') }] }).lines, ['第一行', '第二行']);
});

test('resendCheck：只有失敗且有存 body 的台；排程時間太近要選新時間；圖床過期不能重送', () => {
  const base = { id: 'r', at: iso(NOW, -60), imgExp: iso(NOW, 3 * 1440 - 60), guard: { checkId: 'c1', level: 'red', reasons: ['聳動'] } };
  const rec = Object.assign({}, base, { pages: [
    { code: 'news', kind: 'now', status: 'ok', link: 'https://fb.com/1' },
    { code: 'weather', kind: 'now', status: 'fail', body: body('weather') },
    { code: 'shaokang', kind: 'sched', schedule: sch(10), status: 'fail', body: body('shaokang', { schedule: sch(10) }) },
    { code: 'ent', kind: 'sched', schedule: sch(120), status: 'fail', body: body('ent', { schedule: sch(120) }) },
    { code: 'jkk', kind: 'sched', schedule: sch(-30), status: 'fail', body: body('jkk', { schedule: sch(-30) }) }
  ] });
  assert.match(R.resendCheck(rec, 'news', NOW).reason, /只有失敗/);
  assert.match(R.resendCheck(rec, 'nope', NOW).reason, /找不到/);
  assert.deepEqual(R.resendCheck(rec, 'weather', NOW), { ok: true, kind: 'now', at: null, needTime: false, needGuard: false });
  const sk = R.resendCheck(rec, 'shaokang', NOW);
  assert.equal(sk.kind, 'sched'); assert.equal(sk.needTime, true, '離現在不到 20 分鐘');
  assert.equal(R.resendCheck(rec, 'jkk', NOW).needTime, true, '時間已過');
  const ent = R.resendCheck(rec, 'ent', NOW);
  assert.equal(ent.needTime, false); assert.equal(ent.at.getTime(), NOW.getTime() + 120 * 60000);
  // 沒存燈號（舊紀錄）→ 需要重新判讀
  assert.equal(R.resendCheck(Object.assign({}, rec, { guard: undefined }), 'weather', NOW).needGuard, true);
  // 圖床的圖已過期（作圖框）→ 不能重送；純文字不受影響
  const expired = Object.assign({}, rec, { at: iso(NOW, -4 * 1440), imgExp: '' });
  assert.match(R.resendCheck(expired, 'weather', NOW).reason, /圖床的圖已失效/);
  const card = Object.assign({}, expired, { pages: [{ code: 'weather', kind: 'now', status: 'fail', body: body('weather', { mode: 'text_card', image_url: '' }) }] });
  assert.equal(R.resendCheck(card, 'weather', NOW).ok, true);
});

test('validateAt：同 Sched.validate，且作圖框不能晚於圖床失效', () => {
  const rec = { at: iso(NOW, -2 * 1440), pages: [{ code: 'news', body: body('news') }] };   // 圖約 1 天後失效
  assert.equal(R.validateAt(rec, new Date(NOW.getTime() + 10 * 60000), NOW).code, 'too_soon');
  assert.equal(R.validateAt(rec, new Date(NOW.getTime() + 60 * 60000), NOW), null);
  assert.equal(R.validateAt(rec, new Date(NOW.getTime() + 1.5 * 1440 * 60000), NOW).code, 'img_expire');
  const card = { at: rec.at, pages: [{ code: 'news', body: body('news', { image_url: '' }) }] };
  assert.equal(R.validateAt(card, new Date(NOW.getTime() + 1.5 * 1440 * 60000), NOW), null);
});

test('resendRequest：照存的 body 原樣送，只換時間與守則；紅燈要重新勾', () => {
  const p = { code: 'shaokang', body: body('shaokang', { schedule: sch(10), link: 'https://news.tvbs.com.tw/a?utm=x' }) };
  const at = new Date(2026, 9, 26, 21, 30);
  const noAck = R.resendRequest(p, { at, guard: { checkId: 'c2', level: 'red' }, ack: false });
  assert.equal(noAck.path, '/schedule');
  assert.equal(noAck.body.schedule, '2026-10-26T21:30');
  assert.deepEqual(noAck.body.guard, { check_id: 'c2', level: 'red', ack: false });
  assert.equal(p.body.schedule, sch(10), '不改到存的 body');
  const ok = R.resendRequest(p, { at, guard: { checkId: 'c2', level: 'red' }, ack: true });
  assert.equal(ok.body.guard.ack, true);
  const { schedule: _a, guard: _b, ...rest } = ok.body;
  const { schedule: _c, guard: _d, ...orig } = p.body;
  assert.deepEqual(rest, orig, '其他欄位完全一樣');
  const now = R.resendRequest({ body: body('news') }, { guard: { checkId: 'c', level: 'green' }, ack: true });
  assert.equal(now.path, '/publish');
  assert.equal(now.body.guard.ack, false, '非紅燈 ack 一律 false');
  assert.deepEqual(R.guardBodyOf({ body: body('news') }), { ip: 'newsnet', title_lines: ['第一行', '第二行'], caption: 'cap', text: '' });
  assert.deepEqual(R.guardBodyOf({ body: body('news', { mode: 'text_card', title_lines: [], text: '卡' }) }).text, '卡');
});

test('titleText：標題分行以 \\n 接起；純文字底圖是卡面文字；舊紀錄從 body 還原', () => {
  assert.equal(R.titleText({ mode: 'single', lines: [' 金鐘61 ', '', '峮峮合體'] }), '金鐘61\n峮峮合體');
  assert.equal(R.titleText({ mode: 'text_card', lines: ['【快訊】北市宣布', '明天停班停課'] }), '【快訊】北市宣布\n明天停班停課');
  assert.equal(R.titleText({ mode: 'single', title: 'x y', pages: [{ code: 'news', body: body('news') }] }), '第一行\n第二行');
  assert.equal(R.titleText({ mode: 'text_card', title: '舊\n卡' }), '舊\n卡');
});

const CARD = { ip: 'newsnet', text: '【快訊】\n停班', bg: '#c00', text_color: '#fff', width: 1080, height: 1080, wordmark: 'w', font: 'f', shadow: true, line_gap: 1.2, center_on_canvas: true };
test('renderRequest：/render 的 body 只有 image_url、lines、layout、crop；純文字打 /render_text_card', () => {
  const img = 'https://snn-images.19jpz-3.workers.dev/i/' + '1'.repeat(32) + '.jpg';
  // 新紀錄：存了送出當下的 render
  const a = R.renderRequest({ render: { path: '/render', body: { image_url: img, lines: ['一', '二'], layout: 'newsnet_ent', crop: null } } });
  assert.deepEqual(a, { path: '/render', body: { image_url: img, lines: ['一', '二'], layout: 'newsnet_ent', crop: null } });
  assert.deepEqual(Object.keys(a.body), ['image_url', 'lines', 'layout', 'crop']);
  // 多餘欄位不帶、crop 一律 null
  const b = R.renderRequest({ render: { path: '/render', body: { image_url: img, lines: ['一'], layout: 'newsnet_news', crop: { x: 1 }, template: 'x' } } });
  assert.deepEqual(Object.keys(b.body), ['image_url', 'lines', 'layout', 'crop']); assert.equal(b.body.crop, null);
  const c = R.renderRequest({ mode: 'text_card', render: { path: '/render_text_card', body: Object.assign({ extra: 1 }, CARD) } });
  assert.deepEqual(c, { path: '/render_text_card', body: CARD });
  // 舊紀錄：從失敗台存的 body 還原；沒 template 依版型
  const d = R.renderRequest({ frame: 'ent', pages: [{ code: 'ent', status: 'ok' }, { code: 'news', body: body('news', { template: 'newsnet_ent' }) }] });
  assert.deepEqual(d, { path: '/render', body: { image_url: 'https://img/i/1.jpg', lines: ['第一行', '第二行'], layout: 'newsnet_ent', crop: null } });
  assert.equal(R.renderRequest({ frame: 'ent', pages: [{ code: 'news', body: body('news') }] }).body.layout, 'newsnet_ent');
  assert.equal(R.renderRequest({ pages: [{ code: 'news', body: body('news') }] }).body.layout, 'newsnet_news');
  const e = R.renderRequest({ pages: [{ code: 'news', body: Object.assign(body('news', { mode: 'text_card', image_url: '', title_lines: [] }), CARD) }] });
  assert.deepEqual(e, { path: '/render_text_card', body: CARD });
  // 沒有可用資料
  assert.equal(R.renderRequest({ pages: [{ code: 'news', status: 'ok' }] }), null);
  assert.equal(R.renderRequest({ pages: [{ code: 'news', body: body('news', { image_url: '' }) }] }), null);
  assert.equal(R.renderRequest({ render: { path: '/render', body: { image_url: '' } } }), null);
});

test('copyImageCheck：圖床過期、舊紀錄不能複製圖片；純文字不受圖床影響', () => {
  const render = { path: '/render', body: { image_url: 'https://img/i/1.jpg', lines: ['一'], layout: 'newsnet_news', crop: null } };
  const fresh = { at: iso(NOW, -60), imgExp: iso(NOW, 3 * 1440 - 60), render };
  const okc = R.copyImageCheck(fresh, NOW);
  assert.equal(okc.ok, true); assert.deepEqual(okc.request, render);
  assert.equal(R.copyImageCheck(Object.assign({}, fresh, { imgExp: iso(NOW, -1) }), NOW).reason, '圖片已過期（圖床只保留 3 天）');
  assert.match(R.copyImageCheck({ at: iso(NOW, -4 * 1440), render }, NOW).reason, /圖片已過期/, '沒存 imgExp 以送出＋3 天估');
  assert.match(R.copyImageCheck({ at: iso(NOW, -60), pages: [{ code: 'news', status: 'ok' }] }, NOW).reason, /舊版紀錄沒有存出圖資料/);
  const card = { mode: 'text_card', at: iso(NOW, -10 * 1440), render: { path: '/render_text_card', body: CARD } };
  assert.equal(R.copyImageCheck(card, NOW).ok, true);
});

test('imageFileName：有文章編號用編號，否則用送出時間', () => {
  assert.equal(R.imageFileName({ articleId: '3012345', at: iso(NOW, 0) }), 'newsnet-3012345.png');
  assert.equal(R.imageFileName({ articleId: '', at: new Date(2026, 9, 5, 9, 7).toISOString() }), 'newsnet-20261005-0907.png');
});

test('prune：保留 render（只有網址與文字，很小）', () => {
  const render = { path: '/render', body: { image_url: 'https://img/i/1.jpg', lines: ['一'], layout: 'newsnet_news', crop: null } };
  const out = R.prune([{ id: 'a', at: iso(NOW, -60), render, pages: [{ code: 'news', status: 'ok', body: body('news') }] }], NOW);
  assert.deepEqual(out[0].render, render);
  assert.equal('body' in out[0].pages[0], false);
});
