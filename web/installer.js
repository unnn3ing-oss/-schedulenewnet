// 一鍵安裝檔（仿 videodownload 的 install-windows.cmd / install-mac.sh）：
// 網頁先從 GitHub 抓好、驗證過的插件檔案打包成 ZIP，再把 ZIP 以 base64 嵌進安裝檔，所以安裝檔執行時不用再連網。
// 安裝檔只做三件事：把插件放到固定資料夾（「文件」裡的 schedulenewnet-ext）、把資料夾路徑複製到剪貼簿、打開 chrome://extensions。
// 舊版安裝檔放在家目錄（%USERPROFILE%／~）；舊位置還有插件時只提醒改載入新位置，不刪（Chrome 可能正在用）。
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

  // Windows：.cmd 前半段叫 PowerShell 讀這個檔案自己、執行 #PS-START 之後的部分（和 videodownload 相同寫法）。
  // PowerShell 開一般的安裝視窗（WinForms：開始 → 進度 → 圖解兩步；失敗可重試）；
  // 視窗開不起來（公司鎖住 .NET 之類）就退回原本的文字輸出，結束碼 1 讓 .cmd 停在 pause 給人看。
  function windows(zipB64, version) {
    check(zipB64, version);
    const cmd = [
      '@echo off',
      'chcp 65001 >nul',
      `title ${EXT_NAME} 安裝程式`,
      `echo ${EXT_NAME} 安裝程式 ${version}`,
      'echo 正在開啟安裝視窗…',
      'set "SELF=%~f0"',
      `powershell -NoProfile -STA -ExecutionPolicy Bypass -Command "$f = [IO.File]::ReadAllText($env:SELF, [Text.Encoding]::UTF8); $i = $f.LastIndexOf('${MARK}'); Invoke-Expression $f.Substring($i + ${MARK.length})"`,
      'if errorlevel 1 pause',
      'exit /b',
    ];
    const ps = WIN_PS.split('__ZIP__').join(zipB64).split('__VERSION__').join(version)
      .split('__NAME__').join(EXT_NAME).split('__FOLDER__').join(FOLDER);
    return cmd.join('\r\n') + '\r\n' + MARK + '\r\n' + ps.replace(/\r?\n/g, '\r\n');
  }

  // PowerShell 本體。__ZIP__ 等佔位字在 windows() 換掉；這段不能出現 JS 的 ${ 和反引號
  const WIN_PS = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
# 「文件」資料夾：GetFolderPath 會跟著 OneDrive 等重新導向；拿不到才退回使用者資料夾
$Docs = [Environment]::GetFolderPath('MyDocuments')
if (-not $Docs) { $Docs = $env:USERPROFILE }
$Dir = Join-Path $Docs '__FOLDER__'
$OldDir = Join-Path $env:USERPROFILE '__FOLDER__'
$Name = '__NAME__'
$Version = '__VERSION__'
$ZipBytes = [Convert]::FromBase64String('__ZIP__')
$StepNames = @('檢查資料夾', '寫入插件檔案', '複製資料夾路徑', '開啟 Chrome 擴充功能頁')
$S = @{ n = 0; busy = $false; err = '' }
try { Add-Type -AssemblyName System.IO.Compression } catch {}

function IsOurs($d) { $m = Join-Path $d 'manifest.json'; if (-not (Test-Path $m)) { return $false }; try { return ((Get-Content -Raw -Encoding UTF8 $m | ConvertFrom-Json).name -eq $Name) } catch { return $false } }

function Open-Zip { New-Object IO.Compression.ZipArchive ((New-Object IO.MemoryStream (,$ZipBytes)), [IO.Compression.ZipArchiveMode]::Read) }

# 一個一個檔案解開，進度才算得出「12 / 20」；路徑跑出資料夾外的項目直接拒絕
function Extract-Zip($root, $report) {
    $base = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    $za = Open-Zip
    try {
        $files = @($za.Entries | Where-Object { $_.Name })
        $i = 0
        foreach ($e in $files) {
            $i++
            $dest = [IO.Path]::GetFullPath((Join-Path $root $e.FullName))
            if (-not $dest.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw "安裝檔內容有問題（$($e.FullName)），請重新下載安裝檔。" }
            New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
            $in = $e.Open(); $out = [IO.File]::Create($dest)
            try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
            & $report 2 "寫入插件檔案（$i / $($files.Count)）" (25 + [int](50 * $i / $files.Count))
        }
    } finally { $za.Dispose() }
}

