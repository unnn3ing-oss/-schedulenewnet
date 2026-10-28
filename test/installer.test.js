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
