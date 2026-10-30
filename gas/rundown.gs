// FB RUNDOWN 自動排入（Google Apps Script 網頁應用程式）
// 網站送出／排程成功後經圖床 Worker /rundown 轉送 POST { token, action:'add', entries:[{ page, date:'YYYY-MM-DD', time:'HH:mm', text:'4041548/圖文/颱風假' }] }
// 安裝步驟見 README「Rundown 自動排入」。指令碼屬性：TOKEN（必填，與 Worker 的 RUNDOWN_TOKEN 相同）、SHEET_ID（可省略，預設 FB RUNDOWN(2026)）
//
// 試算表版面（2026/10 分頁實測）：
// - 一個月一個分頁（名稱如 2026/10）；第 1～5 列之內有日期列，每個日期一欄，格子顯示 MMDD（1027）
// - A 欄：粉專區段標題（主粉、娛樂粉、少康粉、國際＋粉、新聞脆）與時段（0800、0830…，4 碼）
// - 時段區塊＝某個時段列往下到下一個區塊開頭；緊接在區塊開頭下面的時段列（0810、0820…）算同一區塊
// - 分鐘碼寫在「右邊一欄」（也就是隔天那欄）：0＝:00、-5＝:05、1＝:10、15＝:15 … 5＝:50、55＝:55（個位數×10，兩位數照寫）
//   不在 5 分格上的時間：-3＝:03、13＝:13（負號＝0X 分，兩位數照寫）
// - 隔天那欄已經填了內容（分鐘碼被蓋掉）時，改用同區塊其他還留著分鐘碼的欄位；都沒有就只看 A 欄時段
// - 插入時，隔天那欄的分鐘碼跟著稿子一起往下移（稿子的時間不變），新的那格補上目標時間的分鐘碼（15:13 → 13）
// - 稿子只落在分鐘碼相符的格子：15:55 遇到 5（:50）或沒寫分鐘碼的格子就往下一格，必要時把底下的稿子往下推，並在右邊補上 55
//   （避免預排 :55 的稿子落在 5 那格被看成 15:50）；分鐘碼在別欄或整個區塊都沒有分鐘碼時照舊，不寫分鐘碼
// - 區塊底下沒空格（再推就會碰到下一個時段或粉專）時，在區塊最後一列下面插入一整列再填（AE255 滿了 → 多一列，AE256 可填）

// 填入的稿子一律用和現有「/圖文/」相同的樣式：字級 12、粗體、紫色
var RD_STYLE = { size: 12, bold: true, color: '#9900ff' };
var RD_SECTIONS = { news: ['主粉'], ent: ['娛樂粉'], shaokang: ['少康粉'], intl: ['國際＋粉', '國際+粉'] };
var RD_DEFAULT_SHEET = '1OZOcobchhiFU6rf9jTJW00YNSHQXxNjurpudQdVl4Lo';

function rdStr(v) { return String(v == null ? '' : v).trim(); }
function rdIsLabel(v) { return /^\d{4}$/.test(rdStr(v)); }
function rdLabelMin(v) { var s = rdStr(v); return +s.slice(0, 2) * 60 + +s.slice(2); }
// 分鐘碼 → 分鐘；不是分鐘碼回 -1
function rdCodeMin(v) {
  var s = rdStr(v);
  if (/^[0-5]$/.test(s)) return +s * 10;
  if (/^-[1-9]$/.test(s)) return -s;
  if (/^[1-5]\d$/.test(s)) return +s;
  return -1;
}
function rdIsCode(v) { return rdCodeMin(v) >= 0; }
// 分鐘 → 分鐘碼（0→0、5→-5、10→1、13→13）
function rdMinCode(min) { return min % 10 === 0 ? String(min / 10) : min < 10 ? '-' + min : String(min); }
// 可以填的格子：空白、前一天留下的分鐘碼、沒有 ID 與 SLUG 的「/文字/」「/圖文/」預留格
function rdIsFree(v) { var s = rdStr(v).replace(/\s+/g, ''); return s === '' || rdIsCode(s) || s === '/文字/' || s === '/圖文/'; }
function rdA1(row, col) {   // 0 起算 → A1
  var s = '', n = col + 1;
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s + (row + 1);
}
function rdPad(n) { return (n < 10 ? '0' : '') + n; }
function rdFmt(min) { return rdPad(Math.floor(min / 60)) + ':' + rdPad(min % 60); }

