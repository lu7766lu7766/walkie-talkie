# 📻 對講機 Walkie-Talkie

用瀏覽器開啟就能使用的即時對講機，可安裝成 App（PWA）。按住說話，聲音即時傳給同頻道的每個人。

- **按住說話**：螢幕大按鈕、鍵盤（預設空白鍵），或「模擬鍵盤」的藍牙 PTT 按鈕
- **耳機／藍牙耳機按鍵**：按一下播放鍵開始、再按一下結束（限制說明見下方）
- **同一時間只有一人能說話**（半雙工），跟真的對講機一樣；別人在講時按下會聽到忙線音
- 開始／結束提示音（roger beep）、說話者顯示、成員列表、斷線自動重連
- 頻道密碼：同頻道名稱加同密碼才會進到同一個頻道，不用註冊帳號
- **背景執行與播放**：切到其他 App 或鎖屏後繼續收聽；鎖定畫面／通知列顯示誰正在說話
- PWA：可加入主畫面、全螢幕執行、離線也能開啟 App 外殼

---

## 架構與技術選型

```
┌──────────── 瀏覽器／PWA ────────────┐            ┌──────── Cloudflare ────────┐
│ 麥克風 → AudioWorklet               │            │ Worker（靜態網頁 + API）    │
│   → 降頻 16 kHz → μ-law 編碼        │  WebSocket │   /api/channel/:id/ws       │
│   → 每 40 ms 一個語音框 ────────────┼──────────► │      │                      │
│                                     │            │      ▼                      │
│ 收到的語音框 → 抖動緩衝 → 喇叭      │ ◄──────────┼─ Durable Object（一頻道一個）│
│                                     │            │   ・成員名單                │
│ 發話鍵：螢幕／鍵盤／耳機            │            │   ・發話權（一次一人）      │
└─────────────────────────────────────┘            │   ・語音框轉發給其他成員    │
                                                   └─────────────────────────────┘
```

| 部分 | 技術 | 原因 |
| --- | --- | --- |
| 前端 | Vite + TypeScript（無框架） | 介面只有兩頁，不用框架，bundle 只有約 6 KB gzip |
| 音訊擷取 | AudioWorklet | 在音訊執行緒上即時處理，延遲最低，所有主流瀏覽器都支援 |
| 語音編碼 | G.711 μ-law，16 kHz 單聲道（128 kbps） | 零相依、幾行程式就能實作、所有瀏覽器都能解碼；音質就是清楚的對講機音質 |
| 傳輸 | WebSocket | 穿透各種 NAT／防火牆／公司網路都沒問題，不需要 TURN 伺服器 |
| 後端 | Cloudflare Workers + Durable Objects | 見下一節 |
| 部署 | Cloudflare Workers（前後端一起） | 一次部署、同網域、不用設定 CORS |

### 為什麼需要後端？純前端不行嗎？

不行。瀏覽器之間要互相找到對方，至少需要一個「信令伺服器」交換連線資訊，純靜態網站（例如只放 Vercel）做不到。
即使改用 WebRTC 點對點，一個人說話時也要把聲音同時上傳給頻道裡**每一個人**（mesh），人一多，手機上傳頻寬和電量就撐不住。

對講機的特性是「同一時間只有一個人說話、其他人都在聽」，最適合的做法是「伺服器轉發」：說話者只上傳一份，伺服器複製給所有人。

### 為什麼選 Cloudflare 而不是 Vercel？

Vercel 的 Serverless Functions 不支援長時間的 WebSocket 連線，而 Cloudflare **Durable Objects** 正好適合這種情境：

- 每個頻道對應一個 Durable Object，天生就是「這個頻道的唯一協調者」，處理發話權不會有競爭問題
- 使用 **WebSocket Hibernation**：沒人說話時 DO 會休眠，不計執行時間；心跳 ping/pong 由平台自動回覆，不會喚醒它
- 全球邊緣節點，DO 會建在第一個進入頻道的人附近
- SQLite 型 Durable Object 在 **Workers 免費方案**就能使用

**結論：Cloudflare 完全夠用，前後端都放在同一個 Worker。**
如果還是想把前端放 Vercel，也可以：建置時設定 `VITE_API_ORIGIN=https://你的-worker.workers.dev`，前端就會連到 Cloudflare 上的後端。

### 免費額度大概能用多少？

