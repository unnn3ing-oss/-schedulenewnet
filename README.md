# 網新快速排程（新介面）

網新發文台的新前端介面，沿用現有後端，只重做介面。發布於 GitHub Pages。

- 主要分支：`main`；所有改動都先開 PR，確認後才併入。

## 網址總覽

| 用途 | 網址 |
|---|---|
| 正式介面 | https://unnn3ing-oss.github.io/-schedulenewnet/ |
| 連線驗證 | https://unnn3ing-oss.github.io/-schedulenewnet/verify.html |
| 出圖測試 | https://unnn3ing-oss.github.io/-schedulenewnet/render-test.html |
| 後端（原發文台） | https://digi-social-post.tvbs.ai/ip/newsnet/ |
| 圖床 Worker | https://snn-images.19jpz-3.workers.dev |
| 圖床自我檢查（應回 404 JSON） | https://snn-images.19jpz-3.workers.dev/i/00000000000000000000000000000000.jpg |
| Worker 設定（Variables and Secrets） | https://dash.cloudflare.com/?to=/:account/workers/services/view/snn-images/production/settings |
| R2 儲存桶 | https://dash.cloudflare.com/?to=/:account/r2/overview |
| GitHub 儲存庫 | https://github.com/unnn3ing-oss/-schedulenewnet |
| FB RUNDOWN 試算表 | https://docs.google.com/spreadsheets/d/1OZOcobchhiFU6rf9jTJW00YNSHQXxNjurpudQdVl4Lo/edit |
| Apps Script 專案管理 | https://script.google.com/home |

## 架構（B 方案）

GitHub Pages 上的介面沒辦法直接帶網新後台的 cookie（全部是 `SameSite=Lax`），所以透過 Chrome 外掛代送：

```
GitHub Pages 介面 ──postMessage──▶ 外掛 bridge.js ──▶ 外掛 background.js
                                                    ├─ B1  直接 fetch digi-social-post.tvbs.ai（帶 cookie）
                                                    ├─ B1o 同上，Origin 改成網新網址
                                                    └─ B2  交給網新分頁，在原網域內 fetch
```

## 連線驗證（目前階段）

1. 在 Chrome 登入網新發文台。
2. 安裝外掛：網站右上角「🧩 安裝插件」有 5 步驟教學。主要做法仿 videodownload 的一鍵安裝檔（`web/installer.js`）：網頁先從 GitHub 抓最新的 `extension/`（每個檔案以 git blob SHA 驗證），打包嵌進 Windows `schedulenewnet-install.cmd`／Mac `schedulenewnet-install-mac.sh`（Mac 在終端機執行 `bash ~/Downloads/schedulenewnet-install-mac.sh`）。安裝檔把插件放到「文件」資料夾裡的 `schedulenewnet-ext`（Windows 用 `GetFolderPath('MyDocuments')`，有 OneDrive 重新導向也跟著走；Mac 是 `~/Documents`，第一次會問終端機能否取用「文件」，要按「好」。同名資料夾不是這個插件就停下、不覆蓋；舊版安裝檔放在家目錄的那份只提醒移除，不自動刪）、把路徑複製到剪貼簿、打開 `chrome://extensions`；剩下「開發人員模式」→「載入未封裝項目」→ 貼上路徑要自己點（Chrome 不允許程式代按）。Windows 安裝檔執行後是一般的安裝視窗（PowerShell + WinForms：開始 → 四步進度 → 完成頁附兩步圖解、「再複製一次路徑」；失敗可「重試」「複製錯誤訊息」），視窗開不起來時退回原本的文字輸出並停在 pause。Mac 一樣在終端機貼指令執行，但過程改用 `osascript` 的系統對話框（開始確認 → 舊位置提醒 → 完成頁兩步說明、可再複製路徑／重開擴充功能頁；失敗可「重試」「複製錯誤訊息」），沒有 osascript 或設 `SNN_NO_DIALOG=1` 時只有終端機文字。公司電腦不能執行安裝檔時，教學裡仍可改用「選擇資料夾並寫入」或下載 ZIP。電腦版打開網站時偵測不到外掛會自動跳出這個教學（手機不跳）。
3. 開 `https://unnn3ing-oss.github.io/-schedulenewnet/verify.html`，按「開始驗證」。

