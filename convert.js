/* convert.js — импорт файлов каталога programs/*.json прямо в корпусе.
   Надстройка: ядро (core.js), библиотека (shelf.js) и разметка не меняются.
   Каталог хранит prog как массив объектов {addr, hex, cmd, note} —
   здесь он переводится в плоский массив кодов, который понимает core.js.
   Нераспознанное ("??") не превращается в 0: такой шаг попадает в missing. */
(function () {
  'use strict';

  var VERSION = 1;

  function byId(id) { return document.getElementById(id); }

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
    var btn = style('button', '', 'Файл .json');
    btn.id = 'convBtn';
    btn.title = 'Импорт файлов каталога programs/*.json';
    var ref = byId('decodeBtn');
    if (ref && ref.className) btn.className = ref.className;
    else btn.className = 'hbtn';

    var head = ref ? ref.parentNode : (byId('head') || document.body);
    head.appendChild(btn);

    var wrap = style('div',
      'position:fixed;inset:0;z-index:9999;display:none;background:rgba(0,0,0,.55);' +
      'align-items:flex-start;justify-content:center;padding:16px;overflow:auto;');
    wrap.id = 'convWrap';

    var box = style('div',
      'background:var(--bg,#fff);color:inherit;max-width:720px;width:100%;border-radius:14px;' +
      'padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:15px;');

    var title = style('div', 'font-weight:700;font-size:18px;margin-bottom:4px;', 'Импорт файлов каталога');
    var hint = style('div', 'opacity:.7;font-size:13px;margin-bottom:12px;',
      'Файлы programs/*.json. Нераспознанные команды ("??") не превращаются в 0 — программа с ними не откроется, пока не снята галочка.');

    var pick = style('input', 'margin:6px 0 10px;');
    pick.type = 'file';
    pick.accept = '.json,application/json';
    pick.multiple = true;

    var drop = style('div',
      'border:2px dashed currentColor;border-radius:10px;padding:18px;text-align:center;opacity:.75;margin-bottom:12px;',
      'или перетащите .json сюда');

    var list = style('div', 'display:flex;flex-direction:column;gap:8px;max-height:48vh;overflow:auto;');
    list.id = 'convList';

    var actions = style('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;');
    var closeB = style('button', 'padding:8px 14px;border-radius:8px;', 'Закрыть');

    actions.appendChild(closeB);
    box.appendChild(title);
    box.appendChild(hint);
    box.appendChild(pick);
    box.appendChild(drop);
    box.appendChild(list);
    box.appendChild(actions);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    function open() { wrap.style.display = 'flex'; }
    function close() { wrap.style.display = 'none'; }

    btn.onclick = open;
    closeB.onclick = close;
    wrap.onclick = function (e) { if (e.target === wrap) close(); };

    pick.onchange = function () {
      addFiles(pick.files);
      pick.value = '';
    };

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.opacity = '1'; });
    });
    drop.addEventListener('dragleave', function () { drop.style.opacity = '.75'; });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.style.opacity = '.75';
      addFiles(e.dataTransfer.files);
    });

    return { open: open };
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
      list.appendChild(style('div', 'opacity:.6;', 'Файлы ещё не выбраны.'));
      return;
    }

    items.forEach(function (p, idx) {
      var row = style('div',
        'border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:10px;display:flex;' +
        'flex-direction:column;gap:6px;');

      var nameRow = style('div', 'font-weight:600;word-break:break-word;', p.name);
      row.appendChild(nameRow);

      if (p.error) {
        row.appendChild(style('div', 'color:#c0392b;font-size:13px;', p.error));
        list.appendChild(row);
        return;
      }

      var info = p.steps + ' шагов';
      if (p.model) info += ' · ' + p.model;
      if (p.section) info += ' · ' + p.section;
      info += p.missing.length
        ? ' · не распознано: ' + p.missing.length + ' (адреса ' + p.missing.join(', ') + ')'
        : ' · все ячейки известны';
      var infoRow = style('div', 'font-size:13px;opacity:.8;', info);
      if (p.missing.length) infoRow.style.color = '#c0392b';
      row.appendChild(infoRow);

      var rowActions = style('div', 'display:flex;gap:8px;flex-wrap:wrap;');

      var saveB = style('button', 'padding:6px 12px;border-radius:8px;', 'Скачать для корпуса');
      saveB.onclick = function () { downloadOne(p); };
      rowActions.appendChild(saveB);

      var openB = style('button', 'padding:6px 12px;border-radius:8px;', 'Открыть в корпусе');
      if (p.missing.length) {
        openB.disabled = true;
        openB.title = 'Есть нераспознанные команды: ' + p.missing.join(', ');
      }
      openB.onclick = function () { openInBody(p); };
      rowActions.appendChild(openB);

      var delB = style('button', 'padding:6px 12px;border-radius:8px;opacity:.7;', 'Убрать');
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
    if (byId('convBtn')) return;
    buildUI();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.MKCONVERT = { version: VERSION, toCodes: toCodes, programsFrom: programsFrom };
})();
