/* =========================================================
   mk-emulator / shelf.js — библиотека программ

   • встроенные примеры (перенесены из старой ветки calculator)
   • сквозная нумерация 01, 02, 03 …
   • сохранение текущей программы в память браузера
   • загрузка в корпус одним нажатием
   • проверка: прогон с данными из описания и сверка с эталоном
   • выгрузка и загрузка файла .json
   • мост из языка «МК-Алго» (lang.html → index.html)

   При загрузке в корпус передаётся метка {num, title}: ui.js
   показывает её чипом под дисплеем и на кнопке библиотеки.

   Ничего не считает само: вычисления по-прежнему в core.js,
   а запуск идёт через мост window.MKUI из ui.js.
   ========================================================= */
(function () {
  'use strict';

  var LIB_KEY = 'mk-emulator/library';
  var BRIDGE_KEY = 'mk-emulator/bridge';

  var NOP = 0x54;

  /* --- встроенные примеры ---
     prog — готовые коды ячеек: числа записываются как последовательность
     цифровых шагов (1 → 0x01), адреса в переходах проверены по листингу.

     ВАЖНО про data: перед прогоном ui.js обнуляет X/Y/Z/T и кладёт
     числа только в регистры. Поэтому программа НЕ должна начинаться
     с «X→П r» по тому регистру, где уже лежат входные данные —
     иначе она затрёт их нулём. Именно на этом падал факториал:
     00 X→П 0 затирал R0 = 7, цикл F L0 уходил в −1, −2, … до лимита.

     Про переходы: в core.js условие истинно — значит выполняется
     СЛЕДУЮЩАЯ команда, а переход по адресу происходит при ЛОЖНОМ
     условии. Все листинги ниже написаны именно под это правило. */
  var BUILTIN = [
    {
      id: 'fact',
      title: 'n! — факториал',
      note: 'n берётся из R0, счётчик — R0, произведение копится в R1',
      input: 'R0 = n (целое ≥ 1)',
      check: 'n = 7 → 5040',
      expect: 5040,
      data: { 0: 7 },
      /* 00 1 · 01 X→П 1 · 02 П→X 1 · 03 П→X 0 · 04 × · 05 X→П 1
         06 F L0 → 02 · 09 П→X 1 · 10 С/П   (7 итераций, 39 шагов) */
      prog: [0x01, 0x41, 0x61, 0x60, 0x12, 0x41, 0x5D, 0x00, 0x02, 0x61, 0x50]
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
      /* 07 X→П 4 не трогает стек, поэтому p остаётся в Z и подхватывается
         под первое умножение — поэтому листинг короче, чем кажется. */
      prog: [0x61, 0x62, 0x10, 0x63, 0x10, 0x02, 0x13, 0x44,
             0x64, 0x61, 0x11, 0x12, 0x64, 0x62, 0x11, 0x12,
             0x64, 0x63, 0x11, 0x12, 0x21, 0x50]
    },
    {
      id: 'nod4',
      title: 'НОД четырёх чисел',
      note: 'Евклид вычитанием; общая часть — подпрограмма на адресе 20',
      input: 'R1, R2, R3, R4 — целые числа',
      check: '32, 124, 206, 1086 → 2',
      expect: 2,
      data: { 1: 32, 2: 124, 3: 206, 4: 1086 },
      /* Основная часть: три вызова ПП 20, между ними R2 := следующее число.
           00 ПП 20 · 03 П→X 3 · 04 X→П 2
           05 ПП 20 · 08 П→X 4 · 09 X→П 2
           10 ПП 20 · 13 П→X 1 · 14 С/П
         15–19 — пустые шаги, чтобы подпрограмма легла ровно на 20.
         Подпрограмма (R1, R2 → НОД в R1):
           20 П→X1 · 21 П→X2 · 22 −            d = a − b
           23 F x≠0 → 43                       d ≠ 0 — работаем дальше
           26 F x≥0 → 36                       d ≥ 0 — уменьшаем a, иначе b
           29..32  a := a − b · 33 БП 20
           36..39  b := b − a · 40 БП 20
           43 В/О                              возврат к (адрес вызова + 3) */
      prog: [
        0x53, 0x02, 0x00,
        0x63, 0x42,
        0x53, 0x02, 0x00,
        0x64, 0x42,
        0x53, 0x02, 0x00,
        0x61, 0x50,
        0x54, 0x54, 0x54, 0x54, 0x54,
        0x61, 0x62, 0x11,
        0x57, 0x04, 0x03,
        0x59, 0x03, 0x06,
        0x61, 0x62, 0x11, 0x41,
        0x51, 0x02, 0x00,
        0x62, 0x61, 0x11, 0x42,
        0x51, 0x02, 0x00,
        0x52
      ]
    }
  ];

  var builtinLast = {};  /* id → {ok, text} */

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
      var n = num;
      ui.list.appendChild(row(n, p.title, p.check, p.input, {
        onLoad: function () { applyProgram(p.prog, p.data, p.title, n); },
        onCheck: function () { checkProgram(p, 'b:' + p.id, n); },
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
      var n = num;
      ui.list.appendChild(row(n, p.name, p.check || '', p.input || '', {
        onLoad: function () { applyProgram(p.prog, p.data || {}, p.name, n); },
        onCheck: function () { checkProgram(p, 'm:' + p.name, n); },
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
  function applyProgram(prog, data, title, num) {
    if (!window.MKUI) return;
    window.MKUI.loadProgram(prog, data, { num: num || null, title: title });
    window.MKUI.hint('Загружено «' + (num ? pad2(num) + ' · ' : '') + title +
      '». Данные в регистрах, нажми Пуск.');
  }

  /* ---------- мост из языка МК-Алго ----------
     lang.html кладёт собранную программу в localStorage и открывает
     index.html. Здесь она забирается ровно один раз и ставится в память
     корпуса тем же путём, что и программа из библиотеки. */
  function takeBridge() {
    var raw = null;
    try { raw = localStorage.getItem(BRIDGE_KEY); } catch (e) { return; }
    if (!raw) return;

    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    try { localStorage.removeItem(BRIDGE_KEY); } catch (e) {}

    if (!obj || !Array.isArray(obj.prog) || !obj.prog.length) return;
    if (!window.MKUI || !window.MKUI.loadProgram) return;

    var title = obj.from || 'МК-Алго';
    window.MKUI.loadProgram(obj.prog, obj.data || {}, { num: null, title: title });
    window.MKUI.hint('Загружено из «' + title + '»: ' + obj.prog.length +
      ' ячеек. Нажми «Шаг» или «Авто», чтобы пройти по своей программе.');
  }

  /* ---------- проверка ---------- */
  function checkProgram(p, key, num) {
    if (!window.MKUI) return;
    window.MKUI.loadProgram(p.prog, p.data || {}, { num: num || null, title: p.title });
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

    /* номер своей программы в общем списке — после встроенных */
    var pos = arr.map(function (x) { return x.name; }).indexOf(name);
    var num = BUILTIN.length + pos + 1;
    window.MKUI.setProgMeta({ num: num, title: name });

    window.MKUI.hint('Сохранено «' + name + '» под номером ' + pad2(num) +
      ': ' + prog.length + ' ячеек, регистров ' + Object.keys(regs).length);
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

    /* мост забираем после того, как ui.js создал ядро и корпус */
    setTimeout(takeBridge, 80);
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
    builtin: BUILTIN,
    takeBridge: takeBridge
  };
})();
