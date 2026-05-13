/* =====================================================
   FocusFlow Service Worker
   バックグラウンド通知・オフライン対応を担う
   ===================================================== */

const CACHE_NAME = 'focusflow-v41';
// キャッシュするアセット一覧
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json'
];

/* ---- インストール時: アセットをキャッシュ ---- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

/* ---- アクティベート時: 古いキャッシュを削除 ---- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

/* ---- フェッチ時: キャッシュ優先で応答 ---- */
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});

/* ---- プッシュ通知の受信処理 ---- */
self.addEventListener('push', (event) => {
  let data = { title: 'FocusFlow', body: 'タスクの期限が近づいています！', tag: 'focusflow-push' };
  if (event.data) {
    try { data = event.data.json(); } catch (e) { data.body = event.data.text(); }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'focusflow',
      data: data,
      actions: [
        { action: 'open', title: '確認する' },
        { action: 'snooze', title: '後で' }
      ],
      vibrate: [200, 100, 200]
    })
  );
});

/* ---- 通知クリック時の処理 ---- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'snooze') {
    // 後でアクション: 1時間後に再通知（アプリ側に委譲）
    return;
  }

  // アプリを開く（すでに開いていればフォーカス）
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});

/* ---- 定期バックグラウンドチェック（Periodic Background Sync） ---- */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'task-reminder-check') {
    event.waitUntil(checkAndNotifyTasks());
  }
});

/**
 * ローカルストレージのタスクを確認して通知する
 * Service Workerではlocalstorageにアクセスできないため
 * クライアントにメッセージを送って確認を依頼する
 */
async function checkAndNotifyTasks() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length > 0) {
    clients.forEach((client) => client.postMessage({ type: 'CHECK_TASKS' }));
  }
}