// 分頁：優先完全符合 2026/10、2026/1，再找名稱裡同時有年與月的
function rdFindSheetName(names, y, m) {
  var exact = [y + '/' + rdPad(m), y + '/' + m, y + '-' + rdPad(m), y + '.' + rdPad(m), String(y) + rdPad(m)];
  for (var i = 0; i < exact.length; i++) if (names.indexOf(exact[i]) >= 0) return exact[i];
  for (var j = 0; j < names.length; j++) {
    var nums = (names[j].match(/\d+/g) || []).map(Number);
    if (nums.indexOf(y) >= 0 && nums.indexOf(m) >= 0) return names[j];
  }
  return null;
}

// 日期欄：前 5 列裡顯示為 MMDD（或 M/D）的格子；回傳 0 起算欄號
function rdFindDateCol(V, m, d) {
  var keys = [rdPad(m) + rdPad(d), m + '/' + d, rdPad(m) + '/' + rdPad(d)];
  for (var r = 0; r < Math.min(5, V.length); r++)
    for (var c = 1; c < V[r].length; c++) if (keys.indexOf(rdStr(V[r][c])) >= 0) return c;
  return -1;
}

// 區段：標題列下一列起，到下一個「A 欄有字但不是時段」的列為止（不含）
function rdFindSection(V, page) {
  var names = RD_SECTIONS[page];
  if (!names) return null;
  for (var r = 0; r < V.length; r++) {
    if (names.indexOf(rdStr(V[r][0])) < 0) continue;
    var end = r + 1;
    while (end < V.length && (rdStr(V[end][0]) === '' || rdIsLabel(V[end][0]))) end++;
    return { start: r + 1, end: end };
  }
  return null;
}

// 區段內的時段區塊：前一列不是時段的時段列才是區塊開頭
function rdBlocks(V, sec) {
  var starts = [];
  for (var r = sec.start; r < sec.end; r++) if (rdIsLabel(V[r][0]) && !(r > sec.start && rdIsLabel(V[r - 1][0]))) starts.push(r);
  return starts.map(function (s, i) { return { start: s, end: i + 1 < starts.length ? starts[i + 1] : sec.end, min: rdLabelMin(V[s][0]) }; });
}

function rdIsCodeCol(V, blk, c) {
  var n = 0;
  for (var r = blk.start; r < blk.end; r++) {
    var v = rdStr(V[r][c]);
    if (v === '') continue;
    if (!rdIsCode(v)) return false;
    n++;
  }
  return n >= 2;
}

// 分鐘碼欄：隔天那欄；被填掉就找最近、整個區塊只有分鐘碼的欄；沒有回 -1
function rdCodeCol(V, blk, x) {
  var width = V[blk.start].length;
  if (x + 1 < width && rdIsCodeCol(V, blk, x + 1)) return x + 1;
  for (var dist = 1; dist < width; dist++) {
    if (x + 1 + dist < width && rdIsCodeCol(V, blk, x + 1 + dist)) return x + 1 + dist;
    if (x + 1 - dist >= 1 && rdIsCodeCol(V, blk, x + 1 - dist)) return x + 1 - dist;
  }
  return -1;
}

// 區塊內每一列的時間（分鐘）：分鐘碼 > A 欄時段 > 沿用上一列
function rdRowTimes(V, blk, x) {
  var codeCol = rdCodeCol(V, blk, x);
  var hour = Math.floor(blk.min / 60) * 60, t = blk.min, out = [];
  for (var r = blk.start; r < blk.end; r++) {
    if (codeCol >= 0 && rdIsCode(V[r][codeCol])) t = hour + rdCodeMin(V[r][codeCol]);
    else if (rdIsLabel(V[r][0])) t = rdLabelMin(V[r][0]);
    out.push(t);
  }
  return out;
}

