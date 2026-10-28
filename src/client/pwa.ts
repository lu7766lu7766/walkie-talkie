/** 註冊 Service Worker，並在可安裝時顯示「安裝 App」按鈕。 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function setupPwa() {
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
  }

  const button = document.getElementById('install-btn') as HTMLButtonElement;
  const iosHint = document.getElementById('ios-install-hint')!;
  const standalone =
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return;

  let deferred: BeforeInstallPromptEvent | null = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    button.hidden = true;
  });
  addEventListener('appinstalled', () => (button.hidden = true));

  // iOS Safari 沒有安裝提示事件，只能教使用者手動加入主畫面
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIos) iosHint.hidden = false;
}
