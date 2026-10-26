const test = require('node:test');
const assert = require('node:assert/strict');
const RD = require('../gas/rundown.gs');

// 仿 FB RUNDOWN 分頁：B＝1026、C＝1027、D＝1028；C 的分鐘碼在 D（隔天欄）
const rows = [
  ['', '＊發文以新聞影片優先', '', '', ''],
  ['', '1026', '1027', '1028', ''],
  ['主粉', '', '', '', ''],
  ['0800', '4041043/文字/險撞UFO', '4041477/文字/4萬元手錶', '0', ''],
  ['0810', '4041276/文字/闖燈猛撞', '/文字/', '-5', ''],
  ['0820', '4041074/文字/女師試圖', '', '1', ''],
  ['0830', '4041226/文字/康永友好', '4041548/圖文/愛告人', '15', ''],
  ['', '', '/圖文/', '2', ''],
  ['', '', '', '', ''],
  ['0900', '', '1', '0', ''],
  ['0915', '', '', '-5', ''],
  ['', '', '', '', ''],
  ['圖文', '3', '2', '', ''],
  ['娛樂粉', '', '', '', ''],
  ['0730', 'a', 'b', '', ''],
  ['', '', '', '', ''],
  ['0800', '', 'c', '', ''],
  ['', '', 'd', '', ''],
  ['', '', '', '', ''],
  ['0830', '', '', '', ''],
  ['0000', '', '', '', '']
];
const C = 2;   // 1027

test('分頁名稱：2026/10 優先，否則找同時含年與月的', () => {
  assert.equal(RD.rdFindSheetName(['2026/09', '2026/10', '2025/10'], 2026, 10), '2026/10');
  assert.equal(RD.rdFindSheetName(['FB 2026年10月'], 2026, 10), 'FB 2026年10月');
  assert.equal(RD.rdFindSheetName(['2026/09'], 2026, 10), null);
});

test('日期欄、區段、時段區塊', () => {
  assert.equal(RD.rdFindDateCol(rows, 10, 27), 2);
  assert.equal(RD.rdFindDateCol(rows, 10, 30), -1);
  assert.deepEqual(RD.rdFindSection(rows, 'news'), { start: 3, end: 12 });
  assert.deepEqual(RD.rdBlocks(rows, RD.rdFindSection(rows, 'news')).map(b => [b.start, b.end, b.min]), [[3, 9, 480], [9, 12, 540]]);
  assert.equal(RD.rdFindSection(rows, 'jkk'), null);
});

test('分鐘碼：-5＝:05、1＝:10、15＝:15；沒碼的列沿用上一列', () => {
  const blk = RD.rdBlocks(rows, RD.rdFindSection(rows, 'news'))[0];
  assert.deepEqual(RD.rdRowTimes(rows, blk, C), [480, 485, 490, 495, 500, 500]);
});

test('隔天欄被填掉時改用其他欄的分鐘碼；都沒有就看 A 欄時段', () => {
  const blk = RD.rdBlocks(rows, RD.rdFindSection(rows, 'news'))[0];
  assert.deepEqual(RD.rdRowTimes(rows, blk, 1), [480, 485, 490, 495, 500, 500]);   // B 的隔天欄 C 是內容 → 用 D
  const ent = RD.rdBlocks(rows, RD.rdFindSection(rows, 'ent'));
  assert.deepEqual(RD.rdRowTimes(rows, ent[1], C), [480, 480, 480]);
});

test('照時間順序：填在 ≤ 目標時間最後一筆稿子的下一格；/文字/、/圖文/ 預留格與前一天的分鐘碼可蓋', () => {
  const T = '1234567/圖文/測試圖文';
  assert.deepEqual(RD.rdPlan(rows, C, 'news', '08:07', T), { status: 'write', row: 4, time: '08:07' });   // :05 那格是 /文字/ → 直接填
  assert.deepEqual(RD.rdPlan(rows, C, 'news', '08:12', T), { status: 'write', row: 5, time: '08:12' });
  assert.deepEqual(RD.rdPlan(rows, C, 'news', '08:16', T), { status: 'write', row: 7, time: '08:16' });   // :15 有稿 → 下一格 /圖文/
  assert.deepEqual(RD.rdPlan(rows, C, 'news', '09:00', T), { status: 'write', row: 9, time: '09:00' });   // 前一天的分鐘碼
});

