/* convert.js — импорт файлов каталога programs/*.json прямо в корпусе + починка вёрстки.
   Надстройка: ядро (core.js), библиотека (shelf.js) и разметка корпуса не меняются,
   кроме одной строки подключения в index.html.
   Каталог хранит prog как массив объектов {addr, hex, cmd, note} —
   здесь он переводится в плоский массив кодов, который понимает core.js.
   Нераспознанное ("??") не превращается в 0: такой шаг попадает в missing.

   v2: добавлена инъекция стилей.
   Причина была не в шелфе и не в кнопке «Файл», а в строке шапки:
   .top — flex без переноса, select растянут на всё свободное место.
   Семью элементами шапка становилась шире телефона, документ получал
   горизонтальную прокрутку, и всё содержимое (включая окно «Программы»)
   уезжало вбок и обрезалось с обеих сторон. Здесь перенос включается,
   а select больше не может выдавить кнопки за край. */
(function () {
  'use strict';

  var VERSION = 2;
  var FIX_ID = 'mkLayoutFix';

  function byId(id) { return document.getElementById(id); }

  /* --- починка вёрстки: одна таблица стилей, добавляется после штатных --- */
  var FIX_CSS = [
    /* горизонтальная прокрутка страницы не нужна никогда */
    'html, body { overflow-x: hidden; max-width: 100%; }',

    /* шапка: переносится, кнопки не растягиваются, список моделей не выдавливает */
    '.top { flex-wrap: wrap; align-items: center; gap: 6px; }',
    '.top > label { flex: 0 0 auto; }',
    '.top > select, #model { flex: 1 1 120px; min-width: 0; max-width: 100%; }',
    '.top > .topbtn { flex: 0 0 auto; }',
    '.top > a.topbtn { white-space: nowrap; }',

    /* окно «Программы»: не шире экрана, даже если что-то внутри попытается вырасти */
    '.shelf { max-width: 100vw; }',
    '.shelf-card { min-width: 0; max-width: min(520px, 100%); }',
    '.shelf-head, .shelf-tools, .shelf-list { min-width: 0; }',
    '.shelf-tools button { min-width: 0; flex: 1 1 130px; overflow: hidden; text-overflow: ellipsis; }',
    '.srow { min-width: 0; }',
    '.sbtns, .sb { min-width: 0; }',

    /* само окно конвертера */
    '#convWrap { max-width: 100vw; }',
    '#convWrap > div, #convList { min-width: 0; }',

    /* на узком экране подпись «Модель» убирается — она и так понятна по названию */
    '@media (max-width: 380px) {',
    '  .top > label { display: none; }',
    '  .top > .topbtn { padding: 8px 8px; font-size: 13px; }',
    '  .top > a.topbtn { font-size: 11px; }',
    '  #themeBtn { min-width: 34px; }',
    '}'
  ].join('\n');

  function injectLayoutFix() {
    if (byId(FIX_ID)) return;
    var st = document.createElement('style');
    st.id = FIX_ID;
    st.textContent = FIX_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* "14" -> 20, 20 -> 20, "??" -> null */
  function hexToCode(h) {
    if (typeof h === 'number' && isFinite(h)) return h;
    if (typeof h !== 'string') return null;
    var t = h.trim();
    if (!t || !/^[0-9A-Fa-f]{1,2}$/.test(t)) return null;
    return parseInt(t, 16);
  }

  /* prog каталога -> {prog:[числа], missing:[адреса]} */
  function toCodes(src) {
    var out = [], missing = [], i, el, code, addr;
    src = src || [];
    for (i = 0; i < src.length; i++) {
      el = src[i];
      code = null;
      addr = i;
      if (typeof el === 'number') {
        code = el;
      } else if (typeof el === 'string') {
        code = hexToCode(el);
      } else if (el && typeof el === 'object') {
        code = hexToCode(el.hex);
        if (typeof el.addr === 'number') addr = el.addr;
      }
      if (code === null) missing.push(addr);
      else out.push(code);
    }
    return { prog: out, missing: missing };
  }

  /* файл каталога -> список программ */
  function programsFrom(obj, fileName) {
    var list = [], i, p, conv;
    if (!obj || typeof obj !== 'object') return list;

    var arr = Array.isArray(obj.programs) ? obj.programs : null;
    if (!arr && (obj.prog || obj.data)) arr = [obj];
    if (!arr) return list;

    for (i = 0; i < arr.length; i++) {
      p = arr[i] || {};
      conv = toCodes(p.prog);
      if (!conv.prog.length && !conv.missing.length) continue;
      list.push({
        name: p.name || (fileName || 'без имени').replace(/\.json$/i, '') + (arr.length > 1 ? ' · ' + (i + 1) : ''),
        model: p.model || obj.model || '',
        section: p.section || '',
        status: p.status || '',
        steps: conv.prog.length + conv.missing.length,
        prog: conv.prog,
        missing: conv.missing,
        data: p.data || {},
        layout: p.layout || {},
        inputs: p.inputs || [],
        src: p.src || ''
      });
    }
    return list;
  }

  var items = [];

  function style(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildUI() {
    var btn = byId('convBtn');
    if (!btn) {
      btn = style('button', '', 'Файл');
      btn.id = 'convBtn';
      btn.className = 'topbtn';
      btn.title = 'Импорт файлов каталога programs/*.json';
      var anchor = byId('shelfOpen');
      var bar = anchor ? anchor.parentNode : document.body;
      bar.appendChild(btn);
    } else if (!btn.title) {
      btn.title = 'Импорт файлов каталога programs/*.json';
    }

    var wrap = style('div',
      'position:fixed;inset:0;z-index:9999;display:none;background:rgba(0,0,0,.55);' +
      'align-items:flex-start;justify-content:center;padding:16px;overflow:auto;max-width:100vw;');
    wrap.id = 'convWrap';

    var box = style('div',
      'background:var(--bg,#fff);color:var(--text,inherit);max-width:720px;width:100%;border-radius:14px;' +
      'padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:15px;border:1px solid var(--line,#ccc);' +
      'box-sizing:border-box;min-width:0;');

    var title = style('div', 'font-weight:700;font-size:17px;margin-bottom:4px;', 'Импорт файлов каталога');
    var hint = style('div', 'opacity:.75;font-size:12px;line-height:1.4;margin-bottom:12px;',
      'Файлы programs/*.json (объекты addr/hex). Нераспознанные команды «??» не заменяются нулём: ' +
      'программа с ними не откроется в корпусе.');

    var pick = style('input', 'margin:6px 0 10px;max-width:100%;');
    pick.type = 'file';
    pick.accept = '.json,application/json';
    pick.multiple = true;

    var drop = style('div',
      'border:2px dashed var(--line,currentColor);border-radius:10px;padding:18px;text-align:center;' +
      'opacity:.7;margin-bottom:12px;font-size:13px;', 'или перетащите .json сюда');

    var list = style('div', 'display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow:auto;min-width:0;');
    list.id = 'convList';

    var actions = style('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;');
    var closeB = style('button', 'padding:8px 14px;border-radius:8px;border:1px solid var(--line,#ccc);' +
      'background:var(--chip,#f2f2f2);color:inherit;font:inherit;cursor:pointer;', 'Закрыть');

    actions.appendChild(closeB);
    box.appendChild(title);
    box.appendChild(hint);
    box.appendChild(pick);
    box.appendChild(drop);
    box.appendChild(list);
    box.appendChild(actions);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    function close() { wrap.style.display = 'none'; }
    btn.onclick = function () { wrap.style.display = 'flex'; };
    closeB.onclick = close;
    wrap.onclick = function (e) { if (e.target === wrap) close(); };

    pick.onchange = function () {
      addFiles(pick.files);
      pick.value = '';
    };

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.opacity = '1'; });
    });
    drop.addEventListener('dragleave', function () { drop.style.opacity = '.7'; });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.style.opacity = '.7';
      addFiles(e.dataTransfer.files);
    });

    return { close: close };
  }

  function addFiles(fileList) {
    var files = [], i;
    for (i = 0; i < fileList.length; i++) files.push(fileList[i]);
    if (!files.length) return;

    var pending = files.length;
    files.forEach(function (f) {
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var obj = JSON.parse(String(fr.result));
          var got = programsFrom(obj, f.name);
          if (!got.length) {
            items.push({ name: f.name, error: 'в файле не найдено программ', prog: [], missing: [] });
          } else {
            got.forEach(function (p) { items.push(p); });
          }
        } catch (e) {
          items.push({ name: f.name, error: 'не удалось разобрать JSON: ' + e.message, prog: [], missing: [] });
        }
        if (--pending === 0) render();
      };
      fr.onerror = function () {
        items.push({ name: f.name, error: 'файл не прочитан', prog: [], missing: [] });
        if (--pending === 0) render();
      };
      fr.readAsText(f);
    });
  }

  function render() {
    var list = byId('convList');
    if (!list) return;
    list.innerHTML = '';

    if (!items.length) {
      list.appendChild(style('div', 'opacity:.6;font-size:13px;', 'Файлы ещё не выбраны.'));
      return;
    }

    items.forEach(function (p, idx) {
      var row = style('div',
        'border:1px solid var(--line,rgba(128,128,128,.35));border-radius:10px;padding:10px;' +
        'display:flex;flex-direction:column;gap:6px;min-width:0;');

      row.appendChild(style('div', 'font-weight:600;word-break:break-word;font-size:14px;', p.name));

      if (p.error) {
        row.appendChild(style('div', 'color:#c0392b;font-size:12px;', p.error));
        list.appendChild(row);
        return;
      }

      var info = p.steps + ' шагов';
      if (p.model) info += ' · ' + p.model;
      if (p.section) info += ' · ' + p.section;
      info += p.missing.length
        ? ' · не распознано: ' + p.missing.length + ' (адреса ' + p.missing.join(', ') + ')'
        : ' · все ячейки известны';

      var infoRow = style('div', 'font-size:12px;opacity:.85;', info);
      if (p.missing.length) { infoRow.style.color = '#c0392b'; infoRow.style.opacity = '1'; }
      row.appendChild(infoRow);

      var rowActions = style('div', 'display:flex;gap:8px;flex-wrap:wrap;');
      var bcss = 'padding:6px 12px;border-radius:8px;border:1px solid var(--line,#ccc);' +
        'background:var(--chip,#f2f2f2);color:inherit;font:inherit;font-size:12px;cursor:pointer;';

      var saveB = style('button', bcss, 'Скачать для корпуса');
      saveB.onclick = function () { downloadOne(p); };
      rowActions.appendChild(saveB);

      var openB = style('button', bcss, 'Открыть в корпусе');
      if (p.missing.length) {
        openB.disabled = true;
        openB.style.opacity = '.5';
        openB.style.cursor = 'not-allowed';
        openB.title = 'Есть нераспознанные команды: ' + p.missing.join(', ');
      }
      openB.onclick = function () { openInBody(p); };
      rowActions.appendChild(openB);

      var delB = style('button', bcss + 'opacity:.7;', 'Убрать');
      delB.onclick = function () { items.splice(idx, 1); render(); };
      rowActions.appendChild(delB);

      row.appendChild(rowActions);
      list.appendChild(row);
    });
  }

  function buildFile(p) {
    return {
      app: 'mk-emulator',
      format: 'programs',
      version: 2,
      model: p.model || 'mk61',
      saved: new Date().toISOString(),
      programs: [{
        name: p.name,
        section: p.section || '',
        steps: p.prog.length,
        inputs: p.inputs || [],
        prog: p.prog,
        data: p.data || {},
        layout: p.layout || {},
        src: p.src || ''
      }]
    };
  }

  function downloadOne(p) {
    var blob = new Blob([JSON.stringify(buildFile(p), null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (p.name || 'program').replace(/[\\/:*?"<>|]/g, '_') + '.prog.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function openInBody(p) {
    if (p.missing.length) {
      alert('Нельзя открыть: не распознаны шаги ' + p.missing.join(', ') + '.\n' +
        'Их нельзя заменить нулём — программа посчитает неправильно.');
      return;
    }
    if (typeof window.MKUI === 'undefined' || !window.MKUI.loadProgram) {
      alert('Корпус не готов принять программу.');
      return;
    }
    try {
      window.MKUI.loadProgram(p.prog.slice(), p.data || {}, { title: p.name });
      var w = byId('convWrap');
      if (w) w.style.display = 'none';
      if (window.MKSHELF && typeof window.MKSHELF.toast === 'function') {
        window.MKSHELF.toast('Открыто: ' + p.name);
      }
    } catch (e) {
      alert('Не удалось открыть программу: ' + e.message);
    }
  }

  function boot() {
    injectLayoutFix();
    if (!byId('convWrap')) buildUI();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.MKCONVERT = { version: VERSION, toCodes: toCodes, programsFrom: programsFrom };
})();
