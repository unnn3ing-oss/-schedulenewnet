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
  assert.deepEqual(RD.rdPlan(g, C, 'news', '08:07', '1234567/圖文/測試圖文'), { status: 'insert', row: 5, shiftTo: 7, codeCol: 3, code: '-7', time: '08:07' });
});

// 照 rdAddOne 的順序在陣列上套用（moveTo：整段往下一格、原本最上面那格清空）
function apply(g, x, p, text) {
  const move = col => { for (let r = p.shiftTo; r > p.row; r--) g[r][col] = g[r - 1][col]; g[p.row][col] = ''; };
  move(x); g[p.row][x] = text;
  if (p.codeCol != null) { move(p.codeCol); g[p.row][p.codeCol] = p.code != null ? p.code : ''; }
  return g;
}

test('插入時隔天欄的分鐘碼跟著往下移：被推的稿子時間不變，新稿補上目標時間的分鐘碼', () => {
  // 仿 10/27 15:00 區塊：A 欄 1500/1515/1530/1545 疊在區塊開頭，分鐘碼在隔天欄，有些列沒碼（沿用上一列）
  const H = [['', '1027', '1028'], ['主粉', '', '']];
  const data = [['1500', '924/新加', '0'], ['1515', '966/鋼琴', '-5'], ['1530', '931/饗食', '1'], ['1545', '張雪機車', '15'], ['', '挖廢棄物', ''],
    ['', '764/河口', '2'], ['', '超商包裏', '25'], ['', '882/河口', '3'], ['', '', '35'], ['', '', '']];
  const g = H.concat(data.map(r => r.slice()));
  const blk = () => RD.rdBlocks(g, RD.rdFindSection(g, 'news'))[0];
  const timeOf = (grid, t) => { const b = blk(), ts = RD.rdRowTimes(grid, b, 1); return ts[grid.slice(b.start, b.end).findIndex(r => r[1] === t)]; };
  const before = ['張雪機車', '挖廢棄物', '764/河口', '超商包裏', '882/河口'].map(t => timeOf(g, t));
  const p = RD.rdPlan(g, 1, 'news', '15:13', '1234567/圖文/側視圖片');
  assert.deepEqual(p, { status: 'insert', row: 5, shiftTo: 10, codeCol: 2, code: '13', time: '15:13' });
  apply(g, 1, p, '1234567/圖文/側視圖片');
  assert.deepEqual(['張雪機車', '挖廢棄物', '764/河口', '超商包裏', '882/河口'].map(t => timeOf(g, t)), before, '被推下去的稿子時間不變');
  assert.equal(timeOf(g, '1234567/圖文/側視圖片'), 15 * 60 + 13, '15:13 → 補 13');
  assert.deepEqual(g.slice(2).map(r => r[2]), ['0', '-5', '1', '13', '15', '', '2', '25', '3', ''], '分鐘碼整段下移；被填掉的空格（:35）那一碼用掉');
});

test('分鐘碼：5 分格照舊，其他分鐘：負號＝0X 分、兩位數照寫', () => {
  assert.deepEqual(['0', '-5', '1', '15', '2', '55', '-3', '13', '47'].map(RD.rdCodeMin), [0, 5, 10, 15, 20, 55, 3, 13, 47]);
  assert.deepEqual([0, 5, 10, 15, 20, 55, 3, 13, 47].map(RD.rdMinCode), ['0', '-5', '1', '15', '2', '55', '-3', '13', '47']);
  assert.deepEqual(['', '6', '-0', '60', '/圖文/', '1500'].map(RD.rdCodeMin), [-1, -1, -1, -1, -1, -1]);
});

test('填入樣式和現有 /圖文/ 一樣：字級 12、粗體、紫色', () => {
  assert.deepEqual(RD.RD_STYLE, { size: 12, bold: true, color: '#9900ff' });
});

test('隔天欄已填內容（分鐘碼在別欄）：只推這一欄，不動別天的分鐘碼', () => {
  const g = rows.map(r => r.slice()); g[4][1] = '甲'; g[5][1] = '乙';
  const p = RD.rdPlan(g, 1, 'news', '08:07', '1/圖文/x');   // B 的隔天欄 C 是內容
  assert.equal(p.status, 'insert');
  assert.equal('codeCol' in p, false);
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

test('網站端：有區段的粉專各寫一筆；排程用排程時間、立即用送出時間；擠看看、氣象略過', () => {
  const { entries, skipped } = W.entries({ articleId: '4041548', slug: '', lines: ['颱風假最新'] },
    [{ code: 'news', at: '2026-10-27T08:05' }, { code: 'ent', at: new Date(2026, 9, 27, 21, 3) }, { code: 'jkk', at: '2026-10-27T08:05' }, { code: 'weather', at: '2026-10-27T09:00' }]);
  assert.deepEqual(entries, [
    { page: 'news', date: '2026-10-27', time: '08:05', text: '4041548/圖文/颱風假最' },
    { page: 'ent', date: '2026-10-27', time: '21:03', text: '4041548/圖文/颱風假最' }]);
  assert.deepEqual(skipped, ['jkk', 'weather']);
  assert.equal(W.entries({ articleId: '1', slug: '自訂', lines: ['x'] }, [{ code: 'intl', at: '2026-11-01T00:10' }]).entries[0].text, '1/圖文/自訂');
  assert.deepEqual(Object.values(W.PAGES), ['主粉（新聞粉）', '娛樂粉', '少康粉', '國際＋粉']);
});

test('網站端：結果文字', () => {
  assert.equal(W.describe({ ok: true, status: 'write', cell: '2026/10!AB107', time: '08:10' }, '新聞'), '新聞 08:10 → AB107');
  assert.equal(W.describe({ ok: true, status: 'insert', cell: '2026/10!AB107', time: '08:10' }, '新聞'), '新聞 08:10 → AB107（插入）');
  assert.equal(W.describe({ ok: true, status: 'exists', cell: '2026/10!AB109' }, '新聞'), '新聞：已在 AB109（不重複寫）');
  assert.equal(W.describe({ ok: false, error: '08:00 時段在這天已經排滿' }, '娛樂'), '娛樂：08:00 時段在這天已經排滿');
});
