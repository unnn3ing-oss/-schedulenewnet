const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../web/payload.js');
const S = require('../web/sched.js');
const cfg = require('../web/config.js');

const URL_ = 'https://news.tvbs.com.tw/life/3012345';
const frame = (extra) => Object.assign({
  mode: 'single', frame: 'news', imageUrl: 'https://snn-images.19jpz-3.workers.dev/i/' + 'a'.repeat(32) + '.jpg',
  lines: ['颱風假 最新！北北基桃', ' 明天照常上班上課 ', ''], caption: '北北基桃明天照常上班上課！\n#颱風', url: URL_,
  guard: { checkId: 'g1', level: 'yellow', ack: false }, hasImage: true
}, extra);
const card = (extra) => Object.assign({
  mode: 'text_card', cardText: '【快訊】北市宣布\n明天停班停課', cardStyle: 'intl', caption: '快訊', url: '', lines: ['不該出現'],
  guard: { checkId: 'g2', level: 'green', ack: false }
}, extra);
const KEYS = ['ip', 'mode', 'template', 'image_url', 'crop', 'line1', 'line2', 'title_lines', 'caption', 'article_id', 'short_title', 'rd_write', 'guard'];

test('作圖框：通用欄位完全照交接文件 §4', () => {
  const b = P.buildBase(frame());
  assert.deepEqual(Object.keys(b), KEYS);
  assert.deepEqual(b, {
    ip: 'newsnet', mode: 'single', template: 'newsnet_news',
    image_url: 'https://snn-images.19jpz-3.workers.dev/i/' + 'a'.repeat(32) + '.jpg', crop: null,
    line1: '颱風假 最新！北北基桃', line2: '明天照常上班上課', title_lines: ['颱風假 最新！北北基桃', '明天照常上班上課'],
    caption: '北北基桃明天照常上班上課！\n#颱風', article_id: '3012345', short_title: '颱風假最新', rd_write: true,
    guard: { check_id: 'g1', level: 'yellow', ack: false }
  });
});

test('short_title：手動填優先', () => {
  assert.equal(P.buildBase(frame({ shortTitle: ' 颱風 ' })).short_title, '颱風');
});

test('guard.ack 只有紅燈才會是 true', () => {
  assert.equal(P.buildBase(frame({ guard: { checkId: 'x', level: 'red', ack: true } })).guard.ack, true);
  assert.equal(P.buildBase(frame({ guard: { checkId: 'x', level: 'red', ack: false } })).guard.ack, false);
  assert.equal(P.buildBase(frame({ guard: { checkId: 'x', level: 'green', ack: true } })).guard.ack, false);
});

test('純文字底圖：template／image_url 空、title_lines 空陣列、加上卡片欄位', () => {
  const b = P.buildBase(card());
  assert.deepEqual(Object.keys(b), KEYS.concat(['text', 'bg', 'text_color', 'width', 'height', 'wordmark', 'font', 'shadow', 'line_gap', 'center_on_canvas']));
  assert.equal(b.mode, 'text_card'); assert.equal(b.template, ''); assert.equal(b.image_url, ''); assert.equal(b.crop, null);
  assert.equal(b.line1, ''); assert.equal(b.line2, ''); assert.deepEqual(b.title_lines, []);
  assert.equal(b.article_id, '');
  assert.equal(b.short_title, '【快訊】北');
  assert.equal(b.text, '【快訊】北市宣布\n明天停班停課');
  assert.equal(b.bg, '#0d2b6b'); assert.equal(b.text_color, '#ffffff');
  assert.equal(b.width, 1080); assert.equal(b.height, 1080);
  assert.equal(b.wordmark, 'wordmark_newsnet.png'); assert.equal(b.font, 'hanwang');
  assert.equal(b.shadow, true); assert.equal(b.line_gap, 1.45); assert.equal(b.center_on_canvas, true);
});

test('版型只看藍框／粉框：每台都送同一個 template（newsnet_news／newsnet_ent）', () => {
  const all = cfg.pages.map(p => ({ code: p.code, at: null }));
  assert.ok(P.buildRequests(frame(), all).every(r => r.body.template === 'newsnet_news'));
  assert.ok(P.buildRequests(frame({ frame: 'ent' }), all).every(r => r.body.template === 'newsnet_ent'));
  assert.equal(P.buildBase(frame({ frame: undefined })).template, 'newsnet_news', '沒指定＝預設藍框');
  assert.equal(P.buildBase(card({ frame: 'ent' })).template, '', '純文字底圖 template 空字串');
  assert.equal(P.previewRequest(frame({ frame: 'ent' })).body.layout, 'newsnet_ent');
});