驗證頁只會呼叫 `page_meta`、`guard/check`，**不會排程或發文**；cookie 只讀名稱與到期時間，不讀值。外掛（0.5.0 起）的端點白名單：`page_meta`、`hero`、`guard/check`、`render`、`render_text_card`、`ai_caption`、`schedule`、`publish`，其他路徑一律拒絕。

## 正式介面（進行中）

`web/index.html` 是正式介面，分 PR 逐步完成（PR A、B、C）。PR A 的部分：

- 頂列：外掛連線與登入剩餘天數（經外掛的 `cookies`）；沒裝外掛會顯示「未偵測到外掛」並連到上方的安裝步驟。
- 「＋ 新增發文」置中彈窗（Esc 關閉、焦點鎖定、有未存內容會先確認）：
  - **作圖框**：選照片／拖曳／Ctrl+V 貼上、滾輪與雙指縮放、拖曳平移；畫布一律 1080×1080；7 種貼圖與馬賽克（取自 QPT `stickers.js`）。預覽下方只有「新聞（藍框）」（預設）／「娛樂（粉框）」兩個版型（同 QPT），預覽會疊上 `web/frames/news.png`／`ent.png`（漸層＋右上角 logo）與標題（QPT 的畫法：WHZ-Heavy `web/fonts/whz-heavy.ttf`、67px、白字置中、區塊中心 y=880），讓小編看到套版後的樣子。**疊圖與標題只在預覽**：`Editor.exportBlob()`（上傳圖床的 JPEG q0.92）只有照片＋馬賽克＋貼圖，後端會自己套版。
  - **純文字底圖**：7 種底色，卡面文字就是右欄的標題（照標題框的分行，以 `\n` 接起來當 `text`），預覽為示意，實際以後端產圖為準。
  - 右欄（文章網址 → 標題 → 小編文）兩種模式共用、順序相同，切換模式不清內容。
  - **快速帶入**：貼文章網址按 Enter 或「帶入」，透過外掛呼叫 `page_meta` 填標題（換行規則與 QPT `breakTitle` 相同，一行一句填進標題框）、用外掛新增的 `fetchImage`（僅限 tvbs.com.tw 圖片）載入主圖。
  - **帶入預填小編文（QPT 的圖文格式）**：同時用外掛 0.6.0 的 `fetchArticle` 下載文章網頁，以 `web/article.js`（`parseArticle`、`pickTags`、`formatCopy` 等逐字複製自 QPT `quickfill.js`）解析，小編文填成 `【標題】`／主圖圖說（例：`（圖／TVBS）`）／`#標籤 #標籤 #標籤`（只留 2～3 字、最多 3 個）。小編文是空的或還是上次自動填的才覆蓋，小編改過就不動、只更新【標題】那一行。沒抓到圖說或 hashtag 會在提示列出；舊外掛沒有 `fetchArticle` 時提示更新，標題與【標題】照樣帶入。
  - **【標題】跟著標題框**：標題框每改一個字，小編文裡的【…】那一行就換成新標題（接成一行，沒改過的相鄰兩行照原標題的接法，同 QPT 的 `learnSeps`／`titleAsOneLine`）。不論【…】在第幾行都找得到，只換那一行；小編把那一行整行刪掉就不再補回來。
  - **AI 產生放最上面**：「✨ AI 產生」的文字放在小編文最上面、【標題】之上；再按一次會換掉上一次的 AI 文字，不會疊兩份。校錯字不變。
  - 標題是一個輸入框（Enter 換行，一行一句）；每行字數（全形 1、半形 0.5）顯示在框外右側、和該行對齊，超過上限 15 或第 4 行起變紅。

PR B（送出）：

