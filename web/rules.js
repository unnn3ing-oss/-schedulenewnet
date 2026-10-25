// 純規則（不碰 DOM）：瀏覽器是 window.Rules，Node 用 require。規則來源：docs/newsnet_handoff.md
(function (root, factory) {
  const cfg = typeof module === 'object' && module.exports ? require('./config.js') : root.NEWSNET_CONFIG;
  const api = factory(cfg);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function (cfg) {
  // 全形（含中日韓標點）算 1，半形（ASCII、半形片假名）算 0.5
  function charWidth(str) {
    let w = 0;
    for (const ch of String(str == null ? '' : str)) w += /[\u0000-\u007f｡-ﾟ]/.test(ch) ? 0.5 : 1;
    return w;
  }

  function articleId(url) {
    const m = /(\d{6,8})(?:[/?#]|$)/.exec(String(url || ''));
    return m ? m[1] : '';
  }

  // 手動沒填時：標題第一行去空白後前 5 字
  function shortTitle(lines) {
    const first = (Array.isArray(lines) ? lines : [lines])[0] || '';
    return Array.from(String(first).replace(/\s+/g, '')).slice(0, 5).join('');
  }

  // 文章網址 + 粉專 utm。已含同樣的參數（大小寫要相同）就不重複附加；氣象的大寫 Facebook 原樣帶出。
  function buildLink(url, utm) {
    url = String(url || '').trim();
    if (!url) return '';
    utm = String(utm || '');
    if (!utm) return url;
    const hashAt = url.indexOf('#');
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const hash = hashAt >= 0 ? url.slice(hashAt) : '';
    const q = base.indexOf('?');
    const have = new Set(q >= 0 ? base.slice(q + 1).split('&') : []);
    if (utm.split('&').every(p => have.has(p))) return url;
    return base + (q >= 0 ? (/[?&]$/.test(base) ? '' : '&') : '?') + utm + hash;
  }

  // 版型只有兩種（同 QPT 的新聞藍框／娛樂粉框）：所有勾選的粉專都送同一個 template
  const frameTemplate = frame => (frame === 'ent' ? 'newsnet_ent' : 'newsnet_news');
  const layoutOf = template => cfg.layouts[template] || cfg.layouts.newsnet_news;
  const limitsFor = template => layoutOf(template).limits.slice();
  const pageByCode = code => cfg.pages.find(p => p.code === code) || null;

  // ===== 以下 標題換行 整段複製自 quickpatterntool/quickfill.js（逐字，不要改；QPT 改了就同步）=====
  // ---- 標題換行 ----------------------------------------------------------------
  // 強斷點：每個空格（半形／全形）換一行（空格本身丟掉）；「！」「？」之後也換行（標點留在上一行），
  //        連續的標點和緊接著的右引號／右括號留在同一行。標題裡有幾個強斷點就一定會分成幾段。
  // 弱斷點：全形「：」。標題通常 2～3 段，所以：
  //   1) 強斷點切出來不到 3 段時，用「：」補斷，補到 3 段為止；
  //   2) 已經有 3 段以上時，「：」不拆（例：「蔡英文現身！12萬洋流挺沈伯洋　賴清德：對手認知作戰已開始」維持 3 段）；
  //   3) 但如果某一行字數太多（放不下一行、會被縮小字級），才在那行的「：」多拆一段，變 4 段。
  // 一行放得下多少：畫布標題區寬 960px ÷ 字級 67px ≈ 14.3 個全形字，所以超過 14 個全形字算太長。
  // 只認全形「：」，半形「:」常出現在時間（12:30）或網址裡，不拆。
  const STRONG_BREAK = /[！？!?]/;
  const CLOSERS = /[」』）)”’》】〕]/;
  const TARGET_LINES = 3;
  const LINE_CAPACITY = 14;   // 一行放得下的全形字數

  // 估算一行的寬度（以全形字為 1）：全形 1、英數約 0.55、其他半形符號約 0.35
  function lineWidth(text) {
    let w = 0;
    for (const ch of text) {
      if (ch.charCodeAt(0) > 0x7f) w += 1;
      else w += /[A-Za-z0-9]/.test(ch) ? 0.55 : 0.35;
    }
    return w;
  }

  function splitStrong(s) {
    const lines = [];
    let cur = '';
    const push = () => { if (cur.trim()) lines.push(cur.trim()); cur = ''; };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (/[\s　]/.test(ch)) { push(); continue; }
      cur += ch;
      if (STRONG_BREAK.test(ch)) {
        while (i + 1 < s.length && (STRONG_BREAK.test(s[i + 1]) || CLOSERS.test(s[i + 1]))) cur += s[++i];
        push();
      }
    }
    push();
    return lines;
  }

  // 在一行裡找「：」的斷點（冒號後面還有字才算；緊接著的標點、右引號留在冒號那一行）
  function colonCuts(line) {
    const cuts = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '：') continue;
      let j = i;
      while (j + 1 < line.length && (line[j + 1] === '：' || STRONG_BREAK.test(line[j + 1]) || CLOSERS.test(line[j + 1]))) j++;
      if (j + 1 < line.length) cuts.push(j + 1);
      i = j;
    }
    return cuts;
  }

  // 太長的一行：在「：」拆成兩半（選讓較長那半最短的斷點），拆完還太長就再拆
  function splitIfTooLong(line) {
    if (lineWidth(line) <= LINE_CAPACITY) return [line];
    const cuts = colonCuts(line);
    if (!cuts.length) return [line];
    const cut = cuts.reduce((best, c) =>
      Math.max(lineWidth(line.slice(0, c)), lineWidth(line.slice(c))) < Math.max(lineWidth(line.slice(0, best)), lineWidth(line.slice(best))) ? c : best, cuts[0]);
    return [...splitIfTooLong(line.slice(0, cut)), ...splitIfTooLong(line.slice(cut))];
  }

  function breakTitle(title) {
    const s = String(title).replace(/\s*\n\s*/g, ' ').trim();
    let lines = splitStrong(s);

    // 1) 不到 3 段：用「：」補斷到 3 段
    let budget = TARGET_LINES - lines.length;
    if (budget > 0) {
      const topped = [];
      for (const line of lines) {
        let from = 0;
        for (const cut of colonCuts(line)) {
          if (budget <= 0) break;
          topped.push(line.slice(from, cut));
          from = cut;
          budget--;
        }
        topped.push(line.slice(from));
      }
      lines = topped;
    }

    // 2) 還有放不下一行的長句：才在「：」多拆一段（可能因此變成 4 段）
    return lines.flatMap(splitIfTooLong);
  }

  // 改標有換行 = 小編排好的分行，圖上照這個分；單行改標才交給 breakTitle
  function overrideLines(override) {
    if (/\n/.test(override)) return override.split('\n').map(l => l.trim()).filter(Boolean);
    return breakTitle(override);
  }
  // ===== 複製結束 =====

  return { charWidth, articleId, shortTitle, buildLink, frameTemplate, limitsFor, pageByCode, lineWidth, breakTitle, overrideLines, config: cfg };
});
