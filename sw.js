/* «Планишка» v2 — service worker (SCREENS §1, F13; уведомления — BACKEND §B1.17, §B5.4).
   Регистрируется из App.main только при 'serviceWorker' in navigator и https.
   Запросы к API (другой origin) и version.json (no-store) не перехватываются и не кэшируются.
   VERSION держится равной App.config.VERSION — это проверяет тест core (SPEC §12). */
var VERSION = '2.0.0';
var CACHE = 'okno-shell-' + VERSION;
var CACHE_PREFIX = 'okno-shell-';
var NAV_TIMEOUT_MS = 3000;

// Оболочка — один раз под ключом './' (бандл ≈ 1,7 МБ; 'index.html' — тот же файл, второй раз не качаем).
// Переадресации со старых адресов v1 (по 1–2 КБ) — тоже: офлайн они должны вести в «Наизусть»/«Планишку»
// со своим маршрутом, а не открывать оболочку под чужим адресом (R2-146).
var PRECACHE = [
  './',
  'ics.html',
  'trener.html',
  'planer-kati.html',
  'manifest.webmanifest',
  'fonts/onest-cyrillic.woff2',
  'fonts/onest-latin.woff2',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png'
];

// Шрифты и иконки — сразу из кэша, а в фоне — обновление из сети (stale-while-revalidate): имя кэша
// между сборками не меняется, и без ревалидации новая иконка или шрифт не дошли бы до пользователя никогда (R2-87).
var STATIC_RE = /\/(?:fonts\/[^/]+\.woff2|icon\.svg|icon-(?:maskable-)?\d+\.png|apple-touch-icon\.png)$/;

function noop() {}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // По одному: отсутствие необязательного файла не должно срывать установку.
      return Promise.all(PRECACHE.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(noop);
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE ? caches.delete(key) : null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

// Адрес самой оболочки: каталог приложения или его index.html. Только для них запасной ответ — оболочка;
// test.html, styleguide.html и прочие страницы под ней не подменяются (R2-146).
function isShellPath(url) {
  var scope = new URL(self.registration.scope).pathname;
  if (url.pathname.indexOf(scope) !== 0) return false;
  var rest = url.pathname.slice(scope.length);
  return rest === '' || rest === 'index.html';
}

function fromCache(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request, { ignoreSearch: true });
  });
}

// Возвращает Promise — его ждёт event.waitUntil, чтобы браузер не остановил worker посреди записи.
function putInCache(key, response) {
  if (!response || !response.ok || response.type !== 'basic') return Promise.resolve();
  var copy = response.clone();
  return caches.open(CACHE).then(function (cache) { return cache.put(key, copy); }).catch(noop);
}

// Ответ сервера пригоден для показа: 2xx или переадресация навигации. 404/5xx хостинга (деплой, сбой
// GitHub Pages / Object Storage) — такой же отказ сети, как обрыв: при нём открывается кэш (R2-86).
function usable(res) {
  return !!res && (res.ok || res.type === 'opaqueredirect');
}

// '…/index.html' и '…/' — одна страница: в кэше она лежит под ключом каталога.
function pageKey(url) {
  return url.origin + url.pathname.replace(/\/index\.html$/, '/');
}

// Навигации: сеть с таймаутом 3000 мс; при ошибке, ответе 4xx/5xx или таймауте — кэш: сама страница,
// а для адреса оболочки — оболочка. Обновление кэша из сети живёт в event.waitUntil: после ответа из кэша
// браузер не остановит worker, пока бандл не докачается и не запишется (R2-87).
function navigate(event) {
  var request = event.request;
  var url = new URL(request.url);
  var key = pageKey(url);
  var network = fetch(request);
  var good = network.then(function (res) {
    if (usable(res)) return res;
    throw new Error('HTTP ' + res.status);
  });

  event.waitUntil(good.then(function (res) { return putInCache(key, res); }, noop));

  var timeout = new Promise(function (resolve, reject) {
    setTimeout(function () { reject(new Error('timeout')); }, NAV_TIMEOUT_MS);
  });

  return Promise.race([good, timeout]).catch(function () {
    return fromCache(key).then(function (hit) {
      return hit || (isShellPath(url) ? fromCache(scopeUrl('./')) : null);
    }).then(function (hit) {
      // В кэше ничего нет — ждём сеть дальше (и показываем её ответ как есть), а не отдаём ошибку раньше времени.
      return hit || network;
    });
  });
}