（數字以 Cloudflare 官方定價頁為準，以下為估算）

- 每個說話中的人每秒送出 25 個語音框；DO 的 WebSocket 收到的訊息以 20:1 計為請求數
- 免費方案每天 100,000 次 DO 請求 ≈ 200 萬個語音框 ≈ **每天約 22 小時的累計發話時間**
- 聽的人不影響請求數（伺服器送出的訊息不計費）；頻寬方面每個收聽者約 128 kbps

小團隊日常使用免費方案綽綽有餘；量大時升級 Workers Paid（每月 5 美元起）。

---

## 耳機／藍牙按鍵：能做到什麼、做不到什麼

| 裝置 | 運作方式 | 支援「按住」？ |
| --- | --- | --- |
| 螢幕按鈕 | Pointer Events | ✅ 按住說話、放開結束 |
| 鍵盤 | keydown／keyup（可在設定中重新綁定任意鍵） | ✅ |
| **藍牙 PTT 按鈕**（市售對講機用的那種，多半模擬成鍵盤） | 同鍵盤，在設定中按「重新綁定」再按一下 PTT 按鈕即可 | ✅ |
| 有線耳機線控、藍牙耳機的播放／暫停鍵 | Media Session API | ⚠️ 只有「按一下」，**按一下開始、再按一下結束** |

說明：

- 瀏覽器對耳機按鍵只會收到「播放／暫停」這種單次事件，**拿不到「按下」和「放開」**，所以耳機一律是切換模式。這是網頁平台的限制，原生 App 才能做到真正按住。
- 瀏覽器只會把媒體鍵交給「正在播放媒體」的網頁，所以 App 進入頻道後會循環播放一段無聲音訊來佔住媒體控制。
- 麥克風啟用時，藍牙耳機會切換到通話模式（HFP）。部分手機在這個模式下會把耳機按鍵當成「接聽／掛斷」而不是「播放／暫停」，這時按鍵可能沒反應，依手機與耳機型號而異。**最穩定的方案是買一顆藍牙 PTT 按鈕（HID 鍵盤型）**。

---

## 背景執行與播放

行動瀏覽器會暫停「沒在播放媒體」的背景網頁，所以這裡的做法是**讓系統把對講機當成音樂 App**：

1. 收到的聲音不直接送到喇叭，而是經由 `MediaStreamAudioDestinationNode` 導進一個持續播放的 `<audio>` 元素。系統看到「正在播放媒體」，切到背景或鎖屏時就不會暫停網頁，WebSocket 與 AudioContext 都持續運作
2. 用 Media Session API 在鎖定畫面／通知列顯示「🔊 小明 正在說話」、頻道名稱與人數
3. 心跳改成「ping 送出後 10 秒沒回應才算斷線」，不再依賴計時器準時（背景分頁的計時器會被延後到最慢一分鐘一次，舊做法會在背景誤判斷線）
4. 回到前景時自動：喚醒被系統暫停的 AudioContext、重新取得被 iOS 關掉的麥克風、恢復耳機按鍵、重新保持螢幕常亮

設定裡可以分別開關「背景播放」與「保持螢幕常亮」。若某支手機在背景播放模式下聲音異常，關掉「背景播放」即恢復成直接輸出到喇叭。

| 平台 | 背景／鎖屏收聽 | 背景／鎖屏發話 |
| --- | --- | --- |
| Android Chrome／已安裝的 PWA | ✅ | ✅ 用耳機播放鍵或藍牙 PTT 按鈕（麥克風在背景持續運作，通知列會顯示使用中） |
| iPhone Safari／已安裝的 PWA | ⚠️ 視 iOS 版本，系統可能在一段時間後暫停 | ❌ iOS 在背景一律關閉網頁的麥克風 |
| 桌面瀏覽器 | ✅（最小化視窗也可以） | ✅ 視窗在前景時可用鍵盤 |

iPhone 預設開啟「保持螢幕常亮」，需要長時間值勤時這是最穩定的用法。要在 iPhone 上做到鎖屏收聽與發話，只能包成原生 App（見後續規劃）。

---

## 開發

需要 Node.js 20 以上。

```bash
npm install
```

```bash
npm run dev
```

開啟 <http://localhost:5173>。`npm run dev` 透過 `@cloudflare/vite-plugin` 在本機 workerd 執行 Worker 與 Durable Object，前後端一起熱更新。
可以開兩個瀏覽器分頁進同一個頻道測試。手機測試需要 HTTPS（麥克風權限的要求），可用 `npx cloudflared tunnel --url http://localhost:5173` 暫時對外開放。

