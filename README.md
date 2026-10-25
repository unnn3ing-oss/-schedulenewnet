# 網新快速排程（新介面）

網新發文台的新前端介面，沿用現有後端，只重做介面。發布於 GitHub Pages。

- 主要分支：`main`；所有改動都先開 PR，確認後才併入。

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

驗證外掛只允許呼叫 `page_meta`、`hero`、`guard/check`，**不會排程或發文**；cookie 只讀名稱與到期時間，不讀值。

## 正式介面（進行中）

`web/index.html` 是正式介面，分 PR 逐步完成。目前（PR A）可以用的：

- 頂列：外掛連線與登入剩餘天數（經外掛的 `cookies`）；沒裝外掛會顯示「未偵測到外掛」並連到上方的安裝步驟。
- 「＋ 新增發文」置中彈窗（Esc 關閉、焦點鎖定、有未存內容會先確認）：
  - **作圖框**：選照片／拖曳／Ctrl+V 貼上、滾輪與雙指縮放、拖曳平移；5 種版型（新聞／娛樂／少康／擠看看 1080×1080，國際＋ 1200×675）；7 種貼圖與馬賽克（取自 QPT `stickers.js`）。圖只含照片與貼圖，**不含標題與邊框**（後端會畫）；畫面上的標題區／logo 區是不會輸出的參考線，可用「顯示標題區」開關。`Editor.exportBlob()` 輸出 JPEG q0.92，下一個 PR 用它上傳圖床。
  - **純文字底圖**：7 種底色與文字，預覽為示意，實際以後端產圖為準。
  - **快速帶入**：貼文章網址按 Enter 或「帶入」，透過外掛呼叫 `page_meta` 填標題（換行規則與 QPT `breakTitle` 相同）、用外掛新增的 `fetchImage`（僅限 tvbs.com.tw 圖片）載入主圖。
  - 標題每行字數即時計算（全形 1、半形 0.5），超過版型上限變紅；小編文欄位。
  - 粉專按鈕、立即／排程選單與時間視窗目前只有介面，不會送出。
- 還沒做：送出、AI 產生與校錯字、守則判讀、送出紀錄（後續 PR）。

外掛升到 0.4.0（新增 `fetchImage`），舊外掛仍可用，只是帶不到主圖。測試：`npm test`；瀏覽器端到端：`node test/e2e/app.e2e.js`（需要 Playwright 與 Chromium）。

## 外掛側邊欄與自動更新

- 點瀏覽器工具列的外掛圖示會開啟側邊欄：顯示網新登入狀態（`queen_session` 是否存在、幾天後到期）、常用工具連結，以及「版本更新」。
- 外掛每小時自動向 GitHub 檢查一次，有新版時圖示會顯示紅色「新」；也可以在側邊欄按「檢查更新」。
- 按「更新到最新版」時，第一次會要求選擇外掛所在的資料夾（`extension/`，只需選一次），之後會自動下載、驗證並寫入有變動的檔案，再重新載入外掛。只同步 repo 的 `extension/` 資料夾，其他檔案不受影響。
- **v0.2.0（含）以前的版本沒有更新功能**，需要手動把 `extension/` 資料夾整個換成新版一次（重新載入外掛）；之後就能自動更新。
- 維護規則：只要 `extension/` 內有任何變動，就要同步調高 `manifest.json` 的 `version`，並在 `changelog.json` 加一筆對應版本的說明。

## 部署

`main` 有推送時，`.github/workflows/pages.yml` 會把 `web/` 發布到 GitHub Pages（不跑測試）。第一次需要到 repo 的 Settings → Pages，把 Source 設成「GitHub Actions」。

## 圖床（Cloudflare Worker＋R2）部署

網頁在瀏覽器內產生 1080×1080（或 1200×675）的 JPEG／PNG，上傳到這個圖床取得公開、無法猜到的網址，再把網址當作 `image_url` 交給後端抓取。圖片 3 天後自動失效。程式在 `worker/index.js`（單一檔案，無相依套件），測試用 `npm test`（只需要 Node 22，不必安裝任何套件）。

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

### 注意

- 圖片 3 天後失效，所以網頁只允許排程在 3 天內的貼文；排程時間超過 3 天的，後端抓圖時圖片已不存在。
- 已發布的 FB 貼文不受影響：FB 抓圖後有自己的副本，圖床刪除圖片不會讓已發布的貼文失去圖片（這點依 Facebook 一般行為判斷，**未查證**）。
- 換登入密碼：只改 `APP_PASSWORD`。要讓所有人立刻登出：更換 `SESSION_SECRET`。`worker/index.js` 改版後，重新貼上並 Deploy。
