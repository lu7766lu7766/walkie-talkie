# 部署到 Cloudflare

整個對講機（前端網頁 + 後端 WebSocket 轉發）是**一個 Cloudflare Worker**，Workers 免費方案就能使用。
設定都在 `wrangler.jsonc`，以下三種方式擇一即可。

## 事前準備

1. 註冊 [Cloudflare](https://dash.cloudflare.com/sign-up) 帳號（免費）
2. 第一次使用 Workers 時，後台會要你選一個 `workers.dev` 子網域，例如 `my-team` → 網址會是 `https://walkie-talkie.my-team.workers.dev`

## 方式一：從自己電腦部署（最快）

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npm run deploy
```

完成後終端機會顯示網址。之後改了程式碼，再執行一次 `npm run deploy` 即可。

## 方式二：Cloudflare 後台連結 GitHub（推薦，不用設定金鑰）

1. Cloudflare 後台 → **Workers & Pages** → **Create** → **Import a repository**
2. 授權 GitHub，選這個 repo
3. 設定：
   - Project name：`walkie-talkie`（要跟 `wrangler.jsonc` 的 `name` 一樣）
   - Build command：`npm run build`
   - Deploy command：`npx wrangler deploy`
   - Production branch：`main`
4. 按 **Deploy**

之後每次 push 到 `main` 就會自動部署；推到其他分支會產生預覽網址。

## 方式三：GitHub Actions（repo 已附設定檔）

`.github/workflows/deploy.yml` 會在 `main` 有新 commit 時自動檢查、建置並部署。只需要設定兩個 secret：

1. **建立 API Token**：Cloudflare 後台右上角頭像 → **My Profile** → **API Tokens** → **Create Token**
   → 選 **Edit Cloudflare Workers** 範本 → Account Resources 選你的帳號、Zone Resources 選 All zones（或你的網域）→ 建立後複製 token
2. **找 Account ID**：後台 **Workers & Pages** 頁面右側欄
3. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，新增：
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. 到 repo 的 **Actions** 頁面手動執行一次 **Deploy to Cloudflare**，或 push 到 `main`

`.github/workflows/ci.yml` 則會在每個 PR 跑型別檢查、測試、建置與 `wrangler deploy --dry-run`，不需要任何金鑰。

> 方式二和方式三擇一就好，兩個都開會重複部署。

## 綁定自己的網域

網域需要先加入 Cloudflare（DNS 由 Cloudflare 代管）。

- **後台設定**：Workers & Pages → walkie-talkie → **Settings** → **Domains & Routes** → **Add** → **Custom domain**，輸入例如 `talk.example.com`
- **或寫在設定檔**：在 `wrangler.jsonc` 取消註解並修改

  ```jsonc
  "routes": [{ "pattern": "talk.example.com", "custom_domain": true }],
  ```

  然後重新部署。綁好之後可以把 `"workers_dev"` 改成 `false`，只留自己的網域。

Cloudflare 會自動簽發 HTTPS 憑證（麥克風權限一定要 HTTPS）。

## 前端放 Vercel、後端放 Cloudflare（選用）

如果想把網頁放在 Vercel：

1. 照上面部署 Worker，記下網址，例如 `https://walkie-talkie.my-team.workers.dev`
2. Vercel 專案設定環境變數 `VITE_API_ORIGIN=https://walkie-talkie.my-team.workers.dev`
3. Vercel Build Command：`npx vite build`、Output Directory：`dist/client`

一般情況不需要這樣做，全部放 Cloudflare 最簡單。

## 部署後檢查

- `https://你的網址/api/health` 應該回傳 `{"ok":true}`
- 用手機開網址 → 建立房間 → 用另一支手機開分享連結，互相講話測試
- 後台 Workers & Pages → walkie-talkie → **Logs** 可以即時看錯誤紀錄（`wrangler.jsonc` 已開啟 observability）

## 費用

Workers 免費方案（每天 10 萬次請求、Durable Objects 每天 10 萬次請求）對小團隊綽綽有餘：
WebSocket 收到的訊息以 20:1 計費，一個人說話每秒 25 個語音框，估計每天約可累計 22 小時的發話時間。
用量大時升級 Workers Paid（每月 5 美元起）。實際數字以 [Cloudflare 官方定價](https://developers.cloudflare.com/workers/platform/pricing/) 為準。

**通話文字（Workers AI）**：`wrangler.jsonc` 已設定 `"ai": { "binding": "AI" }`，部署後自動可用，不需要另外開通。
語音轉文字（Whisper）與校正（Qwen）會使用 Workers AI 額度，免費方案每天有固定免費額度，超過後當天不會再產生通話文字（通話本身不受影響）。
用量在後台 **AI** → **Workers AI** 查看，價格見 [Workers AI 定價](https://developers.cloudflare.com/workers-ai/platform/pricing/)。不想使用就把 `wrangler.jsonc` 的 `"ai"` 那行拿掉再部署。

## 常見問題

- **部署時出現 Durable Object migration 錯誤**：`wrangler.jsonc` 的 `migrations` 已部署過的項目不能修改，只能新增
- **使用者看到舊版畫面**：Service Worker 每次開啟都會檢查新版，關掉 App 再打開一次即可；`public/_headers` 已設定 `sw.js` 不快取
- **手機無法使用麥克風**：一定要用 `https://` 網址開啟
