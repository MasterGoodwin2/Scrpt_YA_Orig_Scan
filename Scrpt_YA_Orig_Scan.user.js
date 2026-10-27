// ==UserScript==
// @name         Scrpt_YA_Orig_Scan
// @namespace    https://github.com/MasterGoodwin2/Scrpt_YA_Orig_Scan
// @version      1.2.0
// @description  Яндекс.Архив (yandex.ru, ya.ru): автоматически сохраняет оригинальный скан ТЕКУЩЕЙ страницы одним JPG-файлом (сжатым до качества 60%) в папку загрузок.
// @author       MasterGoodwin2
// @match        https://yandex.ru/archive/*
// @match        https://ya.ru/archive/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/MasterGoodwin2/Scrpt_YA_Orig_Scan
// ==/UserScript==

/*
 * Основан на логике расширения Archive Original Downloader 1.8.8-beta
 * (https://github.com/JPS-Codex/archive-original-downloader),
 * оставлена только часть для Яндекс.Архива и одиночное скачивание.
 */
(function () {
  'use strict';

  var LOG = '[Scrpt_YA_Orig_Scan]';
  var PANEL_ID = 'scrpt-ya-orig-scan-panel';
  var DONE_PREFIX = 'scrptYaOrigScanDone:';
  var MIN_BYTES = 20000;
  // Максимальное ожидание полной загрузки графики страницы (мс).
  var GRAPHICS_TIMEOUT_MS = 45000;
  // Качество JPG при пересохранении: 0.6 = 60% от оригинала.
  var JPEG_QUALITY = 0.6;

  // Страница скана: /archive/catalog/<id>/<номер>
  var LEAF_RE = /^\/archive\/catalog\/([^/?#]+)\/(\d+)\/?$/i;

  var busy = false;
  var lastHandledUrl = null;

  // ---------- Вспомогательное ----------

  function isSupportedHost() {
    return /^(www\.)?(yandex\.ru|ya\.ru)$/i.test(location.hostname);
  }

  function parseLeaf(urlString) {
    try {
      var u = new URL(urlString, location.href);
      if (!/^(www\.)?(yandex\.ru|ya\.ru)$/i.test(u.hostname)) return null;
      var m = u.pathname.match(LEAF_RE);
      if (!m) return null;
      return { id: m[1], page: parseInt(m[2], 10), url: u.origin + u.pathname };
    } catch (e) {
      return null;
    }
  }

  function sanitize(value) {
    return String(value || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function safeGet(key) {
    try { return sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { sessionStorage.setItem(key, value); } catch (e) {}
  }
  function safeRemove(key) {
    try { sessionStorage.removeItem(key); } catch (e) {}
  }

  function parseNextData(html) {
    var m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m || !m[1]) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function looksLikeHtml(bytes) {
    var s = '';
    var n = Math.min(bytes.length, 256);
    for (var i = 0; i < n; i += 1) s += String.fromCharCode(bytes[i]);
    return /^\s*(<!doctype html|<html|<head|<body)/i.test(s);
  }

  function isJpeg(bytes) {
    return bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  }

  // ---------- Получение данных страницы ----------

  // Берём свежий HTML именно той страницы, которая открыта сейчас
  // (на SPA-переходах __NEXT_DATA__ в DOM может быть устаревшим).
  async function loadPageInfo(leaf) {
    var response = await fetch(leaf.url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error('Не удалось загрузить страницу, HTTP ' + response.status + '.');
    }
    var html = await response.text();
    var data = parseNextData(html);
    var props = data && data.props ? data.props.pageProps : null;
    var node = props && props.currentNode ? props.currentNode : null;
    if (!node || !node.id) {
      throw new Error('Не найден идентификатор скана на странице.');
    }
    return {
      nodeId: node.id,
      breadcrumbs: props.breadcrumbs || [],
      html: html
    };
  }

  function buildFilename(info, pageNumber) {
    var crumbs = info.breadcrumbs || [];
    function find(type) {
      for (var i = 0; i < crumbs.length; i += 1) {
        if (crumbs[i].type === type) return crumbs[i];
      }
      return null;
    }
    var archive = find('Archive');
    var fund = find('Fund');
    var inventory = find('Inventory');
    var file = find('File');
    var opisMatch = inventory && String(inventory.code || '').match(/\d+/);
    var padded = String(pageNumber).padStart(4, '0');

    var parts = [];
    if (fund && fund.code) parts.push(String(fund.code).trim());
    if (opisMatch) parts.push(opisMatch[0]);
    if (file && file.code) parts.push(String(file.code).trim());

    if (parts.length >= 2) {
      var prefix = archive && archive.name ? sanitize(archive.name) + '_[ЯА]_' : '';
      return prefix + sanitize(parts.join('-') + '-' + padded) + '.jpg';
    }
    return 'YA_archive_' + sanitize(info.nodeId) + '_' + padded + '.jpg';
  }

  // ---------- Ожидание загрузки графики ----------

  function isVisibleBox(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // true, если на странице есть крупное, полностью загруженное изображение (скан)
  // и ни одна видимая картинка не находится в процессе загрузки.
  function graphicsState() {
    var imgs = Array.prototype.slice.call(document.images);
    var pending = 0;
    var mainReady = false;
    imgs.forEach(function (img) {
      var src = img.currentSrc || img.getAttribute('src');
      if (!src || !isVisibleBox(img)) return;
      var r = img.getBoundingClientRect();
      var inViewport = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
      if (!img.complete) {
        if (inViewport) pending += 1;
        return;
      }
      if (img.naturalWidth === 0) return; // битая картинка не блокирует ожидание
      if (r.width >= 200 && r.height >= 200) mainReady = true;
    });
    Array.prototype.forEach.call(document.querySelectorAll('canvas'), function (c) {
      if (c.width >= 200 && c.height >= 200 && isVisibleBox(c)) mainReady = true;
    });
    return { pending: pending, mainReady: mainReady };
  }

  // Ждём полной загрузки документа и графики; возвращает true, если дождались,
  // false — если истёк таймаут (тогда всё равно продолжаем). Прерывается при смене страницы.
  async function waitForGraphics(leaf) {
    var started = Date.now();
    var stable = 0;

    if (document.readyState !== 'complete') {
      await new Promise(function (resolve) {
        var done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        window.addEventListener('load', finish, { once: true });
        setTimeout(finish, GRAPHICS_TIMEOUT_MS);
      });
    }

    while (Date.now() - started < GRAPHICS_TIMEOUT_MS) {
      var now = parseLeaf(location.href);
      if (!now || now.url !== leaf.url) return false;
      var st = graphicsState();
      if (st.pending === 0 && st.mainReady) {
        stable += 1;
        if (stable >= 3) return true; // ~0,75 с без изменений
      } else {
        stable = 0;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
    return false;
  }

  // ---------- Загрузка оригинала ----------

  function validateBytes(bytes, contentType) {
    if (contentType && contentType.indexOf('image/') !== 0) {
      throw new Error('Сервер вернул не изображение (' + contentType + ').');
    }
    if (looksLikeHtml(bytes)) {
      throw new Error('Сервер вернул HTML вместо скана.');
    }
    if (bytes.length < MIN_BYTES) {
      throw new Error('Получен слишком маленький файл (' + bytes.length + ' байт), вероятно превью.');
    }
    return bytes;
  }

  async function fetchOriginal(nodeId) {
    var grantResponse = await fetch('/archive/api/image-grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ nodeId: nodeId, type: 'original' })
    });
    if (!grantResponse.ok) {
      throw new Error('image-grant: HTTP ' + grantResponse.status + '.');
    }
    var grant = await grantResponse.json();
    if (!grant || !grant.url || !grant.token) {
      throw new Error('image-grant: некорректный ответ сервера.');
    }

    var imageUrl = new URL(grant.url, location.origin).href;
    var imageResponse = await fetch(imageUrl, {
      headers: { 'X-Archive-Image-Token': grant.token },
      credentials: 'include'
    });
    if (!imageResponse.ok) {
      throw new Error('Загрузка оригинала: HTTP ' + imageResponse.status + '.');
    }
    var contentType = String(imageResponse.headers.get('content-type') || '').toLowerCase();
    var bytes = new Uint8Array(await imageResponse.arrayBuffer());
    validateBytes(bytes, contentType);
    if (!isJpeg(bytes)) {
      console.warn(LOG, 'Файл не начинается с JPEG-сигнатуры, но сохраняется как .jpg');
    }
    return bytes;
  }

  // Пересжатие в JPG с качеством JPEG_QUALITY; размеры в пикселях сохраняются.
  async function recompressJpeg(bytes) {
    var source = new Blob([bytes]);
    var bitmap = await createImageBitmap(source);
    try {
      var canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas недоступен.');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      var blob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
      });
      if (!blob || blob.size < 1000 || blob.type !== 'image/jpeg') {
        throw new Error('Не удалось закодировать JPG.');
      }
      return blob;
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  function saveBlob(blob, filename) {
    var objectUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 10000);
  }

  function formatSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.round(n / 1024) + ' КБ';
  }

  // ---------- Панель статуса ----------

  function ensurePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'max-width:340px', 'padding:10px 12px', 'border-radius:10px',
      'background:#1f2937', 'color:#fff', 'font:13px/1.4 Arial,sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.3)'
    ].join(';');

    var text = document.createElement('div');
    text.className = 'scrpt-text';
    panel.appendChild(text);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scrpt-btn';
    btn.textContent = 'Скачать скан ещё раз';
    btn.style.cssText = 'margin-top:8px;padding:5px 10px;border:0;border-radius:6px;' +
      'background:#fc0;color:#000;cursor:pointer;font:600 12px Arial,sans-serif';
    btn.addEventListener('click', function () { run(true); });
    panel.appendChild(btn);

    document.body.appendChild(panel);
    return panel;
  }

  function setStatus(message, kind) {
    var panel = ensurePanel();
    var text = panel.querySelector('.scrpt-text');
    text.textContent = message;
    panel.style.background = kind === 'error' ? '#991b1b' : kind === 'ok' ? '#166534' : '#1f2937';
    var btn = panel.querySelector('.scrpt-btn');
    btn.disabled = busy;
    btn.style.opacity = busy ? '0.5' : '1';
  }

  function hidePanel() {
    var panel = document.getElementById(PANEL_ID);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
  }

  // ---------- Основной сценарий ----------

  // force=true — повторное скачивание по кнопке.
  async function run(force) {
    var leaf = parseLeaf(location.href);
    if (!leaf) {
      hidePanel();
      return;
    }
    if (busy) return;

    var doneKey = DONE_PREFIX + leaf.url;
    if (!force && safeGet(doneKey)) {
      setStatus('Скан страницы ' + leaf.page + ' уже сохранён (' + safeGet(doneKey) + ').', 'ok');
      return;
    }

    busy = true;
    setStatus('Страница ' + leaf.page + ': жду полной загрузки графики…');
    try {
      var graphicsOk = await waitForGraphics(leaf);
      var afterWait = parseLeaf(location.href);
      if (!afterWait || afterWait.url !== leaf.url) return;
      if (!graphicsOk) {
        console.warn(LOG, 'Графика не загрузилась за ' + GRAPHICS_TIMEOUT_MS + ' мс, продолжаю.');
      }
      setStatus('Страница ' + leaf.page + ': получаю оригинал…');
      var info = await loadPageInfo(leaf);
      // Пользователь мог уйти на другую страницу, пока шёл запрос.
      var now = parseLeaf(location.href);
      if (!now || now.url !== leaf.url) return;

      var filename = buildFilename(info, leaf.page);
      var bytes = await fetchOriginal(info.nodeId);
      var outBlob;
      var note;
      try {
        setStatus('Страница ' + leaf.page + ': сжимаю JPG до качества 60%…');
        outBlob = await recompressJpeg(bytes);
        note = formatSize(bytes.length) + ' → ' + formatSize(outBlob.size);
      } catch (compressError) {
        // Если пересжатие невозможно (например, слишком большой снимок) — сохраняем оригинал.
        console.warn(LOG, 'Пересжатие не удалось, сохраняю оригинал:', compressError);
        outBlob = new Blob([bytes], { type: 'image/jpeg' });
        note = 'сжатие не удалось, сохранён оригинал ' + formatSize(bytes.length);
      }
      saveBlob(outBlob, filename);
      safeSet(doneKey, filename);
      busy = false;
      setStatus('Сохранено: ' + filename + ' (' + note + ')', 'ok');
    } catch (e) {
      busy = false;
      safeRemove(doneKey);
      console.error(LOG, e);
      setStatus('Ошибка: ' + (e && e.message ? e.message : e), 'error');
    } finally {
      busy = false;
    }
  }

  // ---------- Отслеживание страницы (в т. ч. SPA-переходы) ----------

  function onLocationMaybeChanged() {
    var leaf = parseLeaf(location.href);
    if (!leaf) {
      lastHandledUrl = null;
      hidePanel();
      return;
    }
    if (leaf.url === lastHandledUrl) return;
    lastHandledUrl = leaf.url;
    run(false);
  }

  function init() {
    if (!isSupportedHost()) return;

    ['pushState', 'replaceState'].forEach(function (method) {
      var original = history[method];
      history[method] = function () {
        var result = original.apply(this, arguments);
        setTimeout(onLocationMaybeChanged, 0);
        return result;
      };
    });
    window.addEventListener('popstate', onLocationMaybeChanged);
    // Подстраховка на случай навигации, не прошедшей через History API.
    setInterval(onLocationMaybeChanged, 1000);

    onLocationMaybeChanged();
  }

  init();
})();
