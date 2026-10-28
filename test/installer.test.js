const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const I = require('../web/installer.js');

// 用 python 的 zipfile 做一個和網頁同樣「不含最上層資料夾」的 ZIP
function zipOf(files) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snn-zip-')), 'x.zip');
  execFileSync('python3', ['-I', '-c', 'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor k,v in json.loads(sys.argv[2]).items(): z.writestr(k,v)\nz.close()', out, JSON.stringify(files)]);
  return new Uint8Array(fs.readFileSync(out));
}
const FILES = { 'manifest.json': `{"name": "${I.EXT_NAME}"}`, 'bridge.js': '// b', 'icons/icon16.png': 'png' };

test('base64 和 Node 的結果相同（含大於一個分段的長度）', () => {
  const bytes = new Uint8Array(70000).map((_, i) => (i * 7) & 255);
  assert.equal(I.base64(bytes), Buffer.from(bytes).toString('base64'));
});

test('Windows .cmd：CRLF、#PS-START 之後是 PowerShell，嵌入的 ZIP 原樣保留', () => {
  const zip = zipOf(FILES);
  const { name, text } = I.build('win', zip, '0.7.0');
  assert.equal(name, 'schedulenewnet-install.cmd');
  assert(!/[^\r]\n/.test(text), '每一行都是 CRLF');
  const ps = text.slice(text.lastIndexOf('#PS-START') + '#PS-START'.length);
  assert.match(ps, /^\r\n\$ErrorActionPreference = 'Stop'/, '.cmd 用 LastIndexOf 找到的是 PowerShell 開頭');
  assert.equal(ps.match(/FromBase64String\('([^']+)'\)/)[1], Buffer.from(zip).toString('base64'));
  assert.match(ps, /\$Docs = \[Environment\]::GetFolderPath\('MyDocuments'\)/, '放在「文件」（跟著 OneDrive 重新導向）');
  assert.match(ps, /\$Dir = Join-Path \$Docs 'schedulenewnet-ext'/);
  assert.match(ps, /\$OldDir = Join-Path \$env:USERPROFILE 'schedulenewnet-ext'/, '舊位置只用來提醒');
  assert(!/Remove-Item[^\r\n]*\$OldDir/.test(ps), '不刪舊位置');
  assert.match(ps, /Start-Process 'chrome\.exe' 'chrome:\/\/extensions'/);
  assert.match(text, /安裝程式 0\.7\.0/);
  assert(!/\/schedule|\/publish/.test(text), '安裝檔不碰後台');
});

test('Windows .cmd：安裝視窗（WinForms）＋開不起來時退回文字模式', () => {
  const text = I.windows('QUJD', '0.8.1');
  const cmd = text.slice(0, text.lastIndexOf('#PS-START'));
  const ps = text.slice(text.lastIndexOf('#PS-START'));
  assert.match(cmd, /powershell -NoProfile -STA /, 'WinForms 要 STA');
  assert.match(cmd, /\r\nif errorlevel 1 pause\r\nexit \/b\r\n$/, '只有文字模式（結束碼 1）才停下來');
  assert.match(ps, /Add-Type -AssemblyName System\.Windows\.Forms, System\.Drawing/);
  for (const t of ['開始安裝', '檔案已經放好了！', '打開「開發人員模式」', '按「載入未封裝項目」', '再複製一次路徑', '重新打開 Chrome 擴充功能頁', '沒辦法安裝', '複製錯誤訊息', '重試', '你的電腦還有一份舊位置的插件']) assert(ps.includes(t), t);
  assert.match(ps, /\} catch \{\r\n    Run-Text\r\n\}/, '視窗做不出來改用文字模式');
  assert.match(ps, /function Run-Text \{[\s\S]*安裝檔完成！[\s\S]*exit 1\r\n\}/);
  assert.match(ps, /exit 0\r\n$/);
  assert(!/\$\{|`|__(ZIP|NAME|VERSION|FOLDER)__/.test(ps), '佔位字都換掉、沒有 JS 樣板殘留');
  // 去掉字串和註解後括號要成對（本機沒有 PowerShell 可以實際跑，先擋最常見的打錯）
  const stack = []; let q = null;
  for (let i = 0; i < ps.length; i++) {
    const c = ps[i];
    if (q) { if (c === q) { if (ps[i + 1] === q) i++; else q = null; } continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '#') { while (i < ps.length && ps[i] !== '\n') i++; }
    else if ('([{'.includes(c)) stack.push(c);
    else if (')]}'.includes(c)) assert.equal(stack.pop(), { ')': '(', ']': '[', '}': '{' }[c]);
  }
  assert.equal(q, null); assert.deepEqual(stack, []);
});

test('嵌入內容與版本號格式不對就不產生', () => {
  assert.throws(() => I.windows("AAA'; rm", '1.0.0'), /格式不對/);
  assert.throws(() => I.mac('QQ==', '1.0'), /版本號/);
});

test('Mac .sh：bash 執行後放到 ~/Documents/schedulenewnet-ext；只覆蓋自己的資料夾', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snn-home-'));
  const script = path.join(home, I.FILES.mac);
  const { name, text } = I.build('mac', zipOf(FILES), '0.7.0');
  assert.equal(name, 'schedulenewnet-install-mac.sh');
  assert.equal(I.macCommand, 'bash ~/Downloads/schedulenewnet-install-mac.sh');
  fs.writeFileSync(script, text);
  // 沒有 pbcopy／open（Linux）也要完成，只是提示自己複製、自己開
  const env = { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' };
  const run = () => spawnSync('bash', [script], { env, encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = path.join(home, 'Documents', 'schedulenewnet-ext');
  assert(!/提醒：舊位置/.test(r.stdout), '沒有舊位置就不提醒');
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.js'), 'utf8'), '// b');
  assert(fs.existsSync(path.join(dir, 'icons/icon16.png')));
  assert.match(r.stdout, /安裝檔完成/);

  // 再跑一次：自己的資料夾整批換新（舊檔案不留）
  fs.writeFileSync(path.join(dir, 'old.js'), 'x');
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert(!fs.existsSync(path.join(dir, 'old.js')));

  // 同名資料夾裝的是別的東西：停下，不動任何檔案
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep');
  r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /裡面不是這個插件/);
  assert.deepEqual(fs.readdirSync(dir), ['mine.txt']);
});

test('Mac .sh：舊位置（~/schedulenewnet-ext）還有插件就提醒移除，但不刪', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snn-home-'));
  const old = path.join(home, 'schedulenewnet-ext');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'manifest.json'), `{"name": "${I.EXT_NAME}"}`);
  const script = path.join(home, I.FILES.mac);
  fs.writeFileSync(script, I.build('mac', zipOf(FILES), '0.7.0').text);
  const r = spawnSync('bash', [script], { env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert(fs.existsSync(path.join(home, 'Documents', 'schedulenewnet-ext', 'bridge.js')));
  assert.match(r.stdout, /提醒：舊位置還有一份插件/);
  assert(fs.existsSync(path.join(old, 'manifest.json')), '舊位置不刪');
});

// 假的 osascript：照順序回答按鈕，並記下每個對話框的圖示、訊息和按鈕
function fakeDialogs(home, answers) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, 'answers'), answers.join('\n') + '\n');
  fs.writeFileSync(path.join(bin, 'osascript'), [
    '#!/bin/bash',
    'cat >/dev/null',
    'shift',
    'printf \'%s\\n\' "$*" | tr \'\\n\' \'|\' >> "$HOME/dialogs"; echo >> "$HOME/dialogs"',
    'head -n1 "$HOME/answers"; sed -i 1d "$HOME/answers"',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LANG: 'C.UTF-8' };
}

test('Mac .sh：有 osascript 就跳系統對話框：開始 → 完成頁可再複製／重開，最後按完成', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snn-home-'));
  const script = path.join(home, I.FILES.mac);
  fs.writeFileSync(script, I.build('mac', zipOf(FILES), '0.7.0').text);
  const env = fakeDialogs(home, ['開始安裝', '再複製一次路徑', '重新打開擴充功能頁', '完成']);
  const r = spawnSync('bash', [script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert(fs.existsSync(path.join(home, 'Documents', 'schedulenewnet-ext', 'bridge.js')));
  const d = fs.readFileSync(path.join(home, 'dialogs'), 'utf8').trim().split('\n');
  assert.equal(d.length, 4);
  assert.match(d[0], /^note 這個安裝程式會幫你把.*Documents\/schedulenewnet-ext.* 取消 開始安裝\|$/);
  assert.match(d[1], /檔案已經放好了！.*開發人員模式.*載入未封裝項目.*再複製一次路徑 重新打開擴充功能頁 完成/);
  assert.match(d[1], /請在 Chrome 網址列輸入 chrome:\/\/extensions/, '沒有 open（Linux）就提示自己打開');
  assert.match(d[2], /路徑沒有複製成功/, '沒有 pbcopy 複製不了就照實說');
});

test('Mac .sh：開始時按取消就什麼都不裝', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snn-home-'));
  const script = path.join(home, I.FILES.mac);
  fs.writeFileSync(script, I.build('mac', zipOf(FILES), '0.7.0').text);
  const r = spawnSync('bash', [script], { env: fakeDialogs(home, ['取消']), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /已取消/);
  assert(!fs.existsSync(path.join(home, 'Documents', 'schedulenewnet-ext')));
});

test('Mac .sh：失敗跳錯誤對話框，重試會重跑一次，關閉就結束；舊位置先跳提醒', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snn-home-'));
  const script = path.join(home, I.FILES.mac);
  fs.writeFileSync(script, I.build('mac', zipOf(FILES), '0.7.0').text);
  const dir = path.join(home, 'Documents', 'schedulenewnet-ext');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep');
  let r = spawnSync('bash', [script], { env: fakeDialogs(home, ['開始安裝', '重試', '開始安裝', '關閉']), encoding: 'utf8' });
  assert.equal(r.status, 1);
  let d = fs.readFileSync(path.join(home, 'dialogs'), 'utf8').trim().split('\n');
  assert.equal(d.length, 4, '開始 → 錯誤（重試）→ 開始 → 錯誤（關閉）');
  assert.match(d[1], /^stop 沒辦法安裝.*裡面不是這個插件.* 複製錯誤訊息 關閉 重試\|$/);
  assert.deepEqual(fs.readdirSync(dir), ['mine.txt']);

  // 舊位置還有一份：先跳提醒再到完成頁
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(path.join(home, 'dialogs'));
  fs.mkdirSync(path.join(home, 'schedulenewnet-ext'));
  fs.writeFileSync(path.join(home, 'schedulenewnet-ext', 'manifest.json'), `{"name": "${I.EXT_NAME}"}`);
  r = spawnSync('bash', [script], { env: fakeDialogs(home, ['開始安裝', '下一步', '完成']), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  d = fs.readFileSync(path.join(home, 'dialogs'), 'utf8').trim().split('\n');
  assert.match(d[1], /^caution .*你的電腦還有一份舊位置的插件.* 下一步\|$/);
  assert.match(d[2], /^note .*檔案已經放好了！/);
});