// 決定要寫哪一格（照時間順序排進去）：
// 目標＝「時間 ≤ 目標時間」的最後一筆稿子的下一格，但不早於最接近目標的那個分鐘格（例：08:07 → :05 那格）
// 隔天那欄是分鐘碼時，目標格的分鐘碼必須等於目標時間的分鐘碼（15:55 → 55）：
//   分鐘碼比目標早（5＝:50）→ 往下一格；分鐘碼空白而且可填 → 填這格並在隔天欄補上分鐘碼；
//   分鐘碼比目標晚、或格子有稿 → 插在這格（空的 :20 格也一起往下推，不蓋掉）
// 區塊裡沒有可填的格子了：addRow＝在區塊結尾（下一個時段／粉專開頭）前插入一整列，那列當作空格使用
// 目標格可填（空白／預留格）就直接填；已有稿子就插在這格，這個日期欄往下推到第一個可填的格子為止
// 插入時隔天那欄若是分鐘碼，同一段分鐘碼也往下推一格（被推的稿子時間不變），新的那格寫 code（目標時間的分鐘碼，15:13 → 13）
// 分鐘碼在別欄（隔天欄已填內容）或整個區塊沒有分鐘碼時照舊只看時間順序，不寫分鐘碼（別天的欄不能動）
// 回傳 { status:'exists'|'write'|'insert', row, shiftTo?, codeCol?, code?, addRow?, time } 或 { error }
function rdPlan(V, x, page, hhmm, text) {
  var sec = rdFindSection(V, page);
  if (!sec) return { error: '找不到「' + (RD_SECTIONS[page] || [page])[0] + '」區段' };
  var key = text.split('/').slice(0, 2).join('/') + '/';
  if (/^\d{6,8}\/[^/]+\/$/.test(key))
    for (var r0 = sec.start; r0 < sec.end; r0++) if (rdStr(V[r0][x]).indexOf(key) === 0) return { status: 'exists', row: r0 };
  var blocks = rdBlocks(V, sec);
  if (!blocks.length) return { error: '區段裡沒有時段' };
  var want = +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5), blk = blocks[0];
  blocks.forEach(function (b) { if (b.min <= want && (blk.min > want || b.min > blk.min)) blk = b; });   // 開始時間 ≤ 目標的區塊裡最晚的（區段尾端可能有 0000）
  var times = rdRowTimes(V, blk, x), best = -1, lastBusy = -1;
  times.forEach(function (t, i) {
    if (t > want) return;
    if (t > best) best = t;
    if (!rdIsFree(V[blk.start + i][x])) lastBusy = blk.start + i;
  });
  var target = Math.max(blk.start + Math.max(0, times.indexOf(best)), lastBusy + 1);
  var hour = Math.floor(blk.min / 60) * 60, cc = rdCodeCol(V, blk, x) === x + 1 ? x + 1 : -1;
  var code = cc >= 0 && want >= hour && want < hour + 60 ? rdMinCode(want - hour) : null;
  // 分鐘碼要和目標時間一致（15:55 不能落在 5＝:50 或沒碼的格子，會被看成 15:50）：
  // 比目標早的分鐘碼格往下跳過；沒碼的空格就地補碼；比目標晚的碼或有稿 → 插在這格並補碼
  var mismatch = false;
  if (code != null) {
    while (target < blk.end && rdIsCode(V[target][cc]) && rdCodeMin(V[target][cc]) < want - hour) target++;
    if (target >= blk.end) return { status: 'write', row: blk.end, addRow: blk.end, codeCol: cc, code: code, time: hhmm };
    var tc = rdStr(V[target][cc]);
    if (tc === '' && rdIsFree(V[target][x])) return { status: 'write', row: target, codeCol: cc, code: code, time: hhmm };
    mismatch = tc !== code;
  }
  var free = -1;
  for (var r = mismatch ? target + 1 : target; r < blk.end; r++) if (rdIsFree(V[r][x])) { free = r; break; }
  var addRow = free < 0 ? blk.end : null;
  if (free < 0) free = blk.end;   // 插入的新列
  if (free > target) {
    var plan = { status: 'insert', row: target, shiftTo: free, time: hhmm };
    if (cc >= 0) { plan.codeCol = cc; if (code != null) plan.code = code; }
    if (addRow != null) plan.addRow = addRow;
    return plan;
  }
  var w = { status: 'write', row: free, time: hhmm };
  if (addRow != null) { w.addRow = addRow; if (code != null) { w.codeCol = cc; w.code = code; } }
  return w;
}

