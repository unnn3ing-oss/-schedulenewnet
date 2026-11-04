# FB 粉專 Graph API 權限交接

> 用途：網新快速排程之後改成**直接串 Facebook Graph API**（不經網新後台），開放部門多人使用。
> 需求功能：純文字貼文、圖文貼文、純文字圖（底色卡）、排程、**發文後自動留言帶連結**、**自動隱藏廣告機器人留言**。
> 本文件列出要申請的 Token、權限與設定，讓工程師可以直接照做。

---

## 0. 一句話總結

用 **Business Manager 的「系統使用者（System User）」** 產生長效 Token，再用它換出各粉專的 **Page Access Token**。Token 只放在後端（Cloudflare Worker Secret），前端不碰 Token。

---

## 1. 要準備的帳號與資產

| 項目 | 說明 | 由誰提供 |
|---|---|---|
| Meta Business Manager（企業管理平台） | 粉專必須歸在這個 BM 底下 | 公司 BM 管理員 |
| Meta App（類型選「商家 Business」） | **App 要歸屬在同一個 BM**，這樣用 Standard Access 就能存取自家粉專，通常不需要送 App Review | 工程師建立，BM 管理員認領 |
| 系統使用者（System User） | 在 BM →「使用者 → 系統使用者」建立，角色選「員工」即可 | BM 管理員 |
| 粉專清單 | 每個要發文的粉專名稱＋Page ID | 社群小編 |
| 商家驗證（Business Verification） | Meta 有時會要求完成才能產生特定權限的 Token；先確認 BM 是否已驗證 | BM 管理員 |

---

## 2. 要取得的 Token

| Token | 怎麼取得 | 效期 | 用途 |
|---|---|---|---|
| **System User Access Token** | BM → 系統使用者 → 「產生新的權杖」→ 選 App、勾選第 3 節的權限、效期選「永不過期」 | 永不過期（撤銷、移除權限或刪除系統使用者時失效） | 後端拿來換 Page Token |
| **Page Access Token**（每個粉專各一個） | `GET /me/accounts?fields=id,name,access_token`，或 `GET /{page-id}?fields=access_token`（用上面的 System User Token 呼叫） | 從永久 Token 換出來的也是永久 | **發文、留言、隱藏留言都要用這個**，貼文和留言才會以粉專身分出現 |
| **App Secret** | App 後台 → 設定 → 基本資料 | 不會過期（可重設） | 驗證 Webhook 簽章（`X-Hub-Signature-256`）；呼叫時可加 `appsecret_proof` |
| **Webhook Verify Token** | 自己定義的一組隨機字串 | — | Webhook 設定時 Meta 回呼驗證用 |

> 檢查方式：把 Token 貼到 Meta 的 **Access Token Debugger**（存取權杖偵錯工具），確認「Scopes」與「Expires: Never」。

---

## 3. App 權限（產生 System User Token 時要勾選）

| 權限 | 必要性 | 用途 |
|---|---|---|
| `pages_show_list` | 必要 | 列出系統使用者可管理的粉專、取得 Page Token |
| `pages_read_engagement` | 必要 | 讀粉專內容與貼文資訊；發文權限的前置需求 |
| `pages_manage_posts` | 必要 | 發文、排程、編輯、刪除貼文（純文字／圖文／純文字圖） |
| `pages_manage_engagement` | 必要 | **以粉專身分留言**、**隱藏／刪除留言** |
| `pages_read_user_content` | 必要 | 讀取使用者留言內容（判斷是否為機器人） |
| `pages_manage_metadata` | 必要（要做即時隱藏才需要） | 讓 App 訂閱粉專 Webhook（`feed` 欄位，收新留言事件） |
| `business_management` | 視情況 | 粉專屬於 BM 時，部分呼叫會要求；建議一起勾 |
| `read_insights` | 選用 | 之後想在介面顯示成效數據再加 |

---

## 4. 系統使用者的粉專任務（BM → 系統使用者 → 指派資產 → 粉專）

| 任務（API 名稱） | 要不要開 | 對應功能 |
|---|---|---|
| 內容 `CREATE_CONTENT` | ✅ | 發文、排程 |
| 社群活動 `MODERATE` | ✅ | 留言、隱藏留言 |
| 洞察報告 `ANALYZE` | 選用 | 成效數據 |
| 訊息 `MESSAGING`、廣告 `ADVERTISE`、完整控制 `MANAGE` | ❌ 不需要 | 最小權限原則，不要開 |

