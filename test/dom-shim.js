// 測試用的極簡 DOMParser（Node 沒有 DOM，也不裝 jsdom）：只做 web/article.js 的 parseArticle 會用到的部分。
// 支援：標籤／屬性／註解／<script>、<style> 原文、自閉合標籤、常見實體；
// 選擇器：標籤、[attr]、[attr="v"]、[attr*="v" i]、tag[attr…]、後代（空格）、逗號群組。
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENT[e.toLowerCase()] ?? m));

class Node {
  constructor(tag, attrs) { this.tag = tag; this.attrs = attrs || {}; this.kids = []; this.parent = null; }
  get tagName() { return this.tag.toUpperCase(); }
  get parentElement() { return this.parent && this.parent.tag !== '#document' ? this.parent : null; }
  get children() { return this.kids.filter(k => typeof k !== 'string'); }
  get nextElementSibling() {
    if (!this.parent) return null;
    const sibs = this.parent.children;
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  get textContent() { return this.kids.map(k => (typeof k === 'string' ? k : k.textContent)).join(''); }
  getAttribute(n) { n = n.toLowerCase(); return n in this.attrs ? this.attrs[n] : null; }
  contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; }
  all() { const out = []; const walk = n => n.children.forEach(c => { out.push(c); walk(c); }); walk(this); return out; }
  querySelectorAll(sel) {
    const groups = sel.split(',').map(chainOf);
    return this.all().filter(el => groups.some(g => matchChain(el, g)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { for (let n = this; n && n.tag !== '#document'; n = n.parent) if (n.matches(sel)) return n; return null; }
  matches(sel) { return sel.split(',').some(g => matchChain(this, chainOf(g))); }
}

// 「[class*="tag" i] a」→ 兩段（方括號裡的空格不算分隔）
const chainOf = g => (g.trim().match(/(?:[^\s\[]|\[[^\]]*\])+/g) || []).map(parseCompound);
function parseCompound(s) {
  const tag = (/^[a-z][\w-]*/i.exec(s) || [''])[0].toLowerCase();
  const attrs = [];
  const re = /\[([\w-]+)(?:([*^$]?=)"([^"]*)"(\s+i)?)?\]/g;
  let m;
  while ((m = re.exec(s))) attrs.push({ name: m[1].toLowerCase(), op: m[2], val: m[3], ci: !!m[4] });
  return { tag, attrs };
}
function matchOne(el, c) {
  if (c.tag && el.tag !== c.tag) return false;
  return c.attrs.every(a => {
    let v = el.getAttribute(a.name);
    if (v == null) return false;
    if (!a.op) return true;
    let want = a.val;
    if (a.ci) { v = v.toLowerCase(); want = want.toLowerCase(); }
    return a.op === '=' ? v === want : a.op === '*=' ? v.includes(want) : a.op === '^=' ? v.startsWith(want) : v.endsWith(want);
  });
}
// 後代選擇器：最後一段要是自己，前面每段依序是祖先
function matchChain(el, chain) {
  if (!matchOne(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let n = el.parent; n && i >= 0; n = n.parent) if (n.tag !== '#document' && matchOne(n, chain[i])) i--;
  return i < 0;
}

function parse(html) {
  const doc = new Node('#document');
  let cur = doc, i = 0;
  const text = t => { if (t) cur.kids.push(decode(t)); };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(html.slice(i)); break; }
    text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt); i = e < 0 ? html.length : e + 3; continue; }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') { i = html.indexOf('>', lt) + 1 || html.length; continue; }
    const close = /^<\/([a-z][\w-]*)\s*>/i.exec(html.slice(lt));
    if (close) {
      const name = close[1].toLowerCase();
      for (let n = cur; n !== doc; n = n.parent) if (n.tag === name) { cur = n.parent; break; }
      i = lt + close[0].length; continue;
    }
    const open = /^<([a-z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/i.exec(html.slice(lt));
    if (!open) { text('<'); i = lt + 1; continue; }
    const name = open[1].toLowerCase(), attrs = {};
    open[2].replace(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, (m, k, a, b, c) => { attrs[k.toLowerCase()] = decode(a ?? b ?? c ?? ''); });
    const el = new Node(name, attrs);
    el.parent = cur; cur.kids.push(el);
    i = lt + open[0].length;
    if (RAW.has(name)) {
      const end = html.toLowerCase().indexOf('</' + name, i);
      const body = html.slice(i, end < 0 ? html.length : end);
      el.kids.push(name === 'script' || name === 'style' ? body : decode(body));
      i = end < 0 ? html.length : html.indexOf('>', end) + 1;
    } else if (!VOID.has(name) && !open[3]) cur = el;
  }
  doc.body = doc.querySelector('body') || doc;
  return doc;
}

class DOMParser { parseFromString(html) { return parse(String(html)); } }
module.exports = { DOMParser };
