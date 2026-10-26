// 文章解析與小編文的「圖文格式」（同 QPT 的「複製圖文格式」）：瀏覽器是 window.Article，Node 用 require。
// parseArticle 需要 DOMParser（瀏覽器內建；Node 測試用 test/dom-shim.js）。文章 HTML 由外掛的 fetchArticle 代為下載。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Article = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ===== 以下 圖說、網頁解析、圖文格式 整段複製自 quickpatterntool/quickfill.js（逐字，不要改；QPT 改了就同步）=====
  // ---- 圖說（攝影／來源）-------------------------------------------------------
  // 直接抓括號「（…）」「(…)」裡的文字，例如：
  //   （圖／王小明攝）、（示意圖／Shutterstock達志影像）、（組圖／沈伯洋辦公室提供、柯文哲臉書）
  // 不再限定開頭一定要是「圖」「示意圖」…。不過括號在內文裡也很常見（「（記者王小明／台北報導）」），
  // 所以依文字出現的位置分三級，位置越不可靠，認定越嚴格：
  //   any    ：圖片自己的 figcaption，括號裡任何文字都算（有「／」的優先）
  //   slash  ：圖片旁邊的文字、alt／title，要「短標籤／內容」的形式
  //   strict ：整頁文字裡找，標籤還必須以「圖、照、片、畫面、影像、翻攝」等結尾
  const SLASH_INNER = /^[^／/]{1,12}[／/]\s*\S/;
  const STRICT_INNER = /^[^（）()／/\s]{0,10}(?:圖|照|片|畫面|影像|翻攝|攝影)\s*[／/]\s*\S/;
  const MAX_CAPTION = 90;

  function normalizeCaption(s) {
    return s.replace(/\(/g, '（').replace(/\)/g, '）').replace(/\//, '／').replace(/\s+/g, ' ').trim();
  }

  // 找出最外層的括號群組（支援括號裡再有括號，半形全形混用）
  function parenGroups(text) {
    const out = [];
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '（' || ch === '(') { if (depth === 0) start = i; depth++; }
      else if ((ch === '）' || ch === ')') && depth > 0) {
        depth--;
        if (depth === 0) out.push(text.slice(start, i + 1));
      }
    }
    return out;
  }

  function pickCaption(text, mode = 'slash') {
    if (!text) return '';
    const groups = parenGroups(text).filter(g => {
      const inner = g.slice(1, -1).trim();
      return inner && inner.length <= MAX_CAPTION;
    });
    const innerOf = g => g.slice(1, -1).trim();
    if (mode === 'any') {
      const hit = groups.find(g => SLASH_INNER.test(innerOf(g))) || groups[0];
      if (hit) return normalizeCaption(hit);
    } else if (mode === 'slash') {
      const hit = groups.find(g => SLASH_INNER.test(innerOf(g)));
      if (hit) return normalizeCaption(hit);
    } else {
      const hit = groups.find(g => STRICT_INNER.test(innerOf(g)));
      if (hit) return normalizeCaption(hit);
    }
    // 沒有括號、整段就是「圖／來源」的寫法時，自己補上括號
    const plain = text.trim();
    if (mode !== 'strict' && plain.length <= MAX_CAPTION && STRICT_INNER.test(plain) && !/[（）()]/.test(plain)) {
      return `（${normalizeCaption(plain)}）`;
    }
    return '';
  }

  // ---- 網頁解析 ----------------------------------------------------------------
  function meta(doc, ...keys) {
    for (const key of keys) {
      for (const el of doc.querySelectorAll('meta')) {
        const k = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
        const v = (el.getAttribute('content') || '').trim();
        if (k === key && v) return v;
      }
    }
    return '';
  }
  function metaAll(doc, key) {
    return [...doc.querySelectorAll('meta')]
      .filter(el => (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase() === key)
      .map(el => (el.getAttribute('content') || '').trim())
      .filter(Boolean);
  }

  // 去掉標題尾巴的站名，例如「…｜TVBS新聞網」
  function cleanTitle(t) {
    return t.replace(/\s+/g, ' ').replace(/\s*[|｜│\-–—]\s*(?:TVBS|.{0,12}新聞網|.{0,12}娛樂).*$/i, '').trim();
  }

  function resolveUrl(u, base) {
    if (!u) return '';   // new URL('', base) 會回傳 base 本身
    try { return new URL(u, base).href; } catch (e) { return ''; }
  }
  function sameImage(a, b) {
    const strip = u => u.split(/[?#]/)[0];
    return strip(a) === strip(b);
  }
  const JUNK_IMG = /(^|[\/_.-])(logo|icon|avatar|sprite|pixel|blank|placeholder|spacer)([\/_.-]|$)/i;
  function imgSrc(img, base) {
    for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'src']) {
      const v = (img.getAttribute(attr) || '').trim();
      if (v && !v.startsWith('data:')) return resolveUrl(v, base);
    }
    const srcset = (img.getAttribute('data-srcset') || img.getAttribute('srcset') || '').trim();
    if (srcset) {
      const last = srcset.split(',').pop().trim().split(/\s+/)[0];   // 通常最後一個最大張
      if (last) return resolveUrl(last, base);
    }
    return '';
  }

  // 在圖片附近找圖說：figure/figcaption → 後面幾層的相鄰文字 → alt/title
  function captionForImg(img) {
    const fig = img.closest('figure');
    if (fig) {
      const c = pickCaption((fig.querySelector('figcaption') || {}).textContent || '', 'any');
      if (c) return c;
    }
    let node = img;
    for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
      for (let sib = node.nextElementSibling, n = 0; sib && n < 2; sib = sib.nextElementSibling, n++) {
        if (sib.tagName === 'IMG' || sib.querySelector('img')) break;   // 那是下一張圖，圖說不屬於這張
        const text = (sib.textContent || '').trim();
        if (text.length <= 200) {
          const c = pickCaption(text, 'slash');
          if (c) return c;
        }
      }
    }
    return pickCaption(img.getAttribute('alt') || '', 'slash') || pickCaption(img.getAttribute('title') || '', 'slash');
  }

  function collectHashtags(doc) {
    const out = [];
    const add = raw => {
      const t = String(raw).replace(/^[#＃\s]+/, '').replace(/\s+/g, '').trim();
      if (t && t.length <= 30 && !out.includes(t)) out.push(t);
    };
    const scope = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    // 1) 頁面上以「#」顯示的標籤連結
    scope.querySelectorAll('a').forEach(a => { if (/^[#＃]\S/.test((a.textContent || '').trim())) add(a.textContent); });
    // 2) 標籤區塊（class 含 tag／keyword／hashtag）裡的連結
    if (!out.length) {
      doc.querySelectorAll('[class*="hashtag" i] a, [class*="tags" i] a, [class*="tag-" i] a, [class*="tag_" i] a, [class*="keyword" i] a')
        .forEach(a => add(a.textContent));
    }
    // 3) 網址長得像標籤頁的連結（文章區內）
    if (!out.length) {
      scope.querySelectorAll('a[href*="/tag/"], a[href*="/tags/"], a[href*="/keyword/"]').forEach(a => add(a.textContent));
    }
    // 4) meta 標籤
    if (!out.length) metaAll(doc, 'article:tag').forEach(add);
    if (!out.length) {
      const kw = meta(doc, 'news_keywords', 'keywords');
      kw.split(/[,，、]/).forEach(add);
    }
    // 5) JSON-LD 的 keywords
    if (!out.length) {
      doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try {
          const walk = v => {
            if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') {
              if (v.keywords) (Array.isArray(v.keywords) ? v.keywords : String(v.keywords).split(/[,，、]/)).forEach(add);
              Object.values(v).forEach(walk);
            }
          };
          walk(JSON.parse(s.textContent));
        } catch (e) { /* 不是合法 JSON 就略過 */ }
      });
    }
    return out;
  }

  // 回傳 { title, tags, images: [{url, caption}], fallbackCaption }
  function parseArticle(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rawTitle = meta(doc, 'og:title', 'twitter:title')
      || ((doc.querySelector('h1') || {}).textContent || '').trim()
      || ((doc.querySelector('title') || {}).textContent || '').trim();
    const title = cleanTitle(rawTitle);

    // 內文圖片（依出現順序）；文章區優先，再補頁面其他圖片
    const scope = doc.querySelector('article') || doc.querySelector('main') || doc.body;
    const imgs = [...scope.querySelectorAll('img'), ...[...doc.querySelectorAll('img')].filter(i => !scope.contains(i))];
    const bodyImages = [];
    for (const img of imgs) {
      const url = imgSrc(img, baseUrl);
      if (!url || /\.(svg|gif)(\?|#|$)/i.test(url) || JUNK_IMG.test(url)) continue;
      if (bodyImages.some(b => sameImage(b.url, url))) continue;
      bodyImages.push({ url, caption: captionForImg(img) });
    }

    const images = [];
    const ogUrl = resolveUrl(meta(doc, 'og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'), baseUrl);
    const firstBodyCaption = (bodyImages.find(b => b.caption) || {}).caption || '';
    if (ogUrl) {
      const same = bodyImages.find(b => sameImage(b.url, ogUrl));
      images.push({ url: ogUrl, caption: (same && same.caption) || '' });
    }
    bodyImages.forEach(b => { if (!images.some(i => sameImage(i.url, b.url))) images.push(b); });

    const fallbackCaption = firstBodyCaption || pickCaption(scope.textContent || '', 'strict');
    return { title, tags: collectHashtags(doc), images, fallbackCaption };
  }

  // ---- 複製用的圖文格式 --------------------------------------------------------
  //   【標題】
  //   （圖／OOO 攝）
  //   #標籤 #標籤 #標籤
  // 挑 hashtag（最多 3 個）：
  //   0) 只留 2～3 個字的（太短像雜訊、太長放不下）；其他字數的直接不要，不夠 3 個就少於 3 個，不補。
  //   1) 優先「無重複文字」的：不和其他標籤互相包含（例如有「沈伯洋」又有「沈伯洋辦公室」，兩個都算重複）。
  //   同一級裡維持網頁上的原本順序。選的時候，和已經選好的標籤重複（互相包含）的先跳過；
  //   不夠 3 個時才用被跳過的補滿。
  function pickTags(tags, count = 3) {
    const list = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))]
      .filter(t => { const n = [...t].length; return n >= 2 && n <= 3; });
    const key = t => t.toLowerCase();
    const overlaps = (a, b) => key(a).includes(key(b)) || key(b).includes(key(a));
    const ranked = list.map((t, i) => ({ t, i, rank: list.some(o => o !== t && overlaps(t, o)) ? 1 : 0 }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);
    const picked = [];
    for (const { t } of ranked) {
      if (picked.length >= count) break;
      if (!picked.some(p => overlaps(p, t))) picked.push(t);
    }
    for (const { t } of ranked) {
      if (picked.length >= count) break;
      if (!picked.includes(t)) picked.push(t);
    }
    return picked;
  }

  function formatCopy({ title, caption, tags }) {
    const lines = [];
    if (title) lines.push(`【${title}】`);
    if (caption) lines.push(caption);
    const tagLine = pickTags(tags).map(t => `#${t}`).join(' ');
    if (tagLine) lines.push(tagLine);
    return lines.join('\n');
  }
  // ===== 複製結束 =====

  // ===== 以下 overrideOneLine 整段複製自 quickpatterntool/quickfill.js（逐字，不要改；QPT 改了就同步）=====
  // 複製圖文格式的標題是單行：換行接成空格
  function overrideOneLine(override) {
    return /\n/.test(override) ? override.split('\n').map(l => l.trim()).filter(Boolean).join(' ') : override;
  }
  // ===== 複製結束 =====

  // QPT 的 titleAsOneLine 直接讀側邊欄的標題框（titleEl）；這裡由 app.js 用 bindTitle 綁上正式介面的標題框
  let titleEl = null;
  function bindTitle(el) { titleEl = el; }

  // ===== 以下 learnSeps／titleAsOneLine 整段複製自 quickpatterntool/quickfill.js（逐字，不要改；QPT 改了就同步）=====
  // ---- 預覽上改標題 → 同步「複製圖文格式」第一行【標題】 ------------------------------------
  // 預覽的標題是分行的、複製用的是一行：沒改過的相鄰兩行，接回文章原本的樣子（原本有沒有空格）；
  // 新的相鄰兩行用一個空格接起來。
  let origSeps = new Map();
  function learnSeps(orig, lines) {
    origSeps = new Map();
    let pos = 0;
    for (let i = 0; i + 1 < lines.length; i++) {
      const a = orig.indexOf(lines[i], pos);
      if (a < 0) { origSeps = new Map(); return; }
      const end = a + lines[i].length;
      const b = orig.indexOf(lines[i + 1], end);
      if (b < 0) { origSeps = new Map(); return; }
      origSeps.set(`${lines[i]}\n${lines[i + 1]}`, orig.slice(end, b));
      pos = b;
    }
  }
  function titleAsOneLine() {
    const lines = titleEl.value.replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
    return lines.reduce((acc, l, i) => (i ? acc + (origSeps.has(`${lines[i - 1]}\n${l}`) ? origSeps.get(`${lines[i - 1]}\n${l}`) : ' ') + l : l), '');
  }
  // ===== 複製結束 =====

  // 標題框改了 → 小編文裡的【標題】那一行跟著改（改自 QPT 的 syncCopyTitle）。和 QPT 不同的地方：
  //   - 【…】那一行不一定在第一行（AI 產生的文字會放在最上面），所以整篇找：先找上次同步的那一行，找不到才找第一個【…】行；
  //   - 只換那一行，其他行（AI 文字、小編自己改的、圖說、hashtag）原樣不動；
  //   - 小編把【…】那一行整行刪掉就不再補回來；標題清空時留下「【】」，之後再打標題還能接上。
  // 回傳 { text, index }：index 是【…】那一行的行號，找不到是 -1（text 原樣）。
  const TITLE_ROW = /^【.*】$/;
  function replaceTitleLine(text, title, prevTitle) {
    const rows = String(text || '').split('\n');
    let index = prevTitle != null ? rows.indexOf(`【${prevTitle}】`) : -1;
    if (index < 0) index = rows.findIndex(r => TITLE_ROW.test(r));
    if (index < 0) return { text: String(text || ''), index };
    rows[index] = `【${title || ''}】`;
    return { text: rows.join('\n'), index };
  }

  // 圖文格式要用哪個圖說：主圖（og:image）自己的圖說，沒有才用整篇找到的 fallbackCaption（同 QPT 抓到第一張圖時的做法）
  function mainCaption(article) {
    const first = article && article.images && article.images[0];
    return (first && first.caption) || (article && article.fallbackCaption) || '';
  }

  return { parseArticle, pickTags, pickCaption, formatCopy, overrideOneLine, bindTitle, learnSeps, titleAsOneLine, replaceTitleLine, mainCaption };
});
