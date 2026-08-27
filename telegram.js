/* Обвязка для Telegram Mini App.
   Файл подключается ДО основного скрипта игры, потому что игра читает прогресс
   через window.storage — здесь этот интерфейс подменяется на CloudStorage Telegram.
   Вне Telegram всё молча падает обратно на localStorage, страница работает как обычный сайт. */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;

  // SDK создаёт window.Telegram.WebApp и в обычном браузере, поэтому проверяем,
  // что приложение действительно запущено из Telegram и версия умеет CloudStorage (6.9+)
  var inTelegram = !!(tg && tg.platform && tg.platform !== 'unknown');
  var cloudOk = false;
  try {
    cloudOk = inTelegram && !!tg.CloudStorage &&
      (typeof tg.isVersionAtLeast !== 'function' || tg.isVersionAtLeast('6.9'));
  } catch (e) { cloudOk = false; }
  var cloud = cloudOk ? tg.CloudStorage : null;

  // прогресс читается по одному ключу на уровень; если облако начало отваливаться,
  // выключаем его на всю сессию, иначе загрузка встанет на таймаутах
  function dropCloud() { cloud = null; }

  /* ---------- 1. Прогресс: CloudStorage + localStorage ---------- */

  // ключи CloudStorage допускают только A-Z a-z 0-9 _ - (наши содержат «:»)
  function safeKey(key) {
    return String(key).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  }

  var VALUE_LIMIT = 4096;      // ограничение Telegram на размер значения
  var CLOUD_TIMEOUT = 2500;    // если облако молчит — не подвешиваем игру
  var PREFETCH_TIMEOUT = 3500; // общий бюджет на стартовую выгрузку
  var CHUNK = 40;              // сколько ключей запрашиваем одним getItems

  // Прогресс читается по одному ключу на уровень — это 250+ чтений на экране «ИСТОРИИ».
  // По одному запросу в облако это десятки секунд, поэтому на старте выгружаем всё
  // разом (getKeys + getItems пачками), а дальше отдаём из памяти.
  var cache = null;            // safeKey -> value
  var prefetchDone = null;     // Promise, ждём его перед первым чтением

  function prefetchAll() {
    if (prefetchDone) return prefetchDone;
    prefetchDone = new Promise(function (resolve) {
      if (!cloud || typeof cloud.getKeys !== 'function' || typeof cloud.getItems !== 'function') {
        resolve();
        return;
      }
      var finished = false;
      var budget = setTimeout(function () {
        if (finished) return;
        finished = true;
        dropCloud();           // не успели — работаем на localStorage
        resolve();
      }, PREFETCH_TIMEOUT);

      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(budget);
        resolve();
      }

      try {
        cloud.getKeys(function (err, keys) {
          if (finished) return;
          if (err) { dropCloud(); finish(); return; }
          cache = {};                      // облако прочитано, пусть даже пустое
          if (!keys || !keys.length) { finish(); return; }
          var chunks = [];
          for (var i = 0; i < keys.length; i += CHUNK) chunks.push(keys.slice(i, i + CHUNK));
          var left = chunks.length;
          chunks.forEach(function (chunk) {
            try {
              cloud.getItems(chunk, function (e2, values) {
                if (!e2 && values) {
                  for (var k in values) {
                    if (values[k] !== '' && values[k] !== null) {
                      cache[k] = values[k];
                      localSetBySafe(k, values[k]);
                    }
                  }
                }
                if (--left <= 0) finish();
              });
            } catch (e) { if (--left <= 0) finish(); }
          });
        });
      } catch (e) { dropCloud(); finish(); }
    });
    return prefetchDone;
  }

  function localGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function localSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function wrap(value) {
    return (value === null || value === undefined) ? null : { value: value };
  }

  // при выгрузке из облака знаем только нормализованный ключ — храним зеркало под ним же
  function localSetBySafe(safe, value) {
    try { localStorage.setItem('cloud:' + safe, value); } catch (e) {}
  }
  function localGetBySafe(safe) {
    try { return localStorage.getItem('cloud:' + safe); } catch (e) { return null; }
  }

  window.storage = {
    get: function (key) {
      var safe = safeKey(key);
      return prefetchAll().then(function () {
        var local = localGet(key);
        if (local === null) local = localGetBySafe(safe);   // зеркало стартовой выгрузки

        // всё, что есть в облаке, уже лежит в памяти — сеть больше не трогаем
        if (cache) {
          var hit = cache[safe];
          return wrap(hit === undefined || hit === '' ? local : hit);
        }
        return new Promise(function (resolve) {
        if (!cloud || typeof cloud.getItem !== 'function') { resolve(wrap(local)); return; }

        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          dropCloud();                 // облако не отвечает — дальше только localStorage
          resolve(wrap(local));
        }, CLOUD_TIMEOUT);

        try {
          cloud.getItem(safeKey(key), function (err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) dropCloud();
            if (err || value === null || value === undefined || value === '') {
              resolve(wrap(local));       // в облаке пусто — берём локальное
            } else {
              localSet(key, value);        // держим локальную копию свежей
              resolve(wrap(value));
            }
          });
        } catch (e) {
          dropCloud();
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(wrap(local));
        }
        });
      });
    },

    set: function (key, value) {
      var str = String(value);
      var safe = safeKey(key);
      localSet(key, str);                 // локально пишем всегда
      localSetBySafe(safe, str);
      if (cache) cache[safe] = str;       // держим память свежей, чтение уже не пойдёт в сеть
      return new Promise(function (resolve) {
        if (!cloud || typeof cloud.setItem !== 'function') { resolve(); return; }
        // слишком длинную запись облако не примет — остаётся только локальная копия
        if (str.length > VALUE_LIMIT) { resolve(); return; }
        try {
          cloud.setItem(safe, str, function (err) {
            if (err) dropCloud();
            resolve();
          });
        } catch (e) { dropCloud(); resolve(); }
      });
    }
  };

  prefetchAll();             // стартуем выгрузку параллельно с загрузкой историй

  if (!inTelegram) return;   // открыли в обычном браузере — дальше нечего настраивать

  /* ---------- 2. Окно приложения ---------- */

  try { tg.ready(); } catch (e) {}
  try { tg.expand(); } catch (e) {}

  // главное для игры: свайп вниз по нижней зоне не должен закрывать приложение
  try { if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes(); } catch (e) {}

  try { tg.setHeaderColor('#0b0b12'); } catch (e) {}
  try { tg.setBackgroundColor('#0b0b12'); } catch (e) {}

  // высота вьюпорта Telegram не равна 100vh — отдаём её в CSS
  function syncViewport() {
    var h = tg.viewportStableHeight || tg.viewportHeight || window.innerHeight;
    document.documentElement.style.setProperty('--app-vh', h + 'px');
  }
  syncViewport();
  try { tg.onEvent('viewportChanged', syncViewport); } catch (e) {}
  window.addEventListener('resize', syncViewport);

  /* ---------- 3. Тактильная отдача на телеграфный ключ ---------- */

  window.tgHaptic = function () {
    try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
  };

  /* ---------- 4. Системная кнопка «Назад» ведёт к списку историй ---------- */

  window.tgOnTab = function (name) {
    if (!tg.BackButton) return;
    try {
      if (name === 'stories') tg.BackButton.hide();
      else tg.BackButton.show();
    } catch (e) {}
  };

  try {
    tg.BackButton.onClick(function () {
      if (window.tgGoStories) window.tgGoStories();
    });
  } catch (e) {}
})();
