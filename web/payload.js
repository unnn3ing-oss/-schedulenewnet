// 送出 payload（純函式，不碰 DOM）：瀏覽器是 window.Payload，Node 用 require。格式完全照 docs/newsnet_handoff.md §4、§5
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const cfg = node ? require('./config.js') : root.NEWSNET_CONFIG;
  const rules = node ? require('./rules.js') : root.Rules;
  const sched = node ? require('./sched.js') : root.Sched;
  const api = factory(cfg, rules, sched);
  if (node) module.exports = api; else root.Payload = api;
})(typeof self !== 'undefined' ? self : this, function (cfg, Rules, Sched) {
  const IP = cfg.ip.name;
  const clean = lines => (Array.isArray(lines) ? lines : []).map(l => String(l == null ? '' : l).trim());
  // 純文字底圖的卡面文字＝標題（兩種模式共用同一個標題框，照分行以 \n 接起來）；呼叫端也可以直接給 cardText
  const cardTextOf = input => String(input.cardText != null ? input.cardText : clean(input.lines).filter(Boolean).join('\n')).trim();
  const styleOf = key => cfg.textCardStyles.find(s => s.key === key) || cfg.textCardStyles[0];

  // 純文字底圖的額外欄位（§4）：底色、字色來自色票；寬高、wordmark、字體、陰影、行距、置中取自設定檔
  function textCardFields(text, styleKey) {
    const st = styleOf(styleKey), tc = cfg.ip.textCard;
    return {
      text: String(text == null ? '' : text).trim(), bg: st.bg, text_color: st.fg,
      width: cfg.ip.canvas[0], height: cfg.ip.canvas[1], wordmark: cfg.ip.wordmark,
      font: tc.font, shadow: tc.shadow, line_gap: tc.line_gap, center_on_canvas: tc.center_on_canvas
    };
  }

  // 守則判讀 body（§5）：text_card 時 title_lines 為空陣列、text 為卡面文字
  function guardBody(input) {
    const card = input.mode === 'text_card';
    return {
      ip: IP,
      title_lines: card ? [] : clean(input.lines).filter(Boolean),
      caption: String(input.caption == null ? '' : input.caption),
      text: card ? cardTextOf(input) : ''
    };
  }
  // 以 body 的 JSON 字串當 key：內容一改，key 就不同，燈號作廢
  const guardKey = input => JSON.stringify(guardBody(input));

  // 各粉專共用的部分（§4 通用欄位；粉專、link、schedule 另外加）
  //   input: { mode:'single'|'text_card', frame:'news'|'ent', imageUrl, lines[], caption, url, shortTitle, rdWrite, cardText, cardStyle,
  //            guard:{ checkId, level, ack } }
  function buildBase(input) {
    const card = input.mode === 'text_card';
    const lines = card ? [] : clean(input.lines);
    const titleLines = lines.filter(Boolean);
    const cardText = card ? cardTextOf(input) : '';
    const manual = String(input.shortTitle == null ? '' : input.shortTitle).trim();
    const g = input.guard || {};
    const base = {
      ip: IP,
      mode: card ? 'text_card' : 'single',
      template: card ? '' : Rules.frameTemplate(input.frame),   // 藍框 newsnet_news／粉框 newsnet_ent，每台都一樣
      image_url: card ? '' : String(input.imageUrl || ''),
      crop: null,                      // 圖床的圖已是成品尺寸，不取景（已驗證後端收 crop:null）
      line1: lines[0] || '',
      line2: lines[1] || '',
      title_lines: titleLines,
      caption: String(input.caption == null ? '' : input.caption),
      article_id: Rules.articleId(input.url),
      // 手動填優先；否則取標題第一行（純文字底圖沒有標題，取卡面文字第一行）去空白後前 5 字
      short_title: manual || Rules.shortTitle(card ? cardText.split('\n') : titleLines),
      rd_write: input.rdWrite !== false,
      guard: { check_id: String(g.checkId || ''), level: g.level || '', ack: g.level === 'red' ? !!g.ack : false }
    };
    if (card) Object.assign(base, textCardFields(cardText, input.cardStyle));
    return base;
  }

  // 單一粉專的完整 payload：at 為 null＝立即發布（schedule 傳空字串，打 /publish），否則打 /schedule
  function forPage(base, code, at, url) {
    const page = Rules.pageByCode(code);
    if (!page) throw new Error('unknown_page:' + code);
    return Object.assign({}, base, {
      rd_write: base.rd_write,                  // 通用旗標；rd 為空的粉專（擠看看、氣象）由後端略過 RD
      guard: Object.assign({}, base.guard),
      page: page.code,
      link: Rules.buildLink(url, page.utm),     // 沒有文章網址就是空字串
      schedule: at ? Sched.toScheduleString(at) : ''
    });
  }
  const endpointFor = at => (at ? '/schedule' : '/publish');

  // 每個勾選的粉專各一個請求：targets = [{ code, at: Date|null }]
  function buildRequests(input, targets) {
    const base = buildBase(input);
    return targets.map(t => ({ code: t.code, path: endpointFor(t.at), body: forPage(base, t.code, t.at || null, input.url) }));
  }

  // 後端預覽：作圖框打 /render、純文字打 /render_text_card
  // /render 的 body 照舊版發文台實際送出的格式（2026-10-26 由 DevTools 抓到）：{ image_url, lines, layout, crop }
  // 沒帶 layout 時後端會套預設 IP 的版型（女人我最大），所以欄位名稱不能改成 template／title_lines
  function previewRequest(input) {
    const base = buildBase(input);
    if (base.mode === 'text_card') return { path: '/render_text_card', body: Object.assign({ ip: IP }, textCardFields(base.text, input.cardStyle)) };
    return { path: '/render', body: { image_url: base.image_url, lines: base.title_lines.slice(), layout: base.template, crop: base.crop } };
  }

  // AI 小編文（§3）：generate 帶 title、summary；proofread 帶 text、titles
  function aiCaptionBody(kind, input) {
    const card = input.mode === 'text_card';
    const titles = card ? [cardTextOf(input)].filter(Boolean) : clean(input.lines).filter(Boolean);
    if (kind === 'generate') return { ip: IP, mode: 'generate', title: titles.join(' '), summary: String(input.summary || '') };
    return { ip: IP, mode: 'proofread', text: String(input.caption || ''), titles };
  }

  // 送出前檢查（§6.6，順序照舊版）：回錯誤訊息或空字串
  function validateInput(input) {
    if (input.mode === 'text_card') {
      if (!cardTextOf(input)) return '請填文字內容';
      return '';
    }
    if (!String(input.url || '').trim()) return '請先貼文章網址';
    if (!input.hasImage) return '需要照片';
    if (!clean(input.lines).some(Boolean)) return '請填標題';
    return '';
  }

  return { textCardFields, guardBody, guardKey, buildBase, forPage, endpointFor, buildRequests, previewRequest, aiCaptionBody, validateInput };
});
