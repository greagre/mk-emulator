#!/usr/bin/env node
/* =========================================================
   mk-emulator / tools/bundle.cjs
   Собирает ОДИН автономный HTML из index.html + layout.css + скрипты.

   Зачем это нужно
   ---------------
   При открытии index.html прямо из файлового менеджера (адрес вида
   content://com.ghisler.files/... ) браузер не может прочитать соседние
   файлы: layout.css, core.js, profiles.js, ui.js, shelf.js, convert.js.
   В итоге видна голая разметка — без корпуса, без клавиатуры, кнопки
   не реагируют. По http:// (GitHub Pages) всё работает, по file/content —
   нет, потому что относительные пути к соседним файлам не разрешаются.

   Один файл, где <style> и <script> вшиты внутрь, работает везде:
   из файлового менеджера, с флешки, офлайн, без сервера.

   Запуск:  node tools/bundle.cjs
   Выход:   mk-offline.html в корне репозитория
   ========================================================= */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC = 'index.html';
var OUT = 'mk-offline.html';

/* страницы, которые в офлайн-файле не открыть: их нет в бандле */
var PAGES = ['lang.html', 'b3-decode.html', 'tests.html', 'algo.html',
             'algo-v7.html', 'algo-v8.html', 'catalog.html', 'import.html'];

var inlined = [];

function read(file) {
  var p = path.join(ROOT, file);
  if (!fs.existsSync(p)) throw new Error('нет файла: ' + file);
  inlined.push(file);
  return fs.readFileSync(p, 'utf8');
}

/* внутри <script> нельзя держать закрывающий тег скрипта даже в строке */
function escapeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

/* --- шим хранилища ---
   В отдельных файловых менеджерах localStorage для content:// недоступен
   и бросает исключение. Подменяем его хранилищем в памяти, чтобы ui.js
   и shelf.js не падали на старте. */
var SHIM = [
  '<script>',
  '/* офлайн-сборка: страховка хранилища */',
  '(function () {',
  '  var ok = false;',
  '  try { window.localStorage.setItem("__mk_probe", "1");',
  '        window.localStorage.removeItem("__mk_probe"); ok = true; } catch (e) { ok = false; }',
  '  if (ok) return;',
  '  var mem = {};',
  '  var store = {',
  '    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },',
  '    setItem: function (k, v) { mem[k] = String(v); },',
  '    removeItem: function (k) { delete mem[k]; },',
  '    clear: function () { mem = {}; },',
  '    key: function (i) { return Object.keys(mem)[i] || null; },',
  '    get length() { return Object.keys(mem).length; }',
  '  };',
  '  try { Object.defineProperty(window, "localStorage", { configurable: true, value: store }); }',
  '  catch (e2) {}',
  '})();',
  '</script>'
].join('\n');

/* --- заглушка для ссылок на страницы, которых нет в бандле --- */
var LINK_SHIM = [
  '<script>',
  'document.addEventListener("click", function (e) {',
  '  var t = e.target;',
  '  while (t && t !== document) {',
  '    if (t.getAttribute && t.getAttribute("data-offline")) {',
  '      e.preventDefault();',
  '      alert("Офлайн-сборка: страница " + t.getAttribute("data-offline") +',
  '            " лежит отдельным файлом в репозитории. В этом одном файле её нет.");',
  '      return;',
  '    }',
  '    t = t.parentNode;',
  '  }',
  '});',
  '</script>'
].join('\n');

var html = read(SRC);

/* 1. стили внутрь */
html = html.replace(/<link\s+rel="stylesheet"\s+href="([^"?]+)(?:\?[^"]*)?"\s*\/?>/g,
  function (m, href) {
    return '<style>\n' + read(href) + '\n</style>';
  });

/* 2. скрипты внутрь, в том же порядке, что и были */
html = html.replace(/<script\s+src="([^"?]+)(?:\?[^"]*)?"\s*><\/script>/g,
  function (m, src) {
    return '<script>\n' + escapeScript(read(src)) + '\n</script>';
  });

/* 3. шим хранилища — раньше любых скриптов эмулятора */
var firstScript = html.indexOf('<script');
if (firstScript > 0) {
  html = html.slice(0, firstScript) + SHIM + '\n' + html.slice(firstScript);
}

/* 4. ссылки на страницы, которых в бандле нет */
PAGES.forEach(function (page) {
  html = html.split('href="' + page + '"').join('href="#" data-offline="' + page + '"');
});

/* 5. заглушка ссылок — перед </body> */
html = html.replace('</body>', LINK_SHIM + '\n</body>');

/* 6. подпись сборки */
html = html.replace('<title>', '<title>офлайн · ');

/* --- проверки: не осталось внешних зависимостей --- */
var problems = [];
var reCss = /<link\s+rel="stylesheet"\s+href="/;
var reJs = /<script\s+src="/g;
if (reCss.test(html)) problems.push('остался внешний <link rel="stylesheet">');
var m;
while ((m = reJs.exec(html)) !== null) problems.push('остался внешний скрипт: ' + m[0]);

var outPath = path.join(ROOT, OUT);
fs.writeFileSync(outPath, html, 'utf8');

var kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log('собрано: ' + OUT + ' — ' + kb + ' КБ');
console.log('вшито файлов: ' + inlined.length);
console.log('  ' + inlined.join(', '));
if (problems.length) {
  console.log('ВНИМАНИЕ: ' + problems.join('; '));
  process.exitCode = 2;
} else {
  console.log('внешних зависимостей не осталось — файл автономный');
}