test('純文字底圖：卡面文字＝共用的標題（各行以 \\n 接起），title_lines／line1／line2 照交接文件為空', () => {
  const b = P.buildBase(card({ cardText: undefined, lines: [' 【快訊】北市宣布 ', '', '明天停班停課'] }));
  assert.equal(b.text, '【快訊】北市宣布\n明天停班停課');
  assert.deepEqual(b.title_lines, []); assert.equal(b.line1, ''); assert.equal(b.line2, '');
  assert.equal(b.short_title, '【快訊】北');
  assert.deepEqual(P.guardBody(card({ cardText: undefined, lines: ['甲', '乙'] })).text, '甲\n乙');
  assert.equal(P.validateInput(card({ cardText: undefined, lines: [' '] })), '請填文字內容');
});

test('每台一個請求：page、link（各台 UTM）、schedule、端點', () => {
  const at = S.combine('2026-10-26', '2130');
  const reqs = P.buildRequests(frame(), [{ code: 'news', at: null }, { code: 'shaokang', at }, { code: 'weather', at: null }]);
  assert.deepEqual(reqs.map(r => r.code), ['news', 'shaokang', 'weather']);
  assert.deepEqual(reqs.map(r => r.path), ['/publish', '/schedule', '/publish']);
  const [n, s, w] = reqs.map(r => r.body);
  assert.deepEqual(Object.keys(n), KEYS.concat(['page', 'link', 'schedule']));
  assert.equal(n.page, 'news'); assert.equal(n.schedule, '');
  assert.equal(n.link, URL_ + '?utm_source=facebook&utm_medium=fbarticlepic');
  assert.equal(s.page, 'shaokang'); assert.equal(s.schedule, '2026-10-26T21:30');
  assert.equal(s.link, URL_ + '?utm_source=facebook&utm_medium=2100roompic');
  assert.equal(w.link, URL_ + '?utm_source=Facebook&utm_medium=18weather', '氣象大寫 Facebook');
  // 共用欄位每台相同
  for (const b of [s, w]) for (const k of ['caption', 'image_url', 'template', 'title_lines', 'article_id', 'short_title']) assert.deepEqual(b[k], n[k]);
});
test('六台 link 追蹤碼與 rd_write（通用旗標，rd 空的粉專由後端略過）', () => {
  const reqs = P.buildRequests(frame(), cfg.pages.map(p => ({ code: p.code, at: null })));
  const byPage = Object.fromEntries(reqs.map(r => [r.code, r.body]));
  for (const p of cfg.pages) {
    assert.equal(byPage[p.code].link, URL_ + '?' + p.utm);
    assert.equal(byPage[p.code].rd_write, true, p.code);
  }
  // rd_write=false 則整篇不寫
  assert.ok(P.buildRequests(frame({ rdWrite: false }), [{ code: 'news', at: null }]).every(r => r.body.rd_write === false));
});

test('沒有文章網址：link 空字串、article_id 空字串', () => {
  const [r] = P.buildRequests(card(), [{ code: 'news', at: null }]);
  assert.equal(r.body.link, ''); assert.equal(r.body.article_id, '');
});

test('已含該台 UTM 不重複附加', () => {
  const url = URL_ + '?utm_source=facebook&utm_medium=fbarticlepic';
  const [r] = P.buildRequests(frame({ url }), [{ code: 'news', at: null }]);
  assert.equal(r.body.link, url);
});

test('不同台的 payload 互不影響（guard 物件不共用）', () => {
  const [a, b] = P.buildRequests(frame(), [{ code: 'news', at: null }, { code: 'ent', at: null }]);
  a.body.guard.ack = 'x';
  assert.equal(b.body.guard.ack, false);
});

test('未知粉專丟錯', () => {
  assert.throws(() => P.buildRequests(frame(), [{ code: 'nope', at: null }]), /unknown_page/);
});

test('guardBody／guardKey（§5）', () => {
  assert.deepEqual(P.guardBody(frame()), { ip: 'newsnet', title_lines: ['颱風假 最新！北北基桃', '明天照常上班上課'], caption: '北北基桃明天照常上班上課！\n#颱風', text: '' });
  assert.deepEqual(P.guardBody(card()), { ip: 'newsnet', title_lines: [], caption: '快訊', text: '【快訊】北市宣布\n明天停班停課' });
  assert.equal(P.guardKey(frame()), P.guardKey(frame({ frame: 'ent' })), '版型不影響判讀');
  assert.notEqual(P.guardKey(frame()), P.guardKey(frame({ caption: '改了' })));
});