// ---- 以下只在 Apps Script 執行 ----
function rdJson(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet() { return rdJson({ ok: true, app: 'newsnet-rundown' }); }

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (x) { return rdJson({ ok: false, error: '格式錯誤' }); }
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  if (!token || token.length < 12) return rdJson({ ok: false, error: 'Apps Script 尚未設定 TOKEN（至少 12 字）' });
  if (body.token !== token) return rdJson({ ok: false, error: '金鑰不對' });
  var ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID') || RD_DEFAULT_SHEET);
  if (body.action === 'ping') return rdJson({ ok: true, title: ss.getName(), sheets: ss.getSheets().map(function (s) { return s.getName(); }).slice(0, 6) });
  if (body.action !== 'add' || !Array.isArray(body.entries)) return rdJson({ ok: false, error: '不支援的動作' });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return rdJson({ ok: false, error: 'Rundown 忙碌中，請稍後再試' });
  try {
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    var results = body.entries.map(function (en) {
      try { return rdAddOne(ss, names, en); } catch (x) { return { ok: false, page: en.page, error: String(x && x.message || x) }; }
    });
    SpreadsheetApp.flush();
    return rdJson({ ok: true, results: results });
  } finally { lock.releaseLock(); }
}

function rdAddOne(ss, names, en) {
  var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rdStr(en.date)), text = rdStr(en.text);
  if (!dm || !/^\d{2}:\d{2}$/.test(rdStr(en.time)) || !text) return { ok: false, page: en.page, error: '資料不完整' };
  var y = +dm[1], m = +dm[2], d = +dm[3];
  var name = rdFindSheetName(names, y, m);
  if (!name) return { ok: false, page: en.page, error: '找不到 ' + y + '/' + rdPad(m) + ' 分頁' };
  var sh = ss.getSheetByName(name), V = sh.getDataRange().getDisplayValues();
  var x = rdFindDateCol(V, m, d);
  if (x < 0) return { ok: false, page: en.page, error: name + ' 找不到 ' + rdPad(m) + rdPad(d) + ' 欄' };
  var p = rdPlan(V, x, en.page, en.time, text);
  if (p.error) return { ok: false, page: en.page, error: p.error };
  var cell = name + '!' + rdA1(p.row, x);
  if (p.status === 'exists') return { ok: true, page: en.page, status: 'exists', cell: cell };
  if (p.addRow != null) sh.insertRowAfter(p.addRow);   // 在區塊最後一列（1 起算＝p.addRow）下面插一整列，格式沿用上一列
  if (p.status === 'insert') {
    sh.getRange(p.row + 1, x + 1, p.shiftTo - p.row, 1).moveTo(sh.getRange(p.row + 2, x + 1));
    if (p.codeCol != null) {
      var cc = p.codeCol + 1;
      sh.getRange(p.row + 1, cc, p.shiftTo - p.row, 1).moveTo(sh.getRange(p.row + 2, cc));
      if (p.code != null) sh.getRange(p.row + 1, cc).setValue(p.code); else sh.getRange(p.row + 1, cc).clearContent();
    }
  } else if (p.codeCol != null && p.code != null) sh.getRange(p.row + 1, p.codeCol + 1).setValue(p.code);   // 沒碼的空格就地補分鐘碼（那格原本是空的）
  sh.getRange(p.row + 1, x + 1).setValue(text).setFontSize(RD_STYLE.size).setFontWeight(RD_STYLE.bold ? 'bold' : 'normal').setFontColor(RD_STYLE.color);
  return { ok: true, page: en.page, status: p.status, cell: cell, time: p.time, addedRow: p.addRow != null };
}

if (typeof module !== 'undefined') module.exports = { rdFindSheetName: rdFindSheetName, rdFindDateCol: rdFindDateCol, rdFindSection: rdFindSection, rdBlocks: rdBlocks, rdRowTimes: rdRowTimes, rdCodeCol: rdCodeCol, rdCodeMin: rdCodeMin, rdMinCode: rdMinCode, RD_STYLE: RD_STYLE, rdPlan: rdPlan, rdA1: rdA1 };
