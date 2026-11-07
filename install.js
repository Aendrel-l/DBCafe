// ============================================
// Плашка "Добавить на главный экран"
// Android (Chrome и др.): кнопка "Установить" вызывает системное окно установки.
// iPhone (Safari): системного окна нет — показываем подсказку, куда нажать.
// ============================================
(() => {
  // Service worker нужен браузеру, чтобы разрешить установку
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  const bar = document.getElementById('installBar');
  const btn = document.getElementById('installBtn');
  const hint = document.getElementById('installHint');
  const KEY = 'bobur-install-hidden-until';

  // Уже открыто как приложение — плашка не нужна
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return;

  // Пользователь закрыл плашку — не показываем 7 дней
  try { if (Date.now() < Number(localStorage.getItem(KEY) || 0)) return; } catch (e) {}

  const hide = (days) => {
    bar.hidden = true;
    try { localStorage.setItem(KEY, String(Date.now() + days * 864e5)); } catch (e) {}
  };
  document.getElementById('installClose').addEventListener('click', () => hide(7));

  // ---- Android / Chrome ----
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();          // не показываем стандартное окно сразу
    deferred = e;
    btn.hidden = false;
    bar.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    hide(outcome === 'accepted' ? 365 : 7);
  });
  window.addEventListener('appinstalled', () => hide(365));

  // ---- iPhone / iPad (Safari) ----
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) {
    hint.innerHTML = 'Нажмите <b>«Поделиться»</b> <span aria-hidden="true">⎋</span> внизу экрана, затем <b>«На экран «Домой»»</b>.';
    bar.hidden = false;
  }
})();