- **圖床登入**：頂列「圖床未登入／已登入」可點開登入；第一次預覽或送出作圖框時也會自動跳出。輸入圖床密碼（Worker 的 `APP_PASSWORD`）換憑證，預設 30 天有效（Worker 的 `SESSION_DAYS` 可改），存在本機 localStorage（不存密碼）；上傳或 Rundown 成功時，憑證剩不到一半效期，Worker 會附一張新的、網頁自動換上，所以常用的人不用再登入，超過效期沒用才要重登。過期或上傳回 401 會再跳出登入。要讓所有人立刻登出：更換 `SESSION_SECRET`。**免密碼模式**（Worker 沒設 `APP_PASSWORD`，見下方「圖床」）：頂列顯示「圖床已連線」，預覽、送出、背景預先上傳都自動拿憑證，不跳密碼視窗；網頁開啟時打 `GET /config` 判斷，查不到（網路錯或舊版 Worker）就照要密碼處理。圖床網址寫在 `web/imghost.js`；Worker 的 `ALLOWED_ORIGIN` 必須是介面所在網址（GitHub Pages 是 `https://unnn3ing-oss.github.io`），本機 localhost 測試時要暫時改這個變數，否則瀏覽器會擋 CORS。
- **作圖框送出**：`Editor.exportBlob()` 的 JPEG（不含疊圖與標題）上傳圖床，網址當 `image_url`、`crop: null`；勾選的每一台都送同一個 `template`：藍框 `newsnet_news`、粉框 `newsnet_ent`。純文字底圖不上傳，由後端依 `text_card` 欄位產圖（`title_lines` 空陣列、`line1`／`line2` 空字串，照交接文件 §4、§5）。
- **🖼 後端預覽**：作圖框打 `/render`（目前選的藍框／粉框）、純文字打 `/render_text_card`，顯示後端實際產的圖。預覽和送出共用同一次上傳（照片／貼圖沒改就不重傳）。
- **✨ AI 產生／🔍 校錯字**：`/ai_caption`（`generate` 帶標題（各行直接接起來，同官方發文台）與帶入的文章摘要，回應 `{ versions, hashtags, usedArticle, note }` 取第一個版本放最上面、hashtag 併進最後一行（原有的優先，AI 的只補到總共 3 個、不重複）；`proofread` 帶小編文與標題），結果填入小編文。
- **粉專 ▾**：立即發布（預設）／排程發布。排程視窗：日期預設今天、最晚 3 天後；時間直接打 4 碼（`2130` → `21:30`），↑↓ 每次 ±10 分；早於現在＋20 分或超過 3 天會在視窗內標紅。
- **全部送出（兩段式）**：第 1 次按先檢查內容（照交接文件 §6.6 的順序）並自動打 `/guard/check`，按鈕上方泡泡列出每台與時間（立即或 HH:MM）和燈號，按鈕變「確認送出」；紅燈要勾「我知道風險」。點其他地方或改內容就回到第 1 步。第 2 次按才逐台送 `/publish` 或 `/schedule`（payload 由 `web/payload.js` 產生，完全照交接文件 §4）。失敗的台顯示錯誤（HTML 錯誤頁只顯示精簡訊息）與「↻ 重送」，只重送那一台。全部成功不清空，改按「清空頁面」。
- **本機送出紀錄**：每次送出存一筆到 localStorage（`snn.records.v1`：粉專、立即／排程、時間、結果、貼文連結），列表見下方 PR C。

PR C（送出紀錄）：

- 主畫面的「送出紀錄」列出這台瀏覽器送出的貼文（**後端沒有列表端點，紀錄只存在這台瀏覽器**，換電腦或清除網站資料就看不到）。分頁籤「全部／已排程／已發布／失敗」附數量，新的在前，每頁 20 筆（頁碼列同 hottopic）。
- 每筆：縮圖（送出當下的預覽畫面，約 20 KB 內的 JPEG）、標題（第一行粗體、其餘淡色）、作圖框／純文字底圖、藍框／粉框、送出時間，以及每台一顆狀態：
  - `已發布 ↗`：有貼文連結就點開；
  - `排程 MM/DD HH:mm`：時間過了，若後端排程時有回 `post_url` 或 `post_id`（FB「粉專ID_貼文ID」的數字格式），改成 `已發布 MM/DD HH:mm ↗` 可點開貼文（列表每分鐘重畫，時間沒到不給連結）；沒有回就改成「應已發布（推測）」。兩者都只是依時間推測，網頁沒辦法向後端確認是否真的發出（`/schedule` 回 `post_id` 也是推論，後端文件沒寫），打不開請到粉專確認；
  - `失敗 ↻ 重送`：游標移上去看錯誤，點了開重送視窗。
