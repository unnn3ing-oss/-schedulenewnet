# 網新發文台｜新介面交接文件

> 範圍：沿用現有後端（方案 A），只重做前端介面。規則照舊，**影片模式本期不做**。
> 來源：`https://digi-social-post.tvbs.ai/ip/newsnet/` 前端程式與 `/shared/queen-sdk.js`（2026-10-25 讀取）
> 設定檔：`newsnet_config.json`（粉專、UTM、版型、底色、規則都以它為準）

## 1. 範圍

| 項目 | 本期 |
|---|---|
| 純文字底圖（`text_card`） | 做 |
| 作圖框（照片＋標題，`single`） | 做 |
| 上傳影音（`video`） | **不做**（介面可隱藏此模式） |
| 粉專多選、各自排程／立即 | 做 |
| AI 守則判讀、AI 小編文（產生／校錯字） | 做 |
| RD 回填 | 後端負責，前端只送 `rd_write` 旗標 |

## 2. 前提與部署

- 認證為同源 cookie（`credentials: 'same-origin'`），前端沒有 token。
- 新介面必須和後端同網域，或走同一個反向代理，才能帶 cookie 打下列端點。
- 所有 POST 都是 `Content-Type: application/json`；非 2xx 時回應 body 為錯誤文字（可能是 JSON 字串或 HTML，需要容錯，見 §7）。

## 3. 端點（本期會用到）

| 端點 | 用途 | 備註 |
|---|---|---|
| `GET /page_meta?url=` | 帶入標題、og:image | 文章網址要 `encodeURIComponent` |
| `POST /render_text_card` | 純文字底圖預覽 → PNG blob | |
| `POST /render` | 作圖框預覽 → PNG blob | |
| `POST /ai_caption` | AI 小編文 | `mode: generate`（帶 `title`、`summary`；回 `versions[]`、`hashtags[]`、`usedArticle`、`note`）或 `proofread`（帶 `text`、`titles`），另帶 `ip: "newsnet"` |
| `POST /guard/check` | 社群守則判讀 | 見 §5 |
| `POST /schedule` | 排程 | payload 見 §4 |
| `POST /publish` | 立即發布 | 回 `message` 或 `post_url`／`post_id` |

另有 `GET /hero?url=`（SDK 的主圖抓取），與 `/page_meta` 功能重疊，擇一即可。

## 4. 送出 Payload

每個勾選的粉專**各送一次請求**。

通用欄位：

```json
{
  "ip": "newsnet",
  "mode": "text_card | single",
  "template": "newsnet_news | newsnet_ent | newsnet_shaokang | newsnet_jkk | newsnet_intl（僅 single，text_card 為空字串）",
  "image_url": "僅 single：主圖網址，否則空字串",
  "crop": "僅 single：取景框座標，否則 null",
  "line1": "", "line2": "", "title_lines": [],
  "caption": "小編文",
  "article_id": "由文章網址取出的 6–8 位數字，沒有則空字串",
  "short_title": "手動填；否則取標題第一行去空白後前 5 字",
  "rd_write": true,
  "guard": { "check_id": "", "level": "green|yellow|red", "ack": false },
  "page": "news|ent|shaokang|jkk|intl|weather",
  "link": "文章網址＋該粉專 UTM",
  "schedule": ""
}
```

- `text_card` 另加：`text`、`bg`、`text_color`、`width`、`height`（1080）、`wordmark`、`font`、`shadow`、`line_gap`、`center_on_canvas`。後四項＋`wordmark` 直接取自設定檔 `ip`／`textCard`。
- `schedule`：立即發布傳 `""`；排程傳 `"YYYY-MM-DDTHH:mm"`（無時區，沿用舊版行為）。
- `link`：沒有文章網址則為空字串；已含該粉專 UTM 就不重複附加，否則用 `?` 或 `&` 接上。
- `article_id`：沿用舊版規則，正則 `(\d{6,8})(?:[/?#]|$)`。

## 5. 守則判讀流程

1. 送出前先打 `/guard/check`，body：`{ ip, title_lines, caption, text }`（`text_card` 時 `title_lines` 為空陣列、`text` 為卡面文字）。
2. 以這份 body 的 JSON 字串當 key。判讀期間若內容被改，**燈號作廢**，要提示小編重送。
3. `red` 必須勾「我知道風險」才能送，並在 `guard.ack` 帶 `true`。
4. `yellow` 提醒後可送；`green` 直接送。
5. 判讀失敗（回傳含 `error`）視為過期，需重判。

## 6. 規則（照舊版）

1. 排程時間必須比按下「排程」當下晚至少 **20 分鐘**（不取整）。
2. 勾粉專時預填時間＝現在＋**30 分鐘**。
3. 送出前以確認視窗列出每個粉專與時間（立即或排程）。
4. 逐粉專送，失敗的台標錯，修正後再送**只重送失敗的台**。
5. 全部成功**不自動清空頁面**（網新 10/21 決定），改提示按「清空頁面」。尚有未送出或失敗時，清空前要二次確認。
6. 驗證順序與訊息：
   - `text_card`：沒有文字內容 → 請填文字內容。
   - `single`：沒有文章網址 → 請先貼文章網址；沒有照片 → 需要照片。
   - 非 `text_card`：沒有標題 → 請填標題。
7. 沒有導流網址時，留言不帶連結與追蹤碼。
8. `rd` 為空的粉專（擠看看、氣象）不寫 RD；`rd_write=false` 則整篇不寫。

## 7. 錯誤處理

舊版會把錯誤解析最多三層 JSON，取 `detail`／`message`／`error`；若是 HTML（含 `<html>`、`<!doctype`）要改顯示通用錯誤，避免整頁 HTML 跑進畫面。新介面請重做同等容錯。

## 8. 版型與文字限制

- 取景框顯示尺寸：`square` 300×300、`wide` 400×225。
- 每行字數上限（全形算 1、半形算 0.5）：新聞／娛樂／少康／擠看看 `[15,15,15]`；國際＋ `[10,16,16]`。
- 純文字底圖：字級固定、太長自動折行，字體王漢宗特黑體、陰影、行距 1.45、整張畫布置中。

## 9. 驗收清單

- [ ] 同一組輸入，在新舊介面各送一次，比對每個粉專的 payload 完全一致。
- [ ] 六個粉專的 `link` 追蹤碼正確（氣象為大寫 `Facebook`）。
- [ ] 排程少於 20 分鐘會被擋，預設時間為現在＋30 分鐘。
- [ ] 紅燈未勾「我知道風險」不能送；判讀後改字會要求重判。
- [ ] 其中一個粉專失敗時，只重送失敗的。
- [ ] 錯誤回應為 HTML 時畫面不會爆版。
- [ ] 預覽圖與實際發出的圖一致（純文字、作圖框各測一次）。
- [ ] 影片入口已隱藏，沒有殘留可點的按鈕。

## 10. 未確認事項（動工前需問原後端負責人）

這些**不是**已知事實，前端程式碼讀不到：

1. 各端點成功與失敗的完整回應格式，這份文件只有 `message`／`post_url`／`post_id` 的線索。
2. RD 實際寫入位置與時機（推論為後端寫入，因前端只傳旗標）。
3. 後端是否依 `ip`＋`page` 做權限控制，新介面換網域後 cookie 是否仍有效。
4. 伺服器端是否也驗證「20 分鐘」，還是只靠前端擋。
5. `/hub` 其他 IP 的設定，本期僅網新。