# 文字模式和視窗共用；$report 收到（第幾步, 顯示文字, 百分比）
function Install-Ext($report) {
    & $report 1 '檢查資料夾' 5
    if (Test-Path $Dir) {
        $ours = IsOurs $Dir
        $empty = -not (Get-ChildItem -Force $Dir | Select-Object -First 1)
        if (-not ($ours -or $empty)) { throw "「$Dir」已經存在，但裡面不是這個插件。請把它改名或移走，再執行一次安裝檔。" }
        # 舊版的檔案整批換掉，免得留下新版已經刪掉的檔案
        if ($ours) { Get-ChildItem -Force $Dir | Remove-Item -Recurse -Force }
    }
    & $report 2 '寫入插件檔案' 25
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    Extract-Zip $Dir $report
    $hasOld = ($OldDir -ne $Dir) -and (Test-Path $OldDir) -and (IsOurs $OldDir)
    & $report 3 '複製資料夾路徑' 80
    $copied = $true
    try { Set-Clipboard -Value $Dir } catch { $copied = $false }
    & $report 4 '開啟 Chrome 擴充功能頁' 90
    $chrome = $true
    try { Start-Process 'chrome.exe' 'chrome://extensions' } catch { $chrome = $false }
    & $report 5 '' 100
    [pscustomobject]@{ Copied = $copied; Chrome = $chrome; HasOld = $hasOld }
}

# ---------- 文字模式（視窗開不起來時） ----------
function Run-Text {
    $rep = { param($n, $t, $p) if ($n -ne $S.n -and $n -le 4) { $S.n = $n; Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan } }
    try {
        $r = @(Install-Ext $rep)[-1]
        Write-Host "    $Dir"
        if (-not $r.Copied) { Write-Host '    無法複製路徑，請自己記下上面的路徑' }
        if (-not $r.Chrome) { Write-Host '    打不開 Chrome，請自己在 Chrome 網址列輸入 chrome://extensions' }
        Write-Host ''
        Write-Host '安裝檔完成！接著回到 Chrome：' -ForegroundColor Green
        Write-Host '  1. 打開擴充功能頁右上角的「開發人員模式」'
        Write-Host '  2. 按左上角「載入未封裝項目」，在「資料夾」欄位按 Ctrl+V 貼上路徑，再按「選擇資料夾」'
        Write-Host '  （已經載入過這個位置的話，不用重新載入，到擴充功能頁按插件上的重新整理圖示即可）'
        if ($r.HasOld) {
            Write-Host ''
            Write-Host '提醒：舊位置還有一份插件（以前的安裝檔放的）：' -ForegroundColor Yellow
            Write-Host "  $OldDir"
            Write-Host '  請在擴充功能頁先「移除」舊的那個，再照上面步驟載入新位置；確認新的能用後，舊資料夾可以刪掉。'
        }
    } catch {
        Write-Host ''
        Write-Host "安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
        Write-Host '請截圖這個視窗，並聯絡提供工具的同事。'
    }
    exit 1
}

# ---------- 安裝視窗 ----------
function C($h) { [Drawing.ColorTranslator]::FromHtml($h) }
function Pt($x, $y) { New-Object Drawing.Point ($x, $y) }
function Sz($w, $h) { New-Object Drawing.Size ($w, $h) }

function Box($parent, $x, $y, $w, $h, $bg) {
    $p = New-Object Windows.Forms.Panel
    $p.Location = Pt $x $y; $p.Size = Sz $w $h
    if ($bg) { $p.BackColor = C $bg }
    $parent.Controls.Add($p); $p
}

# 有邊框的區塊：外層當邊框色，內層退 1px
function Card($parent, $x, $y, $w, $h, $line, $bg) {
    $o = Box $parent $x $y $w $h $line
    Box $o 1 1 ($w - 2) ($h - 2) $bg
}

function Lbl($parent, $text, $x, $y, $w, $h, $font, $color) {
    $l = New-Object Windows.Forms.Label
    $l.Text = $text; $l.Location = Pt $x $y; $l.Size = Sz $w $h
    $l.BackColor = [Drawing.Color]::Transparent
    if ($font) { $l.Font = $font }
    if ($color) { $l.ForeColor = C $color }
    $parent.Controls.Add($l); $l
}

function Round-It($c) {
    $fix = { param($o) $g = New-Object Drawing.Drawing2D.GraphicsPath; $g.AddEllipse(0, 0, $o.Width, $o.Height); $o.Region = New-Object Drawing.Region ($g) }
    $c.Add_SizeChanged($fix); & $fix $c
}