- **從列表重送**：用紀錄裡存的那一台的請求內容（`body`）原樣再送一次，只換守則欄位與排程時間，結果更新在同一筆紀錄。燈號沿用紀錄裡的判讀結果（舊紀錄沒有就重新打 `/guard/check`）；紅燈一定要再勾「我知道風險」。排程的台若原本時間已過或離現在不到 20 分鐘，要先選新時間（同新增發文的時間視窗：打 4 碼、↑↓ ±10 分、最晚 3 天）。作圖框的圖在圖床 3 天後失效：超過就不能重送，排程也不能晚於失效時間，請改用「複製到新增發文」。PR B 的舊紀錄沒有存請求內容，也只能用複製重做。
- **複製到新增發文**：開新增發文並帶入標題、小編文、文章網址、藍框／粉框、模式（純文字底圖連底色）；照片不帶，要重新選。
- **複製標題／複製圖片**：「複製標題」把標題分行（純文字底圖是卡面文字）放進剪貼簿。「複製圖片」用送出當下存的出圖請求（紀錄的 `render`，只存圖床網址與文字，不存圖）經外掛重新打 `/render`（body 同舊版：`{ image_url, lines, layout, crop }`）或 `/render_text_card`，把 FB 上看到的成品圖以 PNG 放進剪貼簿，可直接貼到 LINE、FB 等。作圖框的圖在圖床 3 天後失效，過期就停用並顯示「圖片已過期（圖床只保留 3 天）」；舊紀錄沒存出圖資料也停用（點了會說明原因）。瀏覽器不支援複製圖片時改下載 `newsnet-<文章編號或送出時間>.png`。
- **刪除紀錄**：確認後只刪這台瀏覽器裡的那一筆，不影響已發布或已排程的貼文。
- 儲存空間：最多留 200 筆；縮圖只留 7 天內、最新 60 筆；成功的台不再存請求內容。瀏覽器空間不足（QuotaExceeded）時先丟縮圖、再刪最舊的紀錄，不會擋住送出。
- 手機（390px）：紀錄的縮圖和標題一列、狀態換到下一列並可換行；頂列的連線狀態換到第二列；新增發文底列的粉專按鈕會換行，「全部送出」整條寬。

外掛 0.6.0 新增 `fetchArticle`（只下載 tvbs.com.tw 的 https 文章網頁：不帶 cookie、轉址後的網址也要在 tvbs.com.tw、只收 `text/html`、5 MB、15 秒以內；只回網頁原文，不呼叫後端），帶入時才能預填圖說與 hashtag。

外掛要升到 0.5.0（白名單加入 `render_text_card`、`ai_caption`、`schedule`、`publish`）；舊外掛按送出會顯示「外掛版本太舊」。測試：`npm test`（payload、時間解析、泡泡狀態、送出紀錄的篩選／分頁／上限／重送條件等純函式）；瀏覽器端到端：`node test/e2e/app.e2e.js`（需要 Playwright 與 Chromium；送出流程用模擬的外掛與圖床，不會連到網新或 Cloudflare）。外掛側邊欄更新彈窗：`node test/e2e/sidepanel.e2e.js`（真的把 `extension/` 載入 Chromium，`Updater` 換成假的，不連 GitHub、不寫檔案）。

## Rundown 自動排入（Google Apps Script）

送出成功（排程或立即）後，把 `文章ID/圖文/SLUG` 寫進 FB RUNDOWN。新增發文右欄 SLUG 上方有「排入 Rundown」開關（存在各自的瀏覽器）與 ⚙（測試連線）。網站經圖床 Worker 的 `POST /rundown` 轉送（用圖床登入），Apps Script 網址與金鑰只放在 Worker Secrets，網頁端不存。

