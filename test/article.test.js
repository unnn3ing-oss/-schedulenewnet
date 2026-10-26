const test = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('./dom-shim.js');
global.DOMParser = DOMParser;   // parseArticle 用瀏覽器的 DOMParser；Node 用測試用的極簡版
const A = require('../web/article.js');
const R = require('../web/rules.js');

const URL0 = 'https://news.tvbs.com.tw/life/3012345';
const IMG = 'https://cc.tvbs.com.tw/img/upload/2026/10/26/20261026101010-aa.jpg';
// 類似 TVBS 文章頁：og:title 帶站名、og:image＝內文第一張圖、figcaption 有（圖／TVBS）、hashtag 是「#颱風」連結
const PAGE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>颱風假最新！北北基桃明天照常上班上課｜TVBS新聞網</title>
<meta property="og:title" content="颱風假最新！北北基桃　明天照常上班上課｜TVBS新聞網">
<meta property="og:image" content="${IMG}">
<meta name="keywords" content="不該用到,關鍵字">
</head><body>
<header><img src="/img/logo.png" alt="TVBS"></header>
<article>
  <h1>颱風假最新！北北基桃　明天照常上班上課</h1>
  <figure><img src="${IMG}?w=800" alt="颱風"><figcaption>北北基桃宣布明天照常上班上課。（圖／TVBS）</figcaption></figure>
  <p>記者 王小明（記者王小明／台北報導）颱風外圍環流影響&hellip;</p>
  <figure><img data-src="https://cc.tvbs.com.tw/img/b.jpg"><figcaption>（示意圖／shutterstock達志影像）</figcaption></figure>
  <div class="article-tags"><a href="/tag/颱風">#颱風</a><a href="/tag/停班停課">#停班停課</a><a href="/tag/氣象署">#氣象署</a><a href="/tag/北北基桃">#北北基桃</a><a href="/tag/颱風假">#颱風假</a></div>
</article></body></html>`;

test('parseArticle：標題去站名、主圖圖說、hashtag 連結', () => {
  const a = A.parseArticle(PAGE, URL0);
  assert.equal(a.title, '颱風假最新！北北基桃 明天照常上班上課');
  assert.equal(a.images[0].url, IMG);
  assert.equal(a.images[0].caption, '（圖／TVBS）');
  assert.deepEqual(a.images.map(i => i.url), [IMG, 'https://cc.tvbs.com.tw/img/b.jpg'], 'logo 不算；和 og:image 同一張不重複');
  assert.equal(a.images[1].caption, '（示意圖／shutterstock達志影像）');
  assert.equal(a.fallbackCaption, '（圖／TVBS）');
  assert.deepEqual(a.tags, ['颱風', '停班停課', '氣象署', '北北基桃', '颱風假']);
  assert.equal(A.mainCaption(a), '（圖／TVBS）');
});

test('parseArticle：沒有 hashtag 連結、標籤區、meta 時用 JSON-LD 的 keywords', () => {
  const html = `<html><head><meta property="og:title" content="測試標題 | TVBS">
<script type="application/ld+json">{"@type":"NewsArticle","keywords":"颱風,停班,氣象署,中央氣象署"}</script></head>
<body><article><p>內文沒有圖。</p></article></body></html>`;
  const a = A.parseArticle(html, URL0);
  assert.equal(a.title, '測試標題');
  assert.deepEqual(a.tags, ['颱風', '停班', '氣象署', '中央氣象署']);
  assert.deepEqual(a.images, []);
  assert.equal(A.mainCaption(a), '');
});

test('parseArticle：主圖不在內文時，主圖沒有圖說 → 用 fallbackCaption', () => {
  const html = `<html><head><meta property="og:image" content="https://cc.tvbs.com.tw/og.jpg"></head>