function Btn($parent, $text, $w, $primary) {
    $b = New-Object Windows.Forms.Button
    $b.Text = $text; $b.Size = Sz $w 32; $b.Font = $FontUI
    $b.FlatStyle = 'Flat'; $b.Cursor = 'Hand'; $b.UseVisualStyleBackColor = $false
    if ($primary) {
        $b.BackColor = C '#004aad'; $b.ForeColor = [Drawing.Color]::White
        $b.FlatAppearance.BorderColor = C '#004aad'; $b.FlatAppearance.MouseOverBackColor = C '#003a88'
    } else {
        $b.BackColor = [Drawing.Color]::White; $b.ForeColor = C '#1b1f27'
        $b.FlatAppearance.BorderColor = C '#c9cfd8'; $b.FlatAppearance.MouseOverBackColor = C '#f1f4f9'
    }
    $parent.Controls.Add($b); $b
}

# 每頁的內容區 + 底部按鈕列（按鈕靠右）
function Page {
    $p = Box $Form 0 85 560 345 '#ffffff'
    $p.Visible = $false
    $f = Box $p 0 290 560 55 '#f7f8fa'
    Box $f 0 0 560 1 '#e3e7ee' | Out-Null
    $p.Tag = $f
    $Pages.Add($p) | Out-Null
    $p
}
function Foot($page, $buttons) {
    $x = 538
    for ($i = $buttons.Count - 1; $i -ge 0; $i--) {
        $b = $buttons[$i]; $x -= $b.Width
        $b.Location = Pt $x 12; $x -= 8
    }
}
function Show-Page($p) { foreach ($q in $Pages) { $q.Visible = ($q -eq $p) } }

function RoundRect($x, $y, $w, $h, $r) {
    $g = New-Object Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $g.AddArc($x, $y, $d, $d, 180, 90); $g.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $g.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $g.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $g.CloseFigure(); $g
}

# 圖解小截圖：用 GDI+ 畫兩倍大，PictureBox 縮放顯示
function New-Shot($kind) {
    $k = 2; $w = 228; $h = 100
    $bmp = New-Object Drawing.Bitmap ($w * $k), ($h * $k)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.ScaleTransform($k, $k)
    $g.Clear([Drawing.Color]::White)
    $px = [Drawing.GraphicsUnit]::Pixel
    $small = New-Object Drawing.Font ('Segoe UI', 10, $px)
    $txt = New-Object Drawing.Font ('Microsoft JhengHei UI', 11, $px)
    $g.FillRectangle((New-Object Drawing.SolidBrush (C '#f1f3f4')), 0, 0, $w, 20)
    $g.DrawLine((New-Object Drawing.Pen (C '#e3e3e3')), 0, 20, $w, 20)
    $g.DrawString('chrome://extensions', $small, (New-Object Drawing.SolidBrush (C '#555555')), 6, 4)
    $ring = New-Object Drawing.Pen ((C '#ff3b30'), 2.5)
    if ($kind -eq 'dev') {
        $label = '開發人員模式'
        $tw = $g.MeasureString($label, $txt).Width
        $sx = $w - 14 - 30
        $g.DrawString($label, $txt, (New-Object Drawing.SolidBrush (C '#333333')), ($sx - 6 - $tw), 34)
        $g.FillPath((New-Object Drawing.SolidBrush (C '#1a73e8')), (RoundRect $sx 35 30 16 8))
        $g.FillEllipse([Drawing.Brushes]::White, ($sx + 16), 37, 12, 12)
        $g.DrawPath($ring, (RoundRect ($sx - 12 - $tw) 28 ($tw + 50) 30 9))
    } else {
        $label = '載入未封裝項目'
        $tw = $g.MeasureString($label, $txt).Width
        $g.FillPath([Drawing.Brushes]::White, (RoundRect 12 32 ($tw + 16) 22 4))
        $g.DrawPath((New-Object Drawing.Pen (C '#c6c6c6')), (RoundRect 12 32 ($tw + 16) 22 4))
        $g.DrawString($label, $txt, (New-Object Drawing.SolidBrush (C '#1a73e8')), 20, 35)
        $g.DrawPath($ring, (RoundRect 6 26 ($tw + 28) 34 9))
    }
    $g.DrawRectangle((New-Object Drawing.Pen (C '#d6dbe3')), 0, 0, $w - 1, $h - 1)
    $g.Dispose(); $bmp
}

function Logo-Image {
    try {
        $za = Open-Zip
        try {
            $e = $za.GetEntry('icons/icon128.png')
            $ms = New-Object IO.MemoryStream
            $st = $e.Open(); $st.CopyTo($ms); $st.Dispose()
            [Drawing.Image]::FromStream($ms)
        } finally { $za.Dispose() }
    } catch { $null }
}