- **對應**：有勾選並送成功的粉專各寫一筆——新聞＝主粉（新聞粉）、娛樂＝娛樂粉、少康＝少康粉、國際＋＝國際＋粉；擠看看、氣象沒有區段，略過。時間用該粉專的排程時間（立即＝送出當下）。
- **位置**：分頁 `YYYY/MM` → 第 1～5 列的 `MMDD` 日期欄 → 該粉專區段 → 時段（A 欄 4 碼）→ 分鐘看右邊一欄的碼（`0`＝:00、`-5`＝:05、`1`＝:10、`15`＝:15…`55`＝:55）。右邊那欄已被隔天內容蓋掉時，改用同時段其他欄還留著的分鐘碼；都沒有就只看 A 欄時段。
- **照時間順序排進去**：目標＝時間 ≤ 目標時間的最後一筆稿子的下一格，但不早於最接近的分鐘格（08:07 → :05 那格）。目標格可填就直接填；已有稿子就插在這格，只把這個日期欄往下推到第一個可填的格子（例：10/26 09:07 → 插在 AA124，原本 AA124～133 移到 AA125～134）。隔天那欄是分鐘碼時，同一段分鐘碼也一起往下推，被推的稿子時間不變；新的那格補上目標時間的分鐘碼（15:13 → `13`、15:03 → `-3`）。填入的稿子一律設成和現有 `/圖文/` 相同的樣式：字級 12、粗體、紫色 `#9900ff`。可填＝空白、前一天留下的分鐘碼、沒有 ID 與 SLUG 的 `/文字/`、`/圖文/`。
- **不重複**：同一天同區段已有同一個 `文章ID/圖文/` 就不再寫。
- **SLUG**：小編文下面的欄位；空白就用標題第一行前 4 字。

### 安裝（一次性，約 5 分鐘）

1. 用有 FB RUNDOWN 編輯權限的 Google 帳號，到 https://script.google.com/home 新增專案，把 `gas/rundown.gs` 整份貼進 `程式碼.gs`。
2. 專案設定（齒輪）→ 時區選「(GMT+08:00) 台北」→ 指令碼屬性新增 `TOKEN`：自訂一串至少 12 字的金鑰（只給網新小編）。試算表換年份時再加 `SHEET_ID`（網址 `/d/` 後面那段）。
3. 部署 → 新增部署作業 → 類型「網頁應用程式」：執行身分「我」、誰可以存取「所有人」→ 部署，授權存取試算表。
4. 複製「網頁應用程式網址」（`https://script.google.com/macros/s/…/exec`）。
5. Cloudflare → 圖床 Worker → Settings → Variables and Secrets 新增兩個 **Secret**：`RUNDOWN_URL`＝上一步的網址、`RUNDOWN_TOKEN`＝第 2 步的 TOKEN（完全相同）。`worker/index.js` 有更新時，重新貼上並 Deploy。
6. 網站新增發文 → 勾底列「排入 Rundown」→ ⚙ → 測試連線（會列出分頁名稱）。

改了 `gas/rundown.gs` 要到「管理部署作業」編輯同一個部署、版本選「新版本」，網址才不會變。

## 外掛側邊欄與自動更新

- 點瀏覽器工具列的外掛圖示會開啟側邊欄（0.8.0 起）：
  - 最上方「**網頁版**」在新分頁開網新快速排程、「**舊版**」開原本的網新發文台。
  - 「發文」分頁直接嵌入網頁版（iframe），流程和網頁版完全相同，網站更新側邊欄也跟著更新；外掛的 `bridge.js` 以 `all_frames` 注入這個 iframe。外掛另有 `unnn3ing-oss.github.io` 的存取權，所以側邊欄和分頁共用同一份送出紀錄與設定（瀏覽器不會把它們分開存）。嵌入時網頁不顯示「安裝插件」。
  - 「狀態與更新」分頁：網新登入狀態（`queen_session` 是否存在、幾天後到期）、工具連結，以及「版本更新」；有新版時分頁標籤顯示「新」。
- 外掛每小時自動向 GitHub 檢查一次，Chrome 啟動、外掛安裝或重新載入時也會馬上檢查（5 分鐘內查過就跳過），打開側邊欄也會檢查。有新版時圖示會顯示紅色「新」；也可以在側邊欄按「檢查更新」。
- 有新版時，打開側邊欄會直接在外掛裡跳出彈窗（同一版只主動跳一次，按「稍後」之後可在「狀態與更新」按「更新到最新版」）。按「立即更新」：第一次會在彈窗說明後請你選外掛所在的資料夾（選資料夾視窗從「文件」開始；用安裝檔裝的是「文件」裡的 `schedulenewnet-ext`，舊版安裝檔裝的在家目錄），**選一次就記住**，之後都直接更新到同一個位置；Chrome 問能不能編輯檔案時按允許（有「每次都允許」就選它）。接著下載、驗證並寫入有變動的檔案，進度、權限變動確認、完成或失敗（可重試、重新選擇資料夾）都顯示在彈窗裡，不用瀏覽器的對話框；完成後重新載入外掛。資料夾搬家了可在「狀態與更新」按「更換資料夾」。只同步 repo 的 `extension/` 資料夾，其他檔案不受影響。
- **v0.2.0（含）以前的版本沒有更新功能**，需要手動把 `extension/` 資料夾整個換成新版一次（重新載入外掛）；之後就能自動更新。
- 維護規則：只要 `extension/` 內有任何變動，就要同步調高 `manifest.json` 的 `version`，並在 `changelog.json` 加一筆對應版本的說明。

