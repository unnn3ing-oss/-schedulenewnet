const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../web/rules.js');
const cfg = require('../web/config.js');
const docs = require('../docs/newsnet_config.json');

test('config.js 與 docs/newsnet_config.json 一致', () => {
  assert.deepEqual(cfg.pages, docs.pages);
  assert.deepEqual(cfg.layouts, docs.layouts);
  assert.deepEqual(cfg.textCardStyles, docs.textCardStyles);
});

test('charWidth：全形 1、半形 0.5', () => {
  assert.equal(R.charWidth('颱風假'), 3);
  assert.equal(R.charWidth('abc'), 1.5);
  assert.equal(R.charWidth('颱風 A！'), 2 + 0.5 + 0.5 + 1);
  assert.equal(R.charWidth(''), 0);
  assert.equal(R.charWidth(null), 0);
});

test('articleId', () => {
  assert.equal(R.articleId('https://news.tvbs.com.tw/life/3012345'), '3012345');
  assert.equal(R.articleId('https://news.tvbs.com.tw/life/3012345?from=x'), '3012345');
  assert.equal(R.articleId('https://news.tvbs.com.tw/life/3012345#a'), '3012345');
  assert.equal(R.articleId('https://news.tvbs.com.tw/life/12345'), '');
  assert.equal(R.articleId(''), '');
});

test('shortTitle：第一行去空白取前 5 字', () => {
  assert.equal(R.shortTitle(['颱風假 最新！北北基桃', '明天']), '颱風假最新');
  assert.equal(R.shortTitle(['ab', 'x']), 'ab');
  assert.equal(R.shortTitle([]), '');
});

test('buildLink', () => {
  const utm = 'utm_source=facebook&utm_medium=fbarticlepic';
  assert.equal(R.buildLink('', utm), '');
  assert.equal(R.buildLink('https://a.tw/1234567', utm), 'https://a.tw/1234567?' + utm);
  assert.equal(R.buildLink('https://a.tw/1234567?x=1', utm), 'https://a.tw/1234567?x=1&' + utm);
  assert.equal(R.buildLink('https://a.tw/1234567#top', utm), 'https://a.tw/1234567?' + utm + '#top');
  const done = 'https://a.tw/1234567?' + utm;
  assert.equal(R.buildLink(done, utm), done, '已含同參數不重複');
  assert.equal(R.buildLink('https://a.tw/1?utm_medium=fbarticlepic&utm_source=facebook', utm), 'https://a.tw/1?utm_medium=fbarticlepic&utm_source=facebook');
});

test('buildLink：氣象大寫 Facebook 原樣帶出、不重複', () => {
  const wx = cfg.pages.find(p => p.code === 'weather').utm;
  assert.equal(wx, 'utm_source=Facebook&utm_medium=18weather');
  const link = R.buildLink('https://a.tw/1234567', wx);
  assert.ok(link.includes('utm_source=Facebook'));
  assert.ok(!link.includes('utm_source=facebook'));
  assert.equal(R.buildLink(link, wx), link);
  assert.equal(link.split('utm_source').length - 1, 1);
});

test('templateFor / canvasSizeFor / limitsFor', () => {
  assert.equal(R.templateFor('news'), 'newsnet_news');
  assert.equal(R.templateFor('intl'), 'newsnet_intl');
  assert.equal(R.templateFor('weather'), null);
  assert.deepEqual(R.canvasSizeFor('newsnet_news'), [1080, 1080]);
  assert.deepEqual(R.canvasSizeFor('newsnet_jkk'), [1080, 1080]);
  assert.deepEqual(R.canvasSizeFor('newsnet_intl'), [1200, 675]);
  assert.deepEqual(R.limitsFor('newsnet_intl'), [10, 16, 16]);
  assert.deepEqual(R.limitsFor('newsnet_ent'), [15, 15, 15]);
});

// 以下兩則取自 quickpatterntool/test/quickfill.test.js
test('breakTitle 對改標的換行維持原本行為（回歸）', () => {
  assert.strictEqual(R.breakTitle('蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始').length, 3);
});

test('overrideLines：改標有換行就照小編排好的分行，不再重新斷行', () => {
  assert.deepStrictEqual(R.overrideLines('定期保養的 5 個重點\n第 3 項最多人漏掉'), ['定期保養的 5 個重點', '第 3 項最多人漏掉']);
  assert.deepStrictEqual(R.overrideLines('iPhone 17 Pro開賣\n果粉：價格還能接受'), ['iPhone 17 Pro開賣', '果粉：價格還能接受']);
});

test('overrideLines：單行改標交給 breakTitle', () => {
  const t = '蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始';
  assert.deepStrictEqual(R.overrideLines(t), R.breakTitle(t));
});

test('breakTitle：強斷點與冒號補斷', () => {
  assert.deepStrictEqual(R.breakTitle('颱風假最新！北北基桃明天照常上班上課'), ['颱風假最新！', '北北基桃明天照常上班上課']);
  assert.deepStrictEqual(R.breakTitle('賴清德：對手認知作戰已開始'), ['賴清德：', '對手認知作戰已開始']);
});