function Start-Install {
    $S.busy = $true
    for ($i = 0; $i -lt 4; $i++) { $Names[$i].Text = $StepNames[$i] }
    & $GuiReport 0 '' 0
    Show-Page $PgProg
    try {
        $r = @(Install-Ext $GuiReport)[-1]
        if ($r.Chrome) { $DoneLead.Text = 'Chrome 的擴充功能頁已經幫你打開，照下面兩步完成：' }
        else { $DoneLead.Text = '請在 Chrome 網址列輸入 chrome://extensions，再照下面兩步：' }
        if ($r.Copied) { $DoneTip.Text = '路徑已經複製好了；不小心蓋掉的話按「再複製一次路徑」。' }
        else { $DoneTip.Text = '路徑沒有複製成功，請按「再複製一次路徑」。' }
        if ($r.HasOld) { Show-Page $PgOld } else { Show-Page $PgDone }
        # Chrome 開起來會蓋在上面：等一下把安裝視窗叫回前面，圖解才看得到
        if ($r.Chrome) { $Timer.Start() }
    } catch {
        $S.err = $_.Exception.Message
        $ErrMsg.Text = $S.err
        Show-Page $PgErr
    } finally { $S.busy = $false }
}

function Copy-Text($t) { try { [Windows.Forms.Clipboard]::SetText($t) } catch { try { Set-Clipboard -Value $t } catch {} } }