## 部署

`main` 有推送時，`.github/workflows/pages.yml` 會把 `web/` 發布到 GitHub Pages（不跑測試）。第一次需要到 repo 的 Settings → Pages，把 Source 設成「GitHub Actions」。

## 圖床（Cloudflare Worker＋R2）部署

網頁在瀏覽器內產生 1080×1080 的 JPEG／PNG，上傳到這個圖床取得公開、無法猜到的網址，再把網址當作 `image_url` 交給後端抓取。圖片 3 天後自動失效。程式在 `worker/index.js`（單一檔案，無相依套件），測試用 `npm test`（只需要 Node 22，不必安裝任何套件）。

端點：`GET /config`（回 `{"ok":true,"data":{"password":true|false}}`，網頁據此決定要不要跳密碼視窗）、`POST /login`（密碼換憑證，預設 30 天；免密碼模式不看密碼）、`POST /upload`（`Authorization: Bearer 憑證`，內容為圖片原始位元組，檢查檔頭與大小；憑證剩不到一半效期時回應附 `data.renew` 新憑證，`/rundown` 也一樣）、`GET /i/<key>`（公開讀取，過期即刪除並回 404）。

### 部署步驟（約 10 分鐘，一次性）

下列儀表板選單名稱都是依記憶寫的，**未查證**；實際畫面若不同，請以 Cloudflare 當時的介面為準。

1. **R2 與生命週期規則**
   - Cloudflare 儀表板 → R2 → 啟用。啟用時 Cloudflare 可能要求綁定付款方式（**未查證**）；免費額度為 10 GB（**未查證**）。
   - 建立 bucket，名稱 `snn-images`。
   - 進入 bucket → Settings → Object lifecycle rules → 新增規則：物件上傳後 3 天刪除（Delete objects 3 days after upload）（**未查證**）。這是主要的清理機制；Worker 讀取時也會自行刪除超過 `MAX_AGE_DAYS` 的物件，當作備援。
2. **建立 Worker**：Workers & Pages → Create → Worker，名稱 `snn-images` → Deploy → Edit code，把 `worker/index.js` 整份貼上 → Deploy。
3. **綁定 R2**：Worker → Settings → Bindings → Add → R2 bucket，變數名稱 `IMAGES`，選 `snn-images` → Deploy。
4. **設定變數與機密**：Worker → Settings → Variables and Secrets：

   | 名稱 | 類型 | 內容 |
   |---|---|---|
   | `APP_PASSWORD` | Secret | 網頁登入密碼（建議 12 字元以上，自己決定）；不設＝免密碼模式（見下方「免密碼模式」） |
   | `SESSION_SECRET` | Secret | 隨機 32 字元以上（產生方式見下） |
   | `ALLOWED_ORIGIN` | Text | `https://unnn3ing-oss.github.io` |
   | `RUNDOWN_URL` | Secret（選用） | Rundown 的 Apps Script `/exec` 網址（見「Rundown 自動排入」） |
   | `RUNDOWN_TOKEN` | Secret（選用） | 與 Apps Script 指令碼屬性 `TOKEN` 相同（至少 12 字） |
   | `SESSION_DAYS` | Text（選用） | 登入有效天數，`1`～`365`，預設 `30` |
   | `MAX_AGE_DAYS` | Text（選用） | `3`（預設就是 3） |
   | `MAX_BYTES` | Text（選用） | 預設 8388608（8 MB） |

   產生 `SESSION_SECRET`：在任一網頁的 Console 執行 `crypto.randomUUID()+crypto.randomUUID()`，複製結果（不含引號）。

   選用的 `LOGIN_LIMITER`（Rate Limiting 綁定）有綁定才會啟用，登入以 IP、上傳以憑證為 key；免費方案是否可用、能否在儀表板設定都**未查證**。