> **每個粉專都要各自指派**，漏指派的粉專在 `/me/accounts` 不會出現。

---

## 5. 功能和 API 對照

| 功能 | 端點 | 主要參數 |
|---|---|---|
| 純文字貼文 | `POST /{page-id}/feed` | `message` |
| 文字＋連結預覽 | `POST /{page-id}/feed` | `message`、`link` |
| 圖文貼文 | `POST /{page-id}/photos` | `url`（公開圖片網址，可用現有圖床 Worker）、`caption` |
| 純文字圖（底色卡） | `POST /{page-id}/photos` | 同上；**底色卡圖片要自己產**（現在是網新後台 `render_text_card` 產的，獨立後要在前端或 Worker 產圖） |
| 排程 | 以上端點加 `published=false`、`scheduled_publish_time`（Unix 秒） | 時間須在 10 分鐘～75 天之後（以 Meta 文件為準） |
| 自動留言帶連結 | `POST /{post-id}/comments` | `message`（含文章網址）；**用 Page Token** |
| 讀留言 | `GET /{post-id}/comments` | `fields=id,message,from,created_time` |
| 隱藏留言 | `POST /{comment-id}` | `is_hidden=true` |
| 訂閱 Webhook | `POST /{page-id}/subscribed_apps` | `subscribed_fields=feed` |

---

## 6. 實作注意事項

1. **排程貼文沒辦法預約留言**：要等貼文真的發出、拿到 `post-id` 後才能留言。可選做法：
   - Webhook `feed` 收到「粉專自己發文」事件 → 立刻留言（較即時）。
   - 或 Worker Cron Trigger 每分鐘檢查到點的排程貼文 → 留言。
2. **隱藏機器人留言流程**：Webhook `feed`（新留言）→ Worker 判斷（關鍵字、短網址、外部連結、AI 判斷等）→ `POST /{comment-id}?is_hidden=true`。建議先記 log、人工確認一陣子，再改成全自動。
3. **粉專內建審核可以先開**：粉專設定的「關鍵字封鎖」「不雅用語過濾」不用開發，可以和 API 判斷並用。
4. **Token 只放後端**：存在 Cloudflare Worker Secret，前端只打 Worker，不可把 Token 放進網頁或外掛。
5. **部門多人使用的身分驗證**：FB 那端只有一個系統使用者，所以「誰發的」要由我們自己的系統記錄（例如沿用圖床的登入機制，另外記操作者名稱）。
6. **固定 Graph API 版本號**：URL 寫死版本（`/vXX.0/`），Meta 每個版本約支援兩年，到期前要升級。
7. **流量限制**：Page Token 有每粉專的呼叫上限（依粉專互動量計算），Webhook 大量留言時要注意，回應標頭 `X-Business-Use-Case-Usage` 可監看用量。

---

## 7. Worker 要新增的 Secret（建議名稱）

| 名稱 | 內容 |
|---|---|
| `FB_SYSTEM_USER_TOKEN` | 系統使用者 Token |
| `FB_APP_ID` | App ID |
| `FB_APP_SECRET` | App Secret |
| `FB_WEBHOOK_VERIFY_TOKEN` | 自訂的 Webhook 驗證字串 |
| `FB_PAGE_IDS` | 允許發文的粉專 ID（白名單，逗號分隔） |

---

## 8. 交接檢查清單

- [ ] BM 管理員確認：粉專都在同一個 BM、BM 是否已完成商家驗證
- [ ] 工程師建立 Meta App（商家類型），並由 BM 認領
- [ ] BM 管理員建立系統使用者，指派 App 與每個粉專（任務：內容＋社群活動）
- [ ] 產生 System User Token，勾選第 3 節權限，效期「永不過期」
- [ ] 用 Access Token Debugger 確認權限範圍與效期
- [ ] 用 System User Token 換出每個粉專的 Page Token，測試發一篇「只限自己」或排程後刪除的測試貼文
- [ ] 設定 Webhook（Callback URL 指向 Worker、Verify Token、訂閱 `feed`）
- [ ] 所有 Token／Secret 存入 Worker Secret，前端程式碼不含任何 Token