try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $Native = $false
    try {
        Add-Type -Namespace SnnInst -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
        $Native = $true
        [SnnInst.Native]::SetProcessDPIAware() | Out-Null
    } catch {}
    [Windows.Forms.Application]::EnableVisualStyles()

    $FontUI = New-Object Drawing.Font ('Microsoft JhengHei UI', 9.75)
    $FontBody = New-Object Drawing.Font ('Microsoft JhengHei UI', 10.5)
    $FontBodyB = New-Object Drawing.Font ('Microsoft JhengHei UI', 10.5, [Drawing.FontStyle]::Bold)
    $FontTitle = New-Object Drawing.Font ('Microsoft JhengHei UI', 12, [Drawing.FontStyle]::Bold)
    $FontSmall = New-Object Drawing.Font ('Microsoft JhengHei UI', 9)
    $FontMono = New-Object Drawing.Font ('Consolas', 9.5)
    $FontDot = New-Object Drawing.Font ('Segoe UI Symbol', 11)

    $Form = New-Object Windows.Forms.Form
    $Form.AutoScaleDimensions = New-Object Drawing.SizeF (96, 96)
    $Form.AutoScaleMode = 'Dpi'
    $Form.Text = '網新快速排程 安裝程式'
    $Form.ClientSize = Sz 560 430
    $Form.FormBorderStyle = 'FixedDialog'; $Form.MaximizeBox = $false
    $Form.StartPosition = 'CenterScreen'; $Form.BackColor = [Drawing.Color]::White
    $Form.Font = $FontUI
    $Pages = New-Object Collections.ArrayList

    # 標頭：插件圖示 + 名稱 + 版本
    $logo = Logo-Image
    if ($logo) {
        $pic = New-Object Windows.Forms.PictureBox
        $pic.Location = Pt 22 18; $pic.Size = Sz 48 48; $pic.SizeMode = 'Zoom'; $pic.Image = $logo
        $Form.Controls.Add($pic)
        try { $Form.Icon = [Drawing.Icon]::FromHandle(([Drawing.Bitmap]$logo).GetHicon()) } catch {}
    } else {
        $l = Lbl $Form '網' 22 18 48 48 $FontTitle
        $l.BackColor = C '#004aad'; $l.ForeColor = [Drawing.Color]::White; $l.TextAlign = 'MiddleCenter'
    }
    Lbl $Form '網新快速排程 插件' 84 20 440 24 $FontTitle '#1b1f27' | Out-Null
    Lbl $Form "版本 $Version・TVBS 網路新聞中心" 84 46 440 20 $FontSmall '#5d6676' | Out-Null
    Box $Form 0 84 560 1 '#e3e7ee' | Out-Null

    # ① 開始
    $PgStart = Page
    Lbl $PgStart '這個安裝程式會幫你把「網新快速排程」插件放到電腦上，大約 5 秒完成。' 22 20 516 46 $FontBody '#1b1f27' | Out-Null
    Lbl $PgStart '會放在這裡（不用改）：' 22 74 516 20 $FontSmall '#5d6676' | Out-Null
    $pathBox = Card $PgStart 22 96 516 46 '#e3e7ee' '#f5f7fb'
    Lbl $pathBox $Dir 10 6 494 34 $FontMono '#1b1f27' | Out-Null
    Lbl $PgStart '裝好後還要在 Chrome 點兩下，安裝程式會一步一步教你。' 22 156 516 40 $FontBody '#5d6676' | Out-Null
    $bCancel = Btn $PgStart.Tag '取消' 96 $false
    $bStart = Btn $PgStart.Tag '開始安裝' 110 $true
    Foot $PgStart @($bCancel, $bStart)
    $bCancel.Add_Click({ $Form.Close() })
    $bStart.Add_Click({ Start-Install })

    # ② 安裝中
    $PgProg = Page
    $Dots = @(); $Names = @()
    for ($i = 0; $i -lt 4; $i++) {
        $y = 18 + $i * 34
        $Dots += Lbl $PgProg '○' 22 $y 26 26 $FontDot '#c3cbd8'
        $Names += Lbl $PgProg $StepNames[$i] 52 ($y + 3) 460 24 $FontBody '#5d6676'
    }
    $BarBg = Box $PgProg 22 168 516 6 '#e6ebf3'
    $BarFg = Box $BarBg 0 0 0 6 '#004aad'
    $Pct = Lbl $PgProg '' 22 182 516 20 $FontSmall '#5d6676'
    $b1 = Btn $PgProg.Tag '取消' 96 $false
    $b2 = Btn $PgProg.Tag '安裝中…' 110 $true
    $b1.Enabled = $false; $b2.Enabled = $false
    Foot $PgProg @($b1, $b2)
    $GuiReport = {
        param($n, $t, $p)
        for ($i = 0; $i -lt 4; $i++) {
            if ($i + 1 -lt $n) { $Dots[$i].Text = '✓'; $Dots[$i].ForeColor = C '#15803d'; $Names[$i].ForeColor = C '#1b1f27'; $Names[$i].Font = $FontBody }
            elseif ($i + 1 -eq $n) { $Dots[$i].Text = '●'; $Dots[$i].ForeColor = C '#004aad'; $Names[$i].ForeColor = C '#004aad'; $Names[$i].Font = $FontBodyB }
            else { $Dots[$i].Text = '○'; $Dots[$i].ForeColor = C '#c3cbd8'; $Names[$i].ForeColor = C '#5d6676'; $Names[$i].Font = $FontBody }
        }
        if ($t -and $n -ge 1 -and $n -le 4) { $Names[$n - 1].Text = $t }
        $BarFg.Width = [int]($BarBg.Width * $p / 100)
        $Pct.Text = "$p%・請稍候，不要關掉這個視窗"
        [Windows.Forms.Application]::DoEvents()
        # 換步驟時停一下，看得出每一步有做
        if ($n -ne $S.n) { $S.n = $n; Start-Sleep -Milliseconds 250 }
    }

    # ③ 完成＋圖解
    $PgDone = Page
    $flow = New-Object Windows.Forms.FlowLayoutPanel
    $flow.Location = Pt 22 12; $flow.Size = Sz 516 48; $flow.BackColor = [Drawing.Color]::White
    $PgDone.Controls.Add($flow)
    $ok = New-Object Windows.Forms.Label
    $ok.Text = '✓ 檔案已經放好了！'; $ok.AutoSize = $true; $ok.Font = $FontBodyB; $ok.ForeColor = C '#15803d'; $ok.Margin = New-Object Windows.Forms.Padding 0
    $DoneLead = New-Object Windows.Forms.Label
    $DoneLead.AutoSize = $true; $DoneLead.MaximumSize = Sz 516 0; $DoneLead.Font = $FontBody; $DoneLead.ForeColor = C '#1b1f27'; $DoneLead.Margin = New-Object Windows.Forms.Padding 0
    $flow.Controls.Add($ok); $flow.Controls.Add($DoneLead)
    $cards = @(
        @{ x = 22; n = '1'; t = '打開「開發人員模式」'; d = '在右上角，把開關打開（變藍色）。'; k = 'dev' },
        @{ x = 286; n = '2'; t = '按「載入未封裝項目」'; d = '出現選資料夾的視窗時，按 Ctrl＋V 貼上路徑，再按「選擇資料夾」。'; k = 'load' }
    )
    foreach ($c in $cards) {
        $in = Card $PgDone $c.x 64 252 196 '#e3e7ee' '#ffffff'
        $num = Lbl $in $c.n 10 10 22 22 $FontSmall
        $num.BackColor = C '#004aad'; $num.ForeColor = [Drawing.Color]::White; $num.TextAlign = 'MiddleCenter'
        Round-It $num
        Lbl $in $c.t 38 10 206 24 $FontBodyB '#1b1f27' | Out-Null
        Lbl $in $c.d 10 38 232 44 $FontUI '#1b1f27' | Out-Null
        $shot = New-Object Windows.Forms.PictureBox
        $shot.Location = Pt 11 86; $shot.Size = Sz 228 100; $shot.SizeMode = 'Zoom'; $shot.Image = New-Shot $c.k
        $in.Controls.Add($shot)
    }
    $DoneTip = Lbl $PgDone '' 22 266 516 20 $FontUI '#5d6676'
    $bCopy = Btn $PgDone.Tag '再複製一次路徑' 130 $false
    $bChrome = Btn $PgDone.Tag '重新打開 Chrome 擴充功能頁' 200 $false
    $bDone = Btn $PgDone.Tag '完成' 96 $true
    Foot $PgDone @($bCopy, $bChrome, $bDone)
    $bCopy.Add_Click({ Copy-Text $Dir; $DoneTip.Text = '已經再複製一次了，到 Chrome 選資料夾的視窗按 Ctrl＋V。' })
    $bChrome.Add_Click({ try { Start-Process 'chrome.exe' 'chrome://extensions' } catch { $DoneTip.Text = '打不開 Chrome，請自己在 Chrome 網址列輸入 chrome://extensions' } })
    $bDone.Add_Click({ $Form.Close() })

    # ③' 舊位置還有一份
    $PgOld = Page
    Lbl $PgOld '✓ 檔案已經放好了！' 22 14 516 24 $FontBodyB '#15803d' | Out-Null
    $warn = Card $PgOld 22 48 516 196 '#f0d58a' '#fff7e0'
    Lbl $warn '⚠ 你的電腦還有一份舊位置的插件：' 12 12 490 24 $FontBodyB '#8a5a00' | Out-Null
    Lbl $warn $OldDir 12 40 490 22 $FontMono '#8a5a00' | Out-Null
    Lbl $warn '請先在 Chrome 擴充功能頁把舊的那個按「移除」，再照下一頁的兩步載入新的。' 12 72 490 48 $FontBody '#8a5a00' | Out-Null
    Lbl $warn '舊資料夾不會被刪掉；確認新的能用後，可以自己刪除。' 12 128 490 40 $FontUI '#8a5a00' | Out-Null
    $bNext = Btn $PgOld.Tag '下一步' 110 $true
    Foot $PgOld @($bNext)
    $bNext.Add_Click({ Show-Page $PgDone })

    # ✕ 失敗
    $PgErr = Page
    $big = Lbl $PgErr '!' 22 20 36 36 $FontTitle
    $big.BackColor = C '#c42b1c'; $big.ForeColor = [Drawing.Color]::White; $big.TextAlign = 'MiddleCenter'
    Round-It $big
    Lbl $PgErr '沒辦法安裝' 72 22 466 26 $FontTitle '#1b1f27' | Out-Null
    $ErrMsg = Lbl $PgErr '' 72 54 466 110 $FontBody '#1b1f27'
    Lbl $PgErr '照上面的說明處理後按「重試」。還是不行的話，按「複製錯誤訊息」貼給提供工具的同事。' 72 172 466 60 $FontUI '#5d6676' | Out-Null
    $bErrCopy = Btn $PgErr.Tag '複製錯誤訊息' 120 $false
    $bClose = Btn $PgErr.Tag '關閉' 96 $false
    $bRetry = Btn $PgErr.Tag '重試' 96 $true
    Foot $PgErr @($bErrCopy, $bClose, $bRetry)
    $bErrCopy.Add_Click({ Copy-Text ("$Name 安裝程式 $Version" + [Environment]::NewLine + "錯誤：" + $S.err + [Environment]::NewLine + "位置：$Dir" + [Environment]::NewLine + [Environment]::OSVersion.VersionString); $bErrCopy.Text = '已複製' })
    $bClose.Add_Click({ $Form.Close() })
    $bRetry.Add_Click({ Start-Install })

    $Timer = New-Object Windows.Forms.Timer
    $Timer.Interval = 1500
    # 只用 Activate 的話 Windows 常常只閃工作列，先切 TopMost 再切回來才會真的到最上面
    $Timer.Add_Tick({ $Timer.Stop(); $Form.TopMost = $true; $Form.TopMost = $false; $Form.Activate() })
    $Form.Add_FormClosing({ param($o, $e) if ($S.busy) { $e.Cancel = $true } })
    $Form.Add_Shown({ $Form.Activate() })
    $Form.AcceptButton = $bStart
    Show-Page $PgStart
} catch {
    Run-Text
}