5. **自我檢查**：開啟 `https://snn-images.19jpz-3.workers.dev/i/00000000000000000000000000000000.jpg`，應看到 404 的 JSON（`{"ok":false,"code":"not_found",…}`），代表 Worker 已部署。

   進一步可用 `curl` 試登入（把密碼換成自己的；免密碼模式密碼隨便填）：

   ```bash
   curl -s -X POST https://snn-images.19jpz-3.workers.dev/login -H 'Content-Type: text/plain' -d '{"password":"你的登入密碼"}'
   # 預期：{"ok":true,"data":{"session":"…","exp":…,"ttl":2592000}}（2592000 秒＝30 天）
   ```

   回 `misconfigured`（HTTP 500）代表 Secret、綁定或名稱有漏設或打錯。

   **登入時出現「Worker 尚未設定完成。」**：到 [Worker 設定](https://dash.cloudflare.com/?to=/:account/workers/services/view/snn-images/production/settings) → Variables and Secrets 檢查：
   - `SESSION_SECRET`（至少 32 字元）一定要在；`APP_PASSWORD` 有設的話至少 8 字元（不設＝免密碼模式），名稱大小寫、底線完全一致。
   - `SESSION_SECRET` 複製時沒有連引號一起貼上。
   - 設在 `snn-images` 這個 Worker；儲存後若出現 Deploy 按鈕要按。
   - 登入成功但上傳仍出現同一句：Bindings 要有 R2 bucket，變數名稱為 `IMAGES`。

### 注意

- 圖片 3 天後失效，所以網頁只允許排程在 3 天內的貼文；排程時間超過 3 天的，後端抓圖時圖片已不存在。
- 已發布的 FB 貼文不受影響：FB 抓圖後有自己的副本，圖床刪除圖片不會讓已發布的貼文失去圖片（這點依 Facebook 一般行為判斷，**未查證**）。
- 換登入密碼：只改 `APP_PASSWORD`。要讓所有人立刻登出：更換 `SESSION_SECRET`。`worker/index.js` 改版後，重新貼上並 Deploy。

### 免密碼模式（暫時拿掉圖床密碼）

- **先更新 Worker**：免密碼模式需要新版 `worker/index.js`（有 `GET /config`）。到 Worker → Edit code，把 `worker/index.js` 整份重新貼上 → Deploy。舊版 Worker 刪掉 `APP_PASSWORD` 只會回「Worker 尚未設定完成。」。
- **拿掉密碼**：Worker → Settings → Variables and Secrets → 刪除 `APP_PASSWORD`（或設成空字串）→ 儲存／Deploy。網頁重新整理後頂列顯示「圖床已連線」，不再跳密碼視窗。
- **恢復密碼**：重新新增 `APP_PASSWORD`（Secret，至少 8 字元）→ 儲存／Deploy。網頁重新整理後就回到要密碼；已經拿到的憑證到期前（最多 30 天，或 `SESSION_DAYS` 設的天數）仍可上傳，要立刻作廢就同時更換 `SESSION_SECRET`。
- 其餘不變：仍需要 `SESSION_SECRET`，上傳仍要憑證，檔頭（只收 JPEG／PNG／WebP）、大小上限、`ALLOWED_ORIGIN`、`LOGIN_LIMITER` 照舊；`/rundown` 也用同一張憑證。
- **風險**：沒有密碼時，任何知道 Worker 網址的人都能直接拿憑證上傳圖片（`ALLOWED_ORIGIN` 只擋瀏覽器跨站，擋不了 `curl` 之類的直接呼叫），也能經 `/rundown` 寫入 FB RUNDOWN（若有設 `RUNDOWN_URL`／`RUNDOWN_TOKEN`）。上傳的圖 3 天後失效、限制類型與大小，但仍可能被拿來放別的圖或吃掉 R2 額度。建議只短期使用，有綁 `LOGIN_LIMITER` 更好，用完盡快設回 `APP_PASSWORD`。
