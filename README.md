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

## 外掛側邊欄與自動更新

- 點瀏覽器工具列的外掛圖示會開啟側邊欄：顯示網新登入狀態（`queen_session` 是否存在、幾天後到期）、常用工具連結，以及「版本更新」。
- 外掛每小時自動向 GitHub 檢查一次，有新版時圖示會顯示紅色「新」；也可以在側邊欄按「檢查更新」。
- 按「更新到最新版」時，第一次會要求選擇外掛所在的資料夾（`extension/`，只需選一次），之後會自動下載、驗證並寫入有變動的檔案，再重新載入外掛。只同步 repo 的 `extension/` 資料夾，其他檔案不受影響。
- **v0.2.0（含）以前的版本沒有更新功能**，需要手動把 `extension/` 資料夾整個換成新版一次（重新載入外掛）；之後就能自動更新。
- 維護規則：只要 `extension/` 內有任何變動，就要同步調高 `manifest.json` 的 `version`，並在 `changelog.json` 加一筆對應版本的說明。

## 部署

`main` 有推送時，`.github/workflows/pages.yml` 會把 `web/` 發布到 GitHub Pages（不跑測試）。第一次需要到 repo 的 Settings → Pages，把 Source 設成「GitHub Actions」。