# 視窗做好了才把後面的黑色命令視窗藏起來；視窗出錯就把它叫回來改用文字模式
if ($Native) { [SnnInst.Native]::ShowWindow([SnnInst.Native]::GetConsoleWindow(), 0) | Out-Null }
try {
    [Windows.Forms.Application]::Run($Form)
} catch {
    if ($Native) { [SnnInst.Native]::ShowWindow([SnnInst.Native]::GetConsoleWindow(), 5) | Out-Null }
    Run-Text
}
exit 0
`;

  // Mac：.sh 用「bash 檔案路徑」在終端機執行（不用改執行權限，也不會被 Gatekeeper 擋）。
  // 有 osascript（Mac）就用系統對話框：開始確認 → 舊位置提醒 → 完成後兩步說明；失敗可重試。
  // 沒有 osascript（或設 SNN_NO_DIALOG=1）就只有終端機文字，流程不變。
  function mac(zipB64, version) {
    check(zipB64, version);
    return [
      '#!/bin/bash',
      `# ${EXT_NAME} 安裝程式 ${version}`,
      'set -euo pipefail',
      '',
      `DIR="$HOME/Documents/${FOLDER}"`,
      `OLD="$HOME/${FOLDER}"`,
      `NAME='${EXT_NAME}'`,
      `PAYLOAD='${zipB64}'`,
      '',
      'GUI=0',
      'if [ -z "${SNN_NO_DIALOG:-}" ] && command -v osascript >/dev/null 2>&1; then GUI=1; fi',
      '# 系統對話框：dlg 圖示(note|caution|stop) 訊息 按鈕…（最後一個是預設）；印出按下的按鈕，關掉或出錯印空字串',
      'dlg() {',
      '  [ "$GUI" = 1 ] || return 0',
      "  osascript - \"$@\" <<'AS' 2>/dev/null || true",
      'on run argv',
      '  set ic to item 1 of argv',
      '  set msg to item 2 of argv',
      '  set btns to items 3 thru -1 of argv',
      '  activate',
      '  try',
      '    if ic is "stop" then',
      '      set r to display dialog msg with title "網新快速排程 安裝程式" buttons btns default button (count of btns) with icon stop',
      '    else if ic is "caution" then',
      '      set r to display dialog msg with title "網新快速排程 安裝程式" buttons btns default button (count of btns) with icon caution',
      '    else',
      '      set r to display dialog msg with title "網新快速排程 安裝程式" buttons btns default button (count of btns) with icon note',
      '    end if',
      '    return button returned of r',
      '  on error',
      '    return ""',
      '  end try',
      'end run',
      'AS',
      '}',
      'copy_path() { command -v pbcopy >/dev/null 2>&1 && printf \'%s\' "$1" | pbcopy; }',
      'fail() {',
      '  trap - ERR',
      "  printf '\\n安裝失敗：%s\\n請截圖這個視窗，並聯絡提供工具的同事。\\n' \"$1\"",
      "  local msg; msg=\"$(printf '沒辦法安裝\\n\\n%s\\n\\n照上面的說明處理後按「重試」。還是不行的話，按「複製錯誤訊息」貼給提供工具的同事。' \"$1\")\"",
      '  while :; do',
      '    case "$(dlg stop "$msg" \'複製錯誤訊息\' \'關閉\' \'重試\')" in',
      `      複製錯誤訊息) copy_path "$(printf '%s 安裝程式 %s\\n錯誤：%s\\n位置：%s\\n%s' "$NAME" '${version}' "$1" "$DIR" "$(sw_vers -productVersion 2>/dev/null || uname -sr)")" || true ;;`,
      '      重試) exec bash "$0" ;;',
      '      *) break ;;',
      '    esac',
      '  done',
      '  exit 1',
      '}',
      'trap \'fail "第 $LINENO 行執行失敗，原因請看上面的訊息"\' ERR',
      "step() { printf '\\n==> %s\\n' \"$1\"; }",
      '',
      "printf '%s 安裝程式 %s\\n' \"$NAME\" " + `'${version}'`,
      "START=\"$(printf '這個安裝程式會幫你把「網新快速排程」插件放到電腦上，大約 5 秒完成。\\n\\n會放在這裡（不用改）：\\n%s\\n\\n裝好後還要在 Chrome 點兩下，安裝程式會一步一步教你。' \"$DIR\")\"",
      'if [ "$GUI" = 1 ] && [ "$(dlg note "$START" \'取消\' \'開始安裝\')" != \'開始安裝\' ]; then',
      "  echo '已取消，沒有安裝任何東西。'",
      '  exit 0',
      'fi',
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
      '# 第一次寫「文件」資料夾，macOS 會問要不要讓終端機取用：要按「好」',
      'mkdir -p "$DIR" 2>/dev/null || fail "沒辦法寫入「文件」資料夾。macOS 問終端機能不能取用「文件」時請按「好」；按過不允許的話，到 系統設定 → 隱私權與安全性 → 檔案與資料夾 → 終端機，打開「文件資料夾」再執行一次。"',
      'ZIP="$(mktemp -t schedulenewnet-ext.XXXXXX)"',
      '# macOS 12 以前的 base64 只認 -D，13 以後兩個都認',
      "if printf 'QQ==' | base64 -d >/dev/null 2>&1; then DEC=-d; else DEC=-D; fi",
      "printf '%s' \"$PAYLOAD\" | base64 \"$DEC\" > \"$ZIP\"",
      'if command -v ditto >/dev/null 2>&1; then ditto -x -k "$ZIP" "$DIR"; else unzip -q -o "$ZIP" -d "$DIR"; fi',
      'rm -f "$ZIP"',
      'echo "    $DIR"',
      '',
      "step '複製資料夾路徑'",
      'COPIED=0',
      'if copy_path "$DIR"; then',
      '  COPIED=1',
      "  echo '    已複製，等一下在 Chrome 選資料夾時按 ⌘⇧G 再貼上'",
      'else',
      "  echo '    無法複製，請自己記下上面的路徑'",
      'fi',
      '',
      "step '開啟 Chrome 擴充功能頁'",
      'open_ext() { command -v open >/dev/null 2>&1 && open -a "Google Chrome" "chrome://extensions" 2>/dev/null; }',
      'CHROME=1',
      'if ! open_ext; then',
      '  CHROME=0',
      "  echo '    打不開 Chrome，請自己在 Chrome 網址列輸入 chrome://extensions'",
      'fi',
      '',
      'trap - ERR',
      "printf '\\n安裝檔完成！接著回到 Chrome：\\n'",
      "echo '  1. 打開擴充功能頁右上角的「開發人員模式」'",
      "echo '  2. 按左上角「載入未封裝項目」，按 ⌘⇧G 貼上路徑後按 Enter，再按「選取」'",
      "echo '  （已經載入過這個位置的話，不用重新載入，到擴充功能頁按插件上的重新整理圖示即可）'",
      'HAS_OLD=0',
      'if [ "$OLD" != "$DIR" ] && [ -f "$OLD/manifest.json" ] && grep -qF "\"$NAME\"" "$OLD/manifest.json"; then',
      '  HAS_OLD=1',
      "  printf '\n提醒：舊位置還有一份插件（以前的安裝檔放的）：\n  %s\n' \"$OLD\"",
      "  echo '  請在擴充功能頁先「移除」舊的那個，再照上面步驟載入新位置；確認新的能用後，舊資料夾可以刪掉。'",
      'fi',
      '',
      '[ "$GUI" = 1 ] || exit 0',
      '# Chrome 開起來會蓋在上面：等一下再跳對話框（dlg 會把對話框叫到最前面）',
      '[ "$CHROME" = 1 ] && sleep 1',
      'if [ "$HAS_OLD" = 1 ]; then',
      "  dlg caution \"$(printf '✓ 檔案已經放好了！\\n\\n⚠ 你的電腦還有一份舊位置的插件：\\n%s\\n\\n請先在 Chrome 擴充功能頁把舊的那個按「移除」，再照下一步的兩步載入新的。\\n舊資料夾不會被刪掉；確認新的能用後，可以自己刪除。' \"$OLD\")\" '下一步' >/dev/null",
      'fi',
      "if [ \"$CHROME\" = 1 ]; then LEAD='Chrome 的擴充功能頁已經幫你打開，照下面兩步完成：'; else LEAD='請在 Chrome 網址列輸入 chrome://extensions，再照下面兩步：'; fi",
      "if [ \"$COPIED\" = 1 ]; then TIP='路徑已經複製好了；不小心蓋掉的話按「再複製一次路徑」。'; else TIP='路徑沒有複製成功，請按「再複製一次路徑」。'; fi",
      'while :; do',
      "  DONE=\"$(printf '✓ 檔案已經放好了！%s\\n\\n① 打開「開發人員模式」\\n在擴充功能頁右上角，把開關打開（變藍色）。\\n\\n② 按「載入未封裝項目」\\n出現選資料夾的視窗時，按 ⌘⇧G、⌘V 貼上路徑後按 Enter，再按「選取」。\\n\\n%s' \"$LEAD\" \"$TIP\")\"",
      '  case "$(dlg note "$DONE" \'再複製一次路徑\' \'重新打開擴充功能頁\' \'完成\')" in',
      "    再複製一次路徑) if copy_path \"$DIR\"; then TIP='已經再複製一次了，到 Chrome 選資料夾的視窗按 ⌘⇧G、⌘V。'; fi ;;",
      "    重新打開擴充功能頁) open_ext || TIP='打不開 Chrome，請自己在 Chrome 網址列輸入 chrome://extensions' ;;",
      '    *) break ;;',
      '  esac',
      'done',
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
