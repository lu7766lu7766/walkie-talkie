import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [
    cloudflare({
      // Workers AI（語音轉文字）只能連到 Cloudflare 執行，需要登入。
      // 預設關閉，讓本機開發與 CI 不用登入也能跑（沒有 AI 時不產生通話文字，或用 .dev.vars 設 TRANSCRIBE_FAKE=1 測試）；
      // 已執行 `npx wrangler login` 想在本機用真的 AI，設 CLOUDFLARE_REMOTE_BINDINGS=1。
      remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS === '1',
    }),
  ],
});
