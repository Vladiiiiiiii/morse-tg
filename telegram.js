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

  var VALUE_LIMIT = 4096;   // ограничение Telegram на размер значения
  var CLOUD_TIMEOUT = 2500; // если облако молчит — не подвешиваем игру

  function localGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function localSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function wrap(value) {
    return (value === null || value === undefined) ? null : { value: value };
  }

  window.storage = {
    get: function (key) {
      return new Promise(function (resolve) {
        var local = localGet(key);
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
    },

    set: function (key, value) {
      var str = String(value);
      localSet(key, str);                 // локально пишем всегда
      return new Promise(function (resolve) {
        if (!cloud || typeof cloud.setItem !== 'function') { resolve(); return; }
        // слишком длинную запись облако не примет — остаётся только локальная копия
        if (str.length > VALUE_LIMIT) { resolve(); return; }
        try {
          cloud.setItem(safeKey(key), str, function (err) {
            if (err) dropCloud();
            resolve();
          });
        } catch (e) { dropCloud(); resolve(); }
      });
    }
  };

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