其他指令：

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run preview
```

## 部署到 Cloudflare

1. 註冊 Cloudflare 帳號（免費方案即可）
2. 登入：

   ```bash
   npx wrangler login
   ```

3. 建置並部署：

   ```bash
   npm run deploy
   ```

完成後會得到 `https://walkie-talkie.<你的子網域>.workers.dev`。要用自己的網域，在 Cloudflare 後台 Worker → Settings → Domains & Routes 加上即可。

也可以在 Cloudflare 後台 Workers & Pages → Create → Import a repository 連結這個 GitHub repo，Build command 填 `npm run build`、Deploy command 填 `npx wrangler deploy`，之後每次 push 就會自動部署。

## 圖示

`public/icons/` 下的圖示由 `scripts/icons.mjs` 從 SVG 產生（需要 Playwright）。要換成自己的圖，直接把同名 PNG 放進 `public/icons/` 覆蓋即可：

| 檔案 | 尺寸 | 用途 |
| --- | --- | --- |
| `icon.svg` | 向量 | 網頁 favicon |
| `icon-192.png`、`icon-512.png` | 192、512 | Android／桌面安裝圖示（四角透明的圓角圖） |
| `maskable-512.png` | 512 | Android 自適應圖示（滿版背景，內容在中間 80% 安全區內） |
| `apple-touch-icon.png` | 180 | iOS 加入主畫面（滿版，iOS 自己會切圓角） |

---

## 專案結構

```
src/
  shared/protocol.ts       前後端共用的訊息格式與常數
  shared/mulaw.ts          μ-law 編解碼
  worker/index.ts          Worker 路由 + Channel Durable Object（成員、發話權、轉發）
  client/main.ts           頁面邏輯、發話狀態機
  client/audio-engine.ts   麥克風、播放排程（抖動緩衝）、提示音
  client/capture.worklet.ts  音訊執行緒：降頻 + 編碼
  client/connection.ts     自動重連的 WebSocket
  client/ptt-inputs.ts     螢幕／鍵盤／耳機三種發話鍵
  client/room-id.ts        頻道名稱 + 密碼 → 頻道 id（SHA-256）
  client/pwa.ts            Service Worker 註冊、安裝按鈕
public/
  manifest.webmanifest、sw.js、icons/
```

### 發話流程

1. 按下發話鍵 → 立刻開始錄音（先存在本地），同時向伺服器要發話權
2. 伺服器同意 → 把剛剛先錄的部分一起補送，接著即時串流；**第一個字不會被吃掉**
3. 伺服器拒絕（別人正在講）→ 丟棄錄音，播放忙線音
4. 放開 → 等最後半個語音框送完，再釋放發話權，其他人聽到 roger beep
5. 單次發話上限 60 秒；若某人斷線卡住發話權超過 65 秒，下一個人按下時會強制收回

### 安全性

- 伺服器只看得到「頻道名稱 + 密碼」的 SHA-256 雜湊，看不到頻道名稱與密碼本身
- 這是「知道密碼就能進入」的模式，**沒有帳號驗證**。語音在傳輸中有 TLS 加密，但會經過 Cloudflare 伺服器轉發（不是端對端加密）

---

## 後續規劃（建議優先順序）

1. **Opus 編碼**：用 WebCodecs `AudioEncoder` 改成 Opus（約 24 kbps），頻寬省 80%，音質更好；不支援的瀏覽器自動退回 μ-law
2. **原生 App 外殼（Capacitor）**：iPhone 鎖屏收聽與發話（背景音訊模式）、真正的藍牙耳機「按住」
3. **Web Push 通知**：App 完全關閉時，有人在頻道說話就推播通知（iOS 16.4 以上已安裝的 PWA 也支援），點一下回到頻道
4. **帳號與頻道管理**：登入（Cloudflare Access 或 OAuth）、頻道成員白名單、管理員踢人
5. **多頻道監聽**：同時聽多個頻道，類似對講機的掃描功能
6. **錄音回放**：把每段發話存到 R2，錯過的訊息可以回放
7. **改用 WebRTC SFU**（Cloudflare Realtime）：如果需要更低延遲（< 150 ms）或上百人的大頻道
