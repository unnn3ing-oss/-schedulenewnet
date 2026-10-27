// 一鍵安裝檔（仿 videodownload 的 install-windows.cmd / install-mac.sh）：
// 網頁先從 GitHub 抓好、驗證過的插件檔案打包成 ZIP，再把 ZIP 以 base64 嵌進安裝檔，所以安裝檔執行時不用再連網。
// 安裝檔只做三件事：把插件放到固定資料夾（家目錄下的 schedulenewnet-ext）、把資料夾路徑複製到剪貼簿、打開 chrome://extensions。
// 「開發人員模式」和「載入未封裝項目」Chrome 不允許程式代按，仍要使用者自己點。
// 純函式，Node 可 require 測試；瀏覽器掛在 window.Installer。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Installer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const EXT_NAME = '網新快速排程 連線驗證';   // extension/manifest.json 的 name：資料夾裡是這個插件才會覆蓋
  const FOLDER = 'schedulenewnet-ext';
  const FILES = { win: 'schedulenewnet-install.cmd', mac: 'schedulenewnet-install-mac.sh' };
  const MARK = '#PS-START';

  // 嵌進安裝檔的字串不能打斷引號或指令：base64 只會有 A–Z a–z 0–9 + / =，版本只允許 x.y.z
  function check(zipB64, version) {
    if (typeof zipB64 !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(zipB64)) throw new Error('安裝檔內容格式不對');
    if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error('版本號格式不對');
  }

  // Windows：.cmd 前半段叫 PowerShell 讀這個檔案自己、執行 #PS-START 之後的部分（和 videodownload 相同寫法）
  function windows(zipB64, version) {
    check(zipB64, version);
    const cmd = [
      '@echo off',
      'chcp 65001 >nul',
      `title ${EXT_NAME} 安裝程式`,
      `echo ${EXT_NAME} 安裝程式 ${version}`,
      'echo.',
      'set "SELF=%~f0"',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "$f = [IO.File]::ReadAllText($env:SELF, [Text.Encoding]::UTF8); $i = $f.LastIndexOf('${MARK}'); Invoke-Expression $f.Substring($i + ${MARK.length})"`,
      'echo.',
      'pause',
      'exit /b',
    ];
    const ps = [
      MARK,
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      `$Dir = Join-Path $env:USERPROFILE '${FOLDER}'`,
      `$Name = '${EXT_NAME}'`,
      "function Step($t) { Write-Host ''; Write-Host \"==> $t\" -ForegroundColor Cyan }",
      'try {',
      "    Step '檢查資料夾'",
      '    if (Test-Path $Dir) {',
      '        $ours = $false',
      "        $m = Join-Path $Dir 'manifest.json'",
      '        if (Test-Path $m) { try { $ours = ((Get-Content -Raw -Encoding UTF8 $m | ConvertFrom-Json).name -eq $Name) } catch { } }',
      '        $empty = -not (Get-ChildItem -Force $Dir | Select-Object -First 1)',
      '        if (-not ($ours -or $empty)) { throw "「$Dir」已經存在，但裡面不是這個插件。請把它改名或移走，再執行一次安裝檔。" }',
      '        # 舊版的檔案整批換掉，免得留下新版已經刪掉的檔案',
      '        if ($ours) { Get-ChildItem -Force $Dir | Remove-Item -Recurse -Force }',
      '    }',
      "    Step '寫入插件檔案'",
      "    $zip = Join-Path $env:TEMP 'schedulenewnet-ext.zip'",
      `    [IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String('${zipB64}'))`,
      '    New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
      '    Expand-Archive -Force -Path $zip -DestinationPath $Dir',
      '    Remove-Item -Force $zip',
      '    Write-Host "    $Dir"',
      "    Step '複製資料夾路徑'",
      '    try { Set-Clipboard -Value $Dir; Write-Host \'    已複製，等一下在 Chrome 選資料夾時直接貼上\' } catch { Write-Host \'    無法複製，請自己記下上面的路徑\' }',
      "    Step '開啟 Chrome 擴充功能頁'",
      "    try { Start-Process 'chrome.exe' 'chrome://extensions' } catch { Write-Host '    打不開 Chrome，請自己在 Chrome 網址列輸入 chrome://extensions' }",
      "    Write-Host ''",
      "    Write-Host '安裝檔完成！接著回到 Chrome：' -ForegroundColor Green",
      "    Write-Host '  1. 打開擴充功能頁右上角的「開發人員模式」'",
      "    Write-Host '  2. 按左上角「載入未封裝項目」，在「資料夾」欄位按 Ctrl+V 貼上路徑，再按「選擇資料夾」'",
      "    Write-Host '  （已經載入過的話，不用重新載入，到擴充功能頁按插件上的重新整理圖示即可）'",
      '} catch {',
      "    Write-Host ''",
      '    Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red',
      "    Write-Host '請截圖這個視窗，並聯絡提供工具的同事。'",
      '}',
    ];
    return cmd.concat(ps).join('\r\n') + '\r\n';
  }

  // Mac：.sh 用「bash 檔案路徑」在終端機執行（不用改執行權限，也不會被 Gatekeeper 擋）
  function mac(zipB64, version) {
    check(zipB64, version);
    return [
      '#!/bin/bash',
      `# ${EXT_NAME} 安裝程式 ${version}`,
      'set -euo pipefail',
      '',
      `DIR="$HOME/${FOLDER}"`,
      `NAME='${EXT_NAME}'`,
      `PAYLOAD='${zipB64}'`,
      '',
      "fail() { printf '\\n安裝失敗：%s\\n請截圖這個視窗，並聯絡提供工具的同事。\\n' \"$1\"; exit 1; }",
      'trap \'fail "第 $LINENO 行執行失敗，原因請看上面的訊息"\' ERR',
      "step() { printf '\\n==> %s\\n' \"$1\"; }",
      '',
      "printf '%s 安裝程式 %s\\n' \"$NAME\" " + `'${version}'`,
      "step '檢查資料夾'",
      'if [ -e "$DIR" ]; then',
      '  [ -d "$DIR" ] || fail "「$DIR」已經存在，但不是資料夾。請把它改名或移走，再執行一次。"',
      '  if [ -f "$DIR/manifest.json" ] && grep -qF "\\"$NAME\\"" "$DIR/manifest.json"; then',
      '    # 舊版的檔案整批換掉，免得留下新版已經刪掉的檔案',
      '    find "$DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
      '  elif [ -n "$(ls -A "$DIR")" ]; then',
      '    fail "「$DIR」已經存在，但裡面不是這個插件。請把它改名或移走，再執行一次。"',
      '  fi',
      'fi',
      '',
      "step '寫入插件檔案'",
      'mkdir -p "$DIR"',
      'ZIP="$(mktemp -t schedulenewnet-ext.XXXXXX)"',
      '# macOS 12 以前的 base64 只認 -D，13 以後兩個都認',
      "if printf 'QQ==' | base64 -d >/dev/null 2>&1; then DEC=-d; else DEC=-D; fi",
      "printf '%s' \"$PAYLOAD\" | base64 \"$DEC\" > \"$ZIP\"",
      'if command -v ditto >/dev/null 2>&1; then ditto -x -k "$ZIP" "$DIR"; else unzip -q -o "$ZIP" -d "$DIR"; fi',
      'rm -f "$ZIP"',
      'echo "    $DIR"',
      '',
      "step '複製資料夾路徑'",
      "if command -v pbcopy >/dev/null 2>&1 && printf '%s' \"$DIR\" | pbcopy; then",
      "  echo '    已複製，等一下在 Chrome 選資料夾時按 ⌘⇧G 再貼上'",
      'else',
      "  echo '    無法複製，請自己記下上面的路徑'",
      'fi',
      '',
      "step '開啟 Chrome 擴充功能頁'",
      'if ! { command -v open >/dev/null 2>&1 && open -a "Google Chrome" "chrome://extensions" 2>/dev/null; }; then',
      "  echo '    打不開 Chrome，請自己在 Chrome 網址列輸入 chrome://extensions'",
      'fi',
      '',
      'trap - ERR',
      "printf '\\n安裝檔完成！接著回到 Chrome：\\n'",
      "echo '  1. 打開擴充功能頁右上角的「開發人員模式」'",
      "echo '  2. 按左上角「載入未封裝項目」，按 ⌘⇧G 貼上路徑後按 Enter，再按「選取」'",
      "echo '  （已經載入過的話，不用重新載入，到擴充功能頁按插件上的重新整理圖示即可）'",
      '',
    ].join('\n');
  }

  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'latin1').toString('base64');
  }

  // os：'win' | 'mac'；zipBytes：插件檔案（不含最上層資料夾）的 ZIP。回傳 { name, text, type }
  function build(os, zipBytes, version) {
    const b64 = base64(zipBytes);
    if (os === 'mac') return { name: FILES.mac, text: mac(b64, version), type: 'text/x-shellscript' };
    return { name: FILES.win, text: windows(b64, version), type: 'application/octet-stream' };
  }

  // 終端機要貼的指令：Chrome 預設下載到「下載項目」資料夾
  const macCommand = `bash ~/Downloads/${FILES.mac}`;

  return { EXT_NAME, FOLDER, FILES, windows, mac, build, base64, macCommand };
});