function staleWhileRevalidate(event) {
  var request = event.request;
  var network = fetch(request);
  var update = network.then(function (res) { return putInCache(request, res); }, noop);
  event.waitUntil(update);
  return fromCache(request).then(function (hit) {
    return hit || network;
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate(event));
    return;
  }
  if (STATIC_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});

// ── Уведомления (BACKEND §B1.12, §B1.17, §B5.4; decisions «PWA: service worker…») ──
// Payload — декларативный Web Push: {web_push: 8030, app_badge?, mutable: false, notification: {title, body,
// navigate, tag, lang, app_badge?, mutable}}. Safari с декларативным push показывает его сам; здесь — все
// остальные браузеры. Тихих пушей нет: каждый push показывает уведомление, при ошибке — запасной заголовок.
var PUSH_FALLBACK_TITLE = 'Планишка: напоминание';
var PUSH_TITLE_MAX = 120;
var PUSH_BODY_MAX = 200;
var PUSH_TAG_MAX = 80;
var OPEN_MESSAGE = 'okno:open';

function pushData(event) {
  try {
    var data = event && event.data ? event.data.json() : null;
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// Адрес для перехода: только внутри своей области (scope), иначе — сама область (§B1.17 п.1).
function targetUrl(raw) {
  var scope = self.registration.scope;
  if (typeof raw === 'string' && raw) {
    try {
      var href = new URL(raw, scope).href;
      if (href.indexOf(scope) === 0) return href;
    } catch (e) { /* неверный адрес — область */ }
  }
  return scope;
}

// Число на значке: целое 0..99 (§B1.9 п.1). Поле может стоять на обоих уровнях payload; нет поля — значок не трогаем.
function badgeOf(data) {
  var n = data && data.notification && typeof data.notification === 'object' ? data.notification : null;
  var v = n && typeof n.app_badge === 'number' ? n.app_badge : (data && typeof data.app_badge === 'number' ? data.app_badge : null);
  if (v === null || !isFinite(v) || v < 0) return null;
  return Math.min(99, Math.floor(v));
}

function setBadge(count) {
  var nav = self.navigator;
  if (count === null || !nav) return Promise.resolve();
  try {
    if (count === 0 && typeof nav.clearAppBadge === 'function') return Promise.resolve(nav.clearAppBadge()).catch(noop);
    if (typeof nav.setAppBadge === 'function') return Promise.resolve(nav.setAppBadge(count)).catch(noop);
  } catch (e) { /* значки не поддерживаются */ }
  return Promise.resolve();
}

function fallbackNotification() {
  return self.registration.showNotification(PUSH_FALLBACK_TITLE, {
    lang: 'ru',
    icon: 'icon-192.png',
    data: { url: self.registration.scope }
  });
}

function showPush(data) {
  var n = data && data.notification && typeof data.notification === 'object' ? data.notification : null;
  var title = n ? clip(n.title, PUSH_TITLE_MAX) : '';
  if (!title) return fallbackNotification();
  var options = {
    body: clip(n.body, PUSH_BODY_MAX),
    lang: 'ru',
    icon: 'icon-192.png',
    data: { url: targetUrl(n.navigate) }
  };
  var tag = clip(n.tag, PUSH_TAG_MAX);
  if (tag) options.tag = tag;
  return self.registration.showNotification(title, options);
}

self.addEventListener('push', function (event) {
  var data = pushData(event);
  var shown;
  try {
    shown = Promise.resolve(showPush(data)).catch(fallbackNotification);
  } catch (e) {
    shown = fallbackNotification();
  }
  event.waitUntil(Promise.all([shown, setBadge(badgeOf(data))]));
});

// Окно «Планишки» (оболочка в своей области): фокус и адрес сообщением — страница сама откроет нужный экран
// без перезагрузки; окна нет — новое окно.
function openFromNotification(url) {
  var clients = self.clients;
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var client = null;
    for (var i = 0; i < list.length; i++) {
      var u;
      try { u = new URL(list[i].url); } catch (e) { continue; }
      if (isShellPath(u)) { client = list[i]; break; }
    }
    if (!client || typeof client.focus !== 'function') return clients.openWindow ? clients.openWindow(url) : null;
    return client.focus().then(function (focused) {
      var target = focused || client;
      target.postMessage({ type: OPEN_MESSAGE, url: url });
      return target;
    }, function () {
      return clients.openWindow ? clients.openWindow(url) : null;
    });
  });
}

self.addEventListener('notificationclick', function (event) {
  var notification = event.notification;
  var data = notification && notification.data;
  if (notification && typeof notification.close === 'function') notification.close();
  event.waitUntil(openFromNotification(targetUrl(data && data.url)).catch(noop));
});
