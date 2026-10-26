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
2. `chrome://extensions` → 開「開發人員模式」→「載入未封裝項目」→ 選 `extension/` 資料夾。
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
  - 標題是一個輸入框（Enter 換行，一行一句）；每行字數（全形 1、半形 0.5）顯示在框外右側、和該行對齊，超過上限 15 或第 4 行起變紅。

PR B（送出）：

- **圖床登入**：頂列「圖床未登入／已登入」可點開登入；第一次預覽或送出作圖框時也會自動跳出。輸入圖床密碼（Worker 的 `APP_PASSWORD`）換 12 小時憑證，存在本機 localStorage（不存密碼）；過期或上傳回 401 會再跳出登入。圖床網址寫在 `web/imghost.js`；Worker 的 `ALLOWED_ORIGIN` 必須是介面所在網址（GitHub Pages 是 `https://unnn3ing-oss.github.io`），本機 localhost 測試時要暫時改這個變數，否則瀏覽器會擋 CORS。
- **作圖框送出**：`Editor.exportBlob()` 的 JPEG（不含疊圖與標題）上傳圖床，網址當 `image_url`、`crop: null`；勾選的每一台都送同一個 `template`：藍框 `newsnet_news`、粉框 `newsnet_ent`。純文字底圖不上傳，由後端依 `text_card` 欄位產圖（`title_lines` 空陣列、`line1`／`line2` 空字串，照交接文件 §4、§5）。
- **🖼 後端預覽**：作圖框打 `/render`（目前選的藍框／粉框）、純文字打 `/render_text_card`，顯示後端實際產的圖。預覽和送出共用同一次上傳（照片／貼圖沒改就不重傳）。
- **✨ AI 產生／🔍 校錯字**：`/ai_caption`（`generate` 帶標題與帶入的文章摘要；`proofread` 帶小編文與標題），結果填入小編文。
- **粉專 ▾**：立即發布（預設）／排程發布。排程視窗：日期預設今天、最晚 3 天後；時間直接打 4 碼（`2130` → `21:30`），↑↓ 每次 ±10 分；早於現在＋20 分或超過 3 天會在視窗內標紅。
- **全部送出（兩段式）**：第 1 次按先檢查內容（照交接文件 §6.6 的順序）並自動打 `/guard/check`，按鈕上方泡泡列出每台與時間（立即或 HH:MM）和燈號，按鈕變「確認送出」；紅燈要勾「我知道風險」。點其他地方或改內容就回到第 1 步。第 2 次按才逐台送 `/publish` 或 `/schedule`（payload 由 `web/payload.js` 產生，完全照交接文件 §4）。失敗的台顯示錯誤（HTML 錯誤頁只顯示精簡訊息）與「↻ 重送」，只重送那一台。全部成功不清空，改按「清空頁面」。
- **本機送出紀錄**：每次送出存一筆到 localStorage（`snn.records.v1`：粉專、立即／排程、時間、結果、貼文連結），列表見下方 PR C。

PR C（送出紀錄）：

- 主畫面的「送出紀錄」列出這台瀏覽器送出的貼文（**後端沒有列表端點，紀錄只存在這台瀏覽器**，換電腦或清除網站資料就看不到）。分頁籤「全部／已排程／已發布／失敗」附數量，新的在前，每頁 20 筆（頁碼列同 hottopic）。
- 每筆：縮圖（送出當下的預覽畫面，約 20 KB 內的 JPEG）、標題（第一行粗體、其餘淡色）、作圖框／純文字底圖、藍框／粉框、送出時間，以及每台一顆狀態：
  - `已發布 ↗`：有貼文連結就點開；
  - `排程 MM/DD HH:mm`：時間過了改成「應已發布（推測）」——網頁沒辦法向後端確認，只是依時間推測，請到粉專確認；
  - `失敗 ↻ 重送`：游標移上去看錯誤，點了開重送視窗。
- **從列表重送**：用紀錄裡存的那一台的請求內容（`body`）原樣再送一次，只換守則欄位與排程時間，結果更新在同一筆紀錄。燈號沿用紀錄裡的判讀結果（舊紀錄沒有就重新打 `/guard/check`）；紅燈一定要再勾「我知道風險」。排程的台若原本時間已過或離現在不到 20 分鐘，要先選新時間（同新增發文的時間視窗：打 4 碼、↑↓ ±10 分、最晚 3 天）。作圖框的圖在圖床 3 天後失效：超過就不能重送，排程也不能晚於失效時間，請改用「複製到新增發文」。PR B 的舊紀錄沒有存請求內容，也只能用複製重做。
- **複製到新增發文**：開新增發文並帶入標題、小編文、文章網址、藍框／粉框、模式（純文字底圖連底色）；照片不帶，要重新選。
- **複製標題／複製圖片**：「複製標題」把標題分行（純文字底圖是卡面文字）放進剪貼簿。「複製圖片」用送出當下存的出圖請求（紀錄的 `render`，只存圖床網址與文字，不存圖）經外掛重新打 `/render`（body 同舊版：`{ image_url, lines, layout, crop }`）或 `/render_text_card`，把 FB 上看到的成品圖以 PNG 放進剪貼簿，可直接貼到 LINE、FB 等。作圖框的圖在圖床 3 天後失效，過期就停用並顯示「圖片已過期（圖床只保留 3 天）」；舊紀錄沒存出圖資料也停用（點了會說明原因）。瀏覽器不支援複製圖片時改下載 `newsnet-<文章編號或送出時間>.png`。
- **刪除紀錄**：確認後只刪這台瀏覽器裡的那一筆，不影響已發布或已排程的貼文。
- 儲存空間：最多留 200 筆；縮圖只留 7 天內、最新 60 筆；成功的台不再存請求內容。瀏覽器空間不足（QuotaExceeded）時先丟縮圖、再刪最舊的紀錄，不會擋住送出。
- 手機（390px）：紀錄的縮圖和標題一列、狀態換到下一列並可換行；頂列的連線狀態換到第二列；新增發文底列的粉專按鈕會換行，「全部送出」整條寬。