test('previewRequest：作圖框 /render、純文字 /render_text_card', () => {
  const f = P.previewRequest(frame());
  assert.equal(f.path, '/render');
  // 照舊版實際格式：image_url、lines、layout、crop（沒有 template／title_lines）
  assert.deepEqual(Object.keys(f.body), ['image_url', 'lines', 'layout', 'crop']);
  assert.deepEqual(f.body.lines, ['颱風假 最新！北北基桃', '明天照常上班上課']);
  assert.equal(f.body.layout, 'newsnet_news');
  assert.equal(f.body.crop, null);
  const c = P.previewRequest(card());
  assert.equal(c.path, '/render_text_card');
  assert.deepEqual(c.body, Object.assign({ ip: 'newsnet' }, P.textCardFields('【快訊】北市宣布\n明天停班停課', 'intl')));
});

test('aiCaptionBody', () => {
  assert.deepEqual(P.aiCaptionBody('generate', frame({ summary: '摘要' })), { ip: 'newsnet', mode: 'generate', title: '颱風假 最新！北北基桃明天照常上班上課', summary: '摘要' });
  assert.deepEqual(P.aiCaptionBody('proofread', frame()), { ip: 'newsnet', mode: 'proofread', text: '北北基桃明天照常上班上課！\n#颱風', titles: ['颱風假 最新！北北基桃', '明天照常上班上課'] });
  assert.equal(P.aiCaptionBody('generate', card()).title, '【快訊】北市宣布\n明天停班停課');
});

test('validateInput：順序與訊息照舊版（§6.6）', () => {
  assert.equal(P.validateInput(card({ cardText: ' ' })), '請填文字內容');
  assert.equal(P.validateInput(card()), '');
  assert.equal(P.validateInput(frame({ url: '', hasImage: false, lines: [] })), '請先貼文章網址');
  assert.equal(P.validateInput(frame({ hasImage: false, lines: [] })), '需要照片');
  assert.equal(P.validateInput(frame({ lines: [' ', ''] })), '請填標題');
  assert.equal(P.validateInput(frame()), '');
});

test('aiCaptionResult：官方 generate 回應取 versions 第一個與 hashtags', () => {
  const real = { versions: ['庫存去化終於告一段落，記憶體今天大回神啦！📈'], hashtags: ['記憶體', '南亞科'], usedArticle: false, note: '' };
  assert.deepEqual(P.aiCaptionResult(real), { text: '庫存去化終於告一段落，記憶體今天大回神啦！📈', hashtags: ['記憶體', '南亞科'], note: '' });
  assert.deepEqual(P.aiCaptionResult({ versions: ['', ' 第二版 '], hashtags: ['#颱風', ' 停 班 '] }), { text: '第二版', hashtags: ['颱風', '停班'], note: '' });
  assert.equal(P.aiCaptionResult({ data: { text: '校對後' } }).text, '校對後');
  assert.deepEqual(P.aiCaptionResult({ versions: [], note: '內容不足' }), { text: '', hashtags: [], note: '' });
});

test('mergeHashtags：原有的優先，AI 的只補到 3 個、併進最後的 hashtag 行、不重複', () => {
  assert.equal(P.mergeHashtags('AI 文\n【標題】\n#南亞科 #股市', ['記憶體', '南亞科']), 'AI 文\n【標題】\n#南亞科 #股市 #記憶體');
  assert.equal(P.mergeHashtags('【標題】\n#股市', ['南亞科', '記憶體', '旺宏']), '【標題】\n#股市 #南亞科 #記憶體');
  assert.equal(P.mergeHashtags('【標題】\n#一 #二 #三', ['記憶體']), '【標題】\n#一 #二 #三');
  assert.equal(P.mergeHashtags('AI 文\n【標題】', ['記憶體']), 'AI 文\n【標題】\n#記憶體');
  assert.equal(P.mergeHashtags('AI 文 #記憶體', ['記憶體']), 'AI 文 #記憶體');
  assert.equal(P.mergeHashtags('有 #標籤 的句子', ['新']), '有 #標籤 的句子\n#新');
});