<body><article><figure><img src="https://cc.tvbs.com.tw/x.jpg"><figcaption>（圖／記者攝）</figcaption></figure></article></body></html>`;
  const a = A.parseArticle(html, URL0);
  assert.equal(a.images[0].caption, '');
  assert.equal(A.mainCaption(a), '（圖／記者攝）');
});

test('pickTags：只留 2～3 字、最多 3 個、互相包含的往後排', () => {
  assert.deepEqual(A.pickTags(['颱風', '停班停課', '氣象署', '北北基桃', '颱風假']), ['氣象署', '颱風', '颱風假']);
  assert.deepEqual(A.pickTags(['沈伯洋', '政治', '民進黨主席', '柯', '國民黨', '立法院']), ['沈伯洋', '政治', '國民黨']);
  assert.deepEqual(A.pickTags(['停班停課', '中央氣象署']), []);
  assert.deepEqual(A.pickTags(undefined), []);
});

test('formatCopy：【標題】／圖說／#標籤，缺的行就不出現', () => {
  assert.equal(A.formatCopy({ title: '颱風假最新！北北基桃 明天照常上班上課', caption: '（圖／TVBS）', tags: ['颱風', '停班停課', '氣象署'] }),
    '【颱風假最新！北北基桃 明天照常上班上課】\n（圖／TVBS）\n#颱風 #氣象署');
  assert.equal(A.formatCopy({ title: '標題', caption: '', tags: [] }), '【標題】');
  assert.equal(A.formatCopy({ title: '', caption: '（圖／TVBS）', tags: ['颱', '中央氣象署'] }), '（圖／TVBS）');
});

test('learnSeps／titleAsOneLine：沒改過的相鄰兩行接回原標題，新的用空格接', () => {
  const t = '蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始';
  const lines = R.breakTitle(t);
  const el = { value: lines.join('\n') };
  A.bindTitle(el);
  A.learnSeps(A.overrideOneLine(t), lines);
  assert.equal(A.titleAsOneLine(), t);
  el.value = lines.slice(0, 2).join('\n') + '\n賴清德：已開始';
  assert.equal(A.titleAsOneLine(), '蔡英文現身！12萬洋流挺沈伯洋 賴清德：已開始');
  A.learnSeps('', []);
  el.value = '颱風假最新！\n北北基桃\n\n明天照常上班';
  assert.equal(A.titleAsOneLine(), '颱風假最新！ 北北基桃 明天照常上班');
});

test('replaceTitleLine：不論在第幾行都只換【…】那一行', () => {
  const cap = 'AI 寫的開頭\n【舊標題】\n（圖／TVBS）\n#颱風';
  assert.deepEqual(A.replaceTitleLine(cap, '新標題', '舊標題'), { text: 'AI 寫的開頭\n【新標題】\n（圖／TVBS）\n#颱風', index: 1 });
  // 上次同步的標題找不到（小編改過【】裡面的字）→ 找第一個【…】行
  assert.deepEqual(A.replaceTitleLine('小編改的\n【小編改過的標題】\n#颱風', '新標題', '舊標題').text, '小編改的\n【新標題】\n#颱風');
  // AI 文字裡也有【…】：優先換上次同步的那一行
  assert.equal(A.replaceTitleLine('【快訊】AI 的開頭\n【舊標題】\n#颱風', '新', '舊標題').text, '【快訊】AI 的開頭\n【新】\n#颱風');
  assert.equal(A.replaceTitleLine('【快訊】\n【舊標題】', '新', '舊標題').text, '【快訊】\n【新】');
  // 【】那一行被刪掉：不補回來
  assert.deepEqual(A.replaceTitleLine('只有小編文\n#颱風', '新標題', '舊標題'), { text: '只有小編文\n#颱風', index: -1 });
  // 標題清空：留下【】，之後還接得上
  const empty = A.replaceTitleLine('【舊】\n#颱風', '', '舊');
  assert.equal(empty.text, '【】\n#颱風');
  assert.equal(A.replaceTitleLine(empty.text, '再打', '').text, '【再打】\n#颱風');
  assert.equal(A.replaceTitleLine('', 'x', null).index, -1);
});