外掛要升到 0.5.0（白名單加入 `render_text_card`、`ai_caption`、`schedule`、`publish`）；舊外掛按送出會顯示「外掛版本太舊」。測試：`npm test`（payload、時間解析、泡泡狀態、送出紀錄的篩選／分頁／上限／重送條件等純函式）；瀏覽器端到端：`node test/e2e/app.e2e.js`（需要 Playwright 與 Chromium；送出流程用模擬的外掛與圖床，不會連到網新或 Cloudflare）。

## 外掛側邊欄與自動更新

- 點瀏覽器工具列的外掛圖示會開啟側邊欄：顯示網新登入狀態（`queen_session` 是否存在、幾天後到期）、常用工具連結，以及「版本更新」。
- 外掛每小時自動向 GitHub 檢查一次，有新版時圖示會顯示紅色「新」；也可以在側邊欄按「檢查更新」。
- 按「更新到最新版」時，第一次會要求選擇外掛所在的資料夾（`extension/`，只需選一次），之後會自動下載、驗證並寫入有變動的檔案，再重新載入外掛。只同步 repo 的 `extension/` 資料夾，其他檔案不受影響。
- **v0.2.0（含）以前的版本沒有更新功能**，需要手動把 `extension/` 資料夾整個換成新版一次（重新載入外掛）；之後就能自動更新。
- 維護規則：只要 `extension/` 內有任何變動，就要同步調高 `manifest.json` 的 `version`，並在 `changelog.json` 加一筆對應版本的說明。

## 部署

`main` 有推送時，`.github/workflows/pages.yml` 會把 `web/` 發布到 GitHub Pages（不跑測試）。第一次需要到 repo 的 Settings → Pages，把 Source 設成「GitHub Actions」。

## 圖床（Cloudflare Worker＋R2）部署

網頁在瀏覽器內產生 1080×1080 的 JPEG／PNG，上傳到這個圖床取得公開、無法猜到的網址，再把網址當作 `image_url` 交給後端抓取。圖片 3 天後自動失效。程式在 `worker/index.js`（單一檔案，無相依套件），測試用 `npm test`（只需要 Node 22，不必安裝任何套件）。

端點：`POST /login`（密碼換 12 小時憑證）、`POST /upload`（`Authorization: Bearer 憑證`，內容為圖片原始位元組，檢查檔頭與大小）、`GET /i/<key>`（公開讀取，過期即刪除並回 404）。

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
   | `APP_PASSWORD` | Secret | 網頁登入密碼（建議 12 字元以上，自己決定） |
   | `SESSION_SECRET` | Secret | 隨機 32 字元以上（產生方式見下） |
   | `ALLOWED_ORIGIN` | Text | `https://unnn3ing-oss.github.io` |
   | `MAX_AGE_DAYS` | Text（選用） | `3`（預設就是 3） |
   | `MAX_BYTES` | Text（選用） | 預設 8388608（8 MB） |

   產生 `SESSION_SECRET`：在任一網頁的 Console 執行 `crypto.randomUUID()+crypto.randomUUID()`，複製結果（不含引號）。

   選用的 `LOGIN_LIMITER`（Rate Limiting 綁定）有綁定才會啟用，登入以 IP、上傳以憑證為 key；免費方案是否可用、能否在儀表板設定都**未查證**。
5. **自我檢查**：開啟 `https://snn-images.19jpz-3.workers.dev/i/00000000000000000000000000000000.jpg`，應看到 404 的 JSON（`{"ok":false,"code":"not_found",…}`），代表 Worker 已部署。

   進一步可用 `curl` 試登入（把密碼換成自己的）：

   ```bash
   curl -s -X POST https://snn-images.19jpz-3.workers.dev/login -H 'Content-Type: text/plain' -d '{"password":"你的登入密碼"}'
   # 預期：{"ok":true,"data":{"session":"…","exp":…,"ttl":43200}}
   ```

   回 `misconfigured`（HTTP 500）代表 Secret、綁定或名稱有漏設或打錯。

   **登入時出現「Worker 尚未設定完成。」**：到 [Worker 設定](https://dash.cloudflare.com/?to=/:account/workers/services/view/snn-images/production/settings) → Variables and Secrets 檢查：
   - `APP_PASSWORD`（至少 8 字元）與 `SESSION_SECRET`（至少 32 字元）兩個都在，名稱大小寫、底線完全一致。
   - `SESSION_SECRET` 複製時沒有連引號一起貼上。
   - 設在 `snn-images` 這個 Worker；儲存後若出現 Deploy 按鈕要按。
   - 登入成功但上傳仍出現同一句：Bindings 要有 R2 bucket，變數名稱為 `IMAGES`。

### 注意

- 圖片 3 天後失效，所以網頁只允許排程在 3 天內的貼文；排程時間超過 3 天的，後端抓圖時圖片已不存在。
- 已發布的 FB 貼文不受影響：FB 抓圖後有自己的副本，圖床刪除圖片不會讓已發布的貼文失去圖片（這點依 Facebook 一般行為判斷，**未查證**）。
- 換登入密碼：只改 `APP_PASSWORD`。要讓所有人立刻登出：更換 `SESSION_SECRET`。`worker/index.js` 改版後，重新貼上並 Deploy。
