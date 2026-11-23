/* =========================================================
   mk-emulator / shelf.js — библиотека программ

   • встроенные примеры (перенесены из старой ветки calculator)
   • сквозная нумерация 01, 02, 03 …
   • сохранение текущей программы в память браузера
   • загрузка в корпус одним нажатием
   • проверка: прогон с данными из описания и сверка с эталоном
   • выгрузка и загрузка файла .json

   Ничего не считает само: вычисления по-прежнему в core.js,
   а запуск идёт через мост window.MKUI из ui.js.
   ========================================================= */
(function () {
  'use strict';

  var LIB_KEY = 'mk-emulator/library';

  var NOP = 0x54;

  /* --- встроенные примеры ---
     prog — готовые коды ячеек: числа записываются как последовательность
     цифровых шагов (1 → 0x01), адреса в переходах проверены по листингу. */
  var BUILTIN = [
    {
      id: 'fact',
      title: 'n! — факториал',
      note: 'Цикл F L0 по счётчику R0, произведение копится в R1',
      input: 'R0 = n (целое ≥ 1)',
      check: 'n = 7 → 5040',
      expect: 5040,
      data: { 0: 7 },
      prog: [0x40, 0x01, 0x41, 0x61, 0x60, 0x12, 0x41, 0x5D, 0x00, 0x03, 0x61, 0x50]
    },
    {
      id: 'sum',
      title: 'Сумма 1…N',
      note: 'S = N(N+1)/2 — без цикла, прямо по формуле',
      input: 'R0 = N (целое ≥ 1)',
      check: 'N = 10 → 55',
      expect: 55,
      data: { 0: 10 },
      prog: [0x60, 0x60, 0x01, 0x10, 0x12, 0x02, 0x13, 0x50]
    },
    {
      id: 'seg',
      title: 'Длина отрезка',
      note: '√((x₂−x₁)² + (y₂−y₁)²)',
      input: 'R1 = x₂, R2 = x₁, R3 = y₂, R4 = y₁',
      check: '(1;2) и (8;4) → 7.2801099',
      expect: 7.2801099,
      data: { 1: 8, 2: 1, 3: 4, 4: 2 },
      prog: [0x61, 0x62, 0x11, 0x22, 0x63, 0x64, 0x11, 0x22, 0x10, 0x21, 0x50]
    },
    {
      id: 'circle',
      title: 'Площадь круга',
      note: 'S = πr²',
      input: 'R1 = r',
      check: 'r = 2 → 12.566371',
      expect: 12.566371,
      data: { 1: 2 },
      prog: [0x61, 0x22, 0x20, 0x12, 0x50]
    },
    {
      id: 'geron',
      title: 'Формула Герона',
      note: 'S = √(p(p−a)(p−b)(p−c)), p = (a+b+c)/2',
      input: 'R1 = a, R2 = b, R3 = c',
      check: '3, 4, 5 → 6',
      expect: 6,
      data: { 1: 3, 2: 4, 3: 5 },
      prog: [0x61, 0x62, 0x10, 0x63, 0x10, 0x02, 0x13, 0x44,
             0x64, 0x61, 0x11, 0x12, 0x64, 0x62, 0x11, 0x12,
             0x64, 0x63, 0x11, 0x12, 0x21, 0x50]
    }
  ];

  var builtinLast = {};  /* id → {ok, got, steps} */

  /* ---------- мои программы ---------- */
  function loadLib() {
    try {
      var raw = localStorage.getItem(LIB_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveLib(arr) {
    try { localStorage.setItem(LIB_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  /* ---------- панель ---------- */
  var ui = null;

  function nodes() {
    if (ui) return ui;
    ui = {
      shelf: document.getElementById('shelf'),
      list: document.getElementById('shelfList'),
      close: document.getElementById('shelfClose'),
      save: document.getElementById('shelfSave'),
      exp: document.getElementById('shelfExport'),
      imp: document.getElementById('shelfImport'),
      file: document.getElementById('shelfFile'),
      open: document.getElementById('shelfOpen')
    };
    return ui;
  }

  function pad2(n) {
    var s = String(n | 0);
    return s.length < 2 ? '0' + s : s;
  }

  function openShelf() {
    nodes();
    if (!ui.shelf) return;
    ui.shelf.hidden = false;
    document.body.classList.add('shelf-open');
    renderShelf();
  }

  function closeShelf() {
    nodes();
    if (!ui.shelf) return;
    ui.shelf.hidden = true;
    document.body.classList.remove('shelf-open');
  }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function renderShelf() {
    nodes();
    if (!ui.list) return;
    var mine = loadLib();
    ui.list.innerHTML = '';

    var num = 0;

    ui.list.appendChild(el('div', 'shelf-cat', 'Встроенные · ' + BUILTIN.length));

    BUILTIN.forEach(function (p) {
      num++;
      ui.list.appendChild(row(num, p.title, p.check, p.input, {
        onLoad: function () { applyProgram(p.prog, p.data, p.title); },
        onCheck: function () { checkProgram(p, 'b:' + p.id); },
        last: builtinLast['b:' + p.id]
      }));
    });

    ui.list.appendChild(el('div', 'shelf-cat', 'Мои · ' + mine.length));

    if (!mine.length) {
      ui.list.appendChild(el('div', 'shelf-empty',
        'Пока пусто. Набери программу в режиме ПРГ и нажми «Сохранить текущую» — появится здесь с номером.'));
    }

    mine.forEach(function (p) {
      num++;
      ui.list.appendChild(row(num, p.name, p.check || '', p.input || '', {
        onLoad: function () { applyProgram(p.prog, p.data || {}, p.name); },
        onCheck: function () { checkProgram(p, 'm:' + p.name); },
        onDelete: function () {
          var arr = loadLib().filter(function (x) { return x.name !== p.name; });
          saveLib(arr);
          renderShelf();
        },
        last: builtinLast['m:' + p.name]
      }, true));
    });
  }

  function row(num, title, check, input, acts, removable) {
    var d = el('div', 'srow');

    var n = el('div', 'snum', pad2(num));
    var body = el('div', 'sbody');
    body.appendChild(el('div', 'stitle', title));
    var sub = [];
    if (check) sub.push(check);
    if (input) sub.push(input);
    if (sub.length) body.appendChild(el('div', 'ssub', sub.join(' · ')));

    if (acts.last) {
      var st = el('div', 'sres ' + (acts.last.ok ? 'ok' : 'bad'),
        (acts.last.ok ? '✓ ' : '✗ ') + acts.last.text);
      body.appendChild(st);
    }

    var btns = el('div', 'sbtns');
    var bLoad = el('button', 'sb', 'Загрузить');
    bLoad.type = 'button';
    bLoad.addEventListener('click', function () { acts.onLoad(); closeShelf(); });
    btns.appendChild(bLoad);

    var bChk = el('button', 'sb', 'Проверить');
    bChk.type = 'button';
    bChk.addEventListener('click', function () { acts.onCheck(); });
    btns.appendChild(bChk);

    if (removable) {
      var bDel = el('button', 'sb danger', 'Удалить');
      bDel.type = 'button';
      bDel.addEventListener('click', function () { acts.onDelete(); });
      btns.appendChild(bDel);
    }

    body.appendChild(btns);
    d.appendChild(n);
    d.appendChild(body);
    return d;
  }

  /* ---------- загрузка в корпус ---------- */
  function applyProgram(prog, data, title) {
    if (!window.MKUI) return;
    window.MKUI.loadProgram(prog, data);
    window.MKUI.hint('Загружено «' + title + '». Данные в регистрах, нажми Пуск.');
  }

  /* ---------- проверка ---------- */
  function checkProgram(p, key) {
    if (!window.MKUI) return;
    window.MKUI.loadProgram(p.prog, p.data || {});
    var r = window.MKUI.runForCheck(20000);
    var got = r.X;
    var exp = p.expect;
    var ok = (r.result === 'stop');
    if (ok && typeof exp === 'number') {
      ok = Math.abs(got - exp) <= Math.abs(exp) * 1e-6 + 1e-9;
    }

    builtinLast[key] = {
      ok: ok,
      text: window.MKUI.fmt(got) + (typeof exp === 'number' ? ' (ждали ' + exp + ')' : '') + ' · ' + r.steps + ' шагов'
    };

    window.MKUI.hint(ok
      ? 'Проверка «' + p.title + '»: совпало — ' + window.MKUI.fmt(got) + ', шагов ' + r.steps
      : 'Проверка «' + p.title + '»: получено ' + window.MKUI.fmt(got) +
        (typeof exp === 'number' ? ', ожидалось ' + exp : '') +
        ' · ' + (r.result === 'stop' ? 'С/П достигнуто' : r.result === 'error' ? 'ошибка' : 'лимит шагов'));

    renderShelf();
  }

  /* ---------- сохранить текущую ---------- */
  function saveCurrent() {
    if (!window.MKUI) return;
    var core = window.MKUI.getCore();
    var last = core.lastStep();
    if (last < 0) {
      window.MKUI.hint('В памяти нет программы: набери её в режиме ПРГ или загрузи пример.');
      return;
    }
    var name = window.prompt('Название программы', 'Моя программа');
    if (!name) return;

    var prog = core.ST.prog.slice(0, Math.min(last + 1, core.ST.prog.length));
    var regs = {};
    for (var i = 0; i < window.MKCore.REG_COUNT; i++) {
      if (core.ST.R[i]) regs[i] = core.ST.R[i];
    }

    var arr = loadLib();
    var entry = { name: name, prog: prog, data: regs, savedAt: Date.now() };
    var idx = -1;
    for (var k = 0; k < arr.length; k++) if (arr[k].name === name) idx = k;
    if (idx >= 0) arr[idx] = entry; else arr.push(entry);
    saveLib(arr);

    window.MKUI.hint('Сохранено «' + name + '»: ' + prog.length + ' ячеек, регистров ' + Object.keys(regs).length);
    renderShelf();
  }

  /* ---------- файл: выгрузка и загрузка ---------- */
  function exportLib() {
    var data = {
      app: 'mk-emulator',
      model: 'b3-34',
      saved: new Date().toISOString(),
      programs: loadLib()
    };
    var text = JSON.stringify(data, null, 2);
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'b3-34-programs.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function importLib(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var obj = JSON.parse(String(reader.result));
        var incoming = Array.isArray(obj) ? obj : (obj.programs || []);
        var arr = loadLib();
        var added = 0;
        incoming.forEach(function (p) {
          if (!p || !p.name || !Array.isArray(p.prog)) return;
          var exists = arr.some(function (x) { return x.name === p.name; });
          if (!exists) { arr.push(p); added++; }
        });
        saveLib(arr);
        renderShelf();
        if (window.MKUI) window.MKUI.hint('Импорт: добавлено ' + added + ' программ');
      } catch (e) {
        if (window.MKUI) window.MKUI.hint('Файл не похож на выгрузку программ: ' + e.message);
      }
    };
    reader.readAsText(file);
  }

  /* ---------- подключение ---------- */
  function init() {
    nodes();
    if (ui.open) ui.open.addEventListener('click', openShelf);
    if (ui.close) ui.close.addEventListener('click', closeShelf);
    if (ui.save) ui.save.addEventListener('click', saveCurrent);
    if (ui.exp) ui.exp.addEventListener('click', exportLib);
    if (ui.imp) ui.imp.addEventListener('click', function () { if (ui.file) ui.file.click(); });
    if (ui.file) {
      ui.file.addEventListener('change', function () {
        importLib(ui.file.files && ui.file.files[0]);
        ui.file.value = '';
      });
    }
    if (ui.shelf) {
      ui.shelf.addEventListener('click', function (e) {
        if (e.target === ui.shelf) closeShelf();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MKSHELF = {
    init: init,
    open: openShelf,
    close: closeShelf,
    builtin: BUILTIN
  };
})();
