// Service worker — нужен, чтобы телефон предложил "Установить приложение".
// Стратегия "сначала сеть": всегда берём свежие файлы сайта,
// а сохранённую копию показываем только если нет интернета.
// Запросы к Firebase (брони) не трогаем — они идут напрямую.
const CACHE = 'bobur-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // Всегда сверяемся с сервером (no-cache), чтобы не застрять на старой версии.
    // Новый запрос по адресу — так работает и для открытия страницы (navigate).
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req))
  );
});