test('目標格已有稿子：插在這格，這個日期欄往下推到第一個可填的格子', () => {
  const g = rows.map(r => r.slice()); g[4][C] = '4041600/文字/甲'; g[5][C] = '4041601/文字/乙';
  assert.deepEqual(RD.rdPlan(g, C, 'news', '08:07', '1234567/圖文/測試圖文'), { status: 'insert', row: 5, shiftTo: 7, time: '08:07' });
});

test('同一天同區段已有同篇圖文就不重寫；文字稿不算重複', () => {
  assert.deepEqual(RD.rdPlan(rows, C, 'news', '08:40', '4041548/圖文/別的'), { status: 'exists', row: 6 });
  assert.notEqual(RD.rdPlan(rows, C, 'news', '08:40', '4041477/圖文/手錶').status, 'exists');
});

test('區段尾端的 0000 不會搶走白天的時間；排滿回錯誤', () => {
  assert.deepEqual(RD.rdPlan(rows, C, 'ent', '08:15', '1/圖文/x'), { status: 'write', row: 18, time: '08:15' });   // 接在現有稿子後面
  assert.equal(RD.rdPlan(rows, 3, 'ent', '07:40', '1/圖文/x').status, 'write');
  const full = rows.map(r => r.slice()); full[15][C] = 'z';
  assert.match(RD.rdPlan(full, C, 'ent', '07:30', '1/圖文/x').error, /07:30 時段.*排滿/);
});

test('A1 位址', () => {
  assert.equal(RD.rdA1(0, 0), 'A1');
  assert.equal(RD.rdA1(105, 27), 'AB106');
});

const W = require('../web/rundown.js');

test('網站端：SLUG 預設標題前 4 字；格式 文章ID/圖文/SLUG', () => {
  assert.equal(W.defaultSlug(['颱風假 最新！北北基桃', '明天照常']), '颱風假最');
  assert.equal(W.defaultSlug(['', 'a/b c d']), 'abcd');
  assert.equal(W.entryText('4041548', '颱風假'), '4041548/圖文/颱風假');
  assert.equal(W.cleanSlug(' 颱風 /假 '), '颱風假');
});

test('網站端：排程用排程時間、立即用送出時間；擠看看、氣象略過', () => {
  const { entries, skipped } = W.entries({ articleId: '4041548', slug: '', lines: ['颱風假最新'] },
    [{ code: 'news', at: '2026-10-27T08:05' }, { code: 'ent', at: new Date(2026, 9, 27, 21, 3) }, { code: 'jkk', at: '2026-10-27T08:05' }, { code: 'weather', at: '2026-10-27T09:00' }]);
  assert.deepEqual(entries, [
    { page: 'news', date: '2026-10-27', time: '08:05', text: '4041548/圖文/颱風假最' },
    { page: 'ent', date: '2026-10-27', time: '21:03', text: '4041548/圖文/颱風假最' }]);
  assert.deepEqual(skipped, ['jkk', 'weather']);
  assert.equal(W.entries({ articleId: '1', slug: '自訂', lines: ['x'] }, [{ code: 'intl', at: '2026-11-01T00:10' }]).entries[0].text, '1/圖文/自訂');
});

test('網站端：結果文字', () => {
  assert.equal(W.describe({ ok: true, status: 'write', cell: '2026/10!AB107', time: '08:10' }, '新聞'), '新聞 08:10 → AB107');
  assert.equal(W.describe({ ok: true, status: 'insert', cell: '2026/10!AB107', time: '08:10' }, '新聞'), '新聞 08:10 → AB107（插入）');
  assert.equal(W.describe({ ok: true, status: 'exists', cell: '2026/10!AB109' }, '新聞'), '新聞：已在 AB109（不重複寫）');
  assert.equal(W.describe({ ok: false, error: '08:00 時段在這天已經排滿' }, '娛樂'), '娛樂：08:00 時段在這天已經排滿');
});
