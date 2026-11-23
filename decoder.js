/* =========================================================
   mk-emulator / decoder.js  (v2)
   Читает программу Б3-34 (массив кодов) и переводит её в текст.

   Ничего не исполняет, ядро и файлы программ не меняет.
   Для каждого шага отдаёт:
     text  — строка текста или null, если перевести нельзя;
     conf  — 'exact' (читаю код буквально) | 'heuristic' (догадка) | 'unknown' (не понял);
     cmd   — подпись команды по таблице Б3-34;
     hex   — код в hex;
     notes — пояснения простыми словами (для непонятного места обязательны).

   Семантика взята из core.js без изменений:
     — переход занимает три ячейки: команда, десятки адреса, единицы;
     — условный переход: условие ИСТИННО -> следующая ячейка,
       ЛОЖНО -> переход по адресу (три ячейки: i+3);
     — F L0..L3: из регистра вычитается 1; не ноль -> переход по адресу.

   v2: листинг выводится моноширинным текстом (одна строка — одна ячейка),
   с подсветкой (listingHtml), компактной раскладкой для узкого экрана
   и отдельным табличным вариантом (режим 'listingTable').
   ========================================================= */
(function (global) {
  'use strict';

  var NOPC = 0x54;

  var CMD = {
    0x0A: '·', 0x0B: '/-/', 0x0C: 'ВП', 0x0D: 'Cx', 0x0E: 'В↑', 0x0F: 'Вx',
    0x10: '+', 0x11: '−', 0x12: '×', 0x13: '÷', 0x14: '↔',
    0x15: '10^x', 0x16: 'e^x', 0x17: 'lg', 0x18: 'ln',
    0x19: 'arcsin', 0x1A: 'arccos', 0x1B: 'arctg', 0x1C: 'sin', 0x1D: 'cos', 0x1E: 'tg',
    0x20: 'π', 0x21: '√', 0x22: 'x²', 0x23: '1/x', 0x24: 'x^y', 0x25: 'F◯',
    0x50: 'С/П', 0x51: 'БП', 0x52: 'В/О', 0x53: 'ПП', 0x54: 'К НОП',
    0x57: 'F x≠0', 0x58: 'F L2', 0x59: 'F x≥0', 0x5A: 'F L3',
    0x5B: 'F L1', 0x5C: 'F x<0', 0x5D: 'F L0', 0x5E: 'F x=0'
  };

  var REG = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd'];

  /* истинное и ложное условие для команд сравнения */
  var COND = {
    0x57: { yes: 'X ≠ 0', no: 'X = 0' },
    0x59: { yes: 'X ≥ 0', no: 'X < 0' },
    0x5C: { yes: 'X < 0', no: 'X ≥ 0' },
    0x5E: { yes: 'X = 0', no: 'X ≠ 0' }
  };

  /* F L0..L3 -> номер регистра-счётчика */
  var LOOP = { 0x5D: 0, 0x5B: 1, 0x58: 2, 0x5A: 3 };

  var JUMP = { 0x51: 1, 0x53: 1, 0x57: 1, 0x58: 1, 0x59: 1, 0x5A: 1, 0x5B: 1, 0x5C: 1, 0x5D: 1, 0x5E: 1 };

  function isJump(c) { return JUMP[c] === 1; }

  function hex2(c) {
    var s = (c & 255).toString(16).toUpperCase();
    return s.length < 2 ? '0' + s : s;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function padTo(s, n) {
    s = String(s == null ? '' : s);
    if (s.length >= n) return s.slice(0, n);
    return s + new Array(n - s.length + 1).join(' ');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function isDigitCode(v) { return typeof v === 'number' && v >= 0 && v <= 9; }

  function cmdName(c) {
    c = c & 255;
    if (c >= 0 && c <= 9) return String(c);
    if (CMD[c]) return CMD[c];
    if (c >= 0x40 && c <= 0x4D) return 'X→П ' + REG[c & 15];
    if (c >= 0x60 && c <= 0x6D) return 'П→X ' + REG[c & 15];
    if (c >= 0x70 && c <= 0x7D) return 'К x≠0 ' + REG[c & 15];
    if (c >= 0x80 && c <= 0x8D) return 'К БП ' + REG[c & 15];
    if (c >= 0x90 && c <= 0x9D) return 'К x≥0 ' + REG[c & 15];
    if (c >= 0xA0 && c <= 0xAD) return 'К ПП ' + REG[c & 15];
    if (c >= 0xB0 && c <= 0xBD) return 'К X→П ' + REG[c & 15];
    if (c >= 0xC0 && c <= 0xCD) return 'К x<0 ' + REG[c & 15];
    if (c >= 0xD0 && c <= 0xDD) return 'К П→X ' + REG[c & 15];
    if (c >= 0xE0 && c <= 0xED) return 'К x=0 ' + REG[c & 15];
    return '?';
  }

  /* ---------- разбор входных данных ---------- */

  function normalize(progIn) {
    var out = [];
    if (Array.isArray(progIn)) {
      for (var i = 0; i < progIn.length; i++) {
        var v = progIn[i];
        out.push(typeof v === 'number' && isFinite(v) ? (Math.round(v) & 255) : NOPC);
      }
    }
    return out;
  }

  /* hex-строка: "01 41 61" или "014161" или "0x01, 0x41" */
  function parseHex(str) {
    var s = String(str == null ? '' : str).replace(/0x/gi, ' ');
    var tokens = s.split(/[^0-9a-fA-F]+/).filter(function (t) { return t.length > 0; });
    var out = [];
    tokens.forEach(function (t) {
      if (t.length <= 2) {
        out.push(parseInt(t, 16));
      } else {
        var parts = t.match(/.{1,2}/g) || [];
        parts.forEach(function (p) { out.push(parseInt(p, 16)); });
      }
    });
    return out.filter(function (v) { return typeof v === 'number' && !isNaN(v); });
  }

  /* файл программы: { app, format, programs:[{name, prog, data, ...}] } или одиночный { prog, data } */
  function fromProgramFile(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var one = null;
    if (Array.isArray(obj.programs) && obj.programs.length) one = obj.programs[0];
    if (!one && Array.isArray(obj.prog)) one = obj;
    if (!one) return null;

    var data = one.data;
    if (data && !Array.isArray(data) && typeof data === 'object') {
      var arr = [];
      for (var k = 0; k < 14; k++) {
        var v = data[k];
        arr.push(typeof v === 'number' ? v : 0);
      }
      data = arr;
    }
    return {
      prog: normalize(one.prog),
      data: Array.isArray(data) ? data : null,
      name: one.name || '',
      saved: obj.saved || '',
      savedAt: one.savedAt || ''
    };
  }

  /* ---------- основной разбор ---------- */

  function decodeProgram(progIn, meta) {
    meta = meta || {};
    var prog = normalize(progIn);
    var last = -1, i;
    for (i = 0; i < prog.length; i++) { if (prog[i] !== NOPC) last = i; }

    var model = {
      len: last + 1,
      prog: prog,
      steps: [],
      warnings: [],
      marks: {},
      bodies: [],
      meta: { name: meta.name || '', data: meta.data || null, saved: meta.saved || '' }
    };

    if (model.len <= 0) { model.empty = true; return model; }

    var steps = model.steps;
    var warnings = model.warnings;
    var marks = model.marks;
    var regWrite = {}, regRead = {};
    var hasStop = false, hasReturn = false, hasCall = false;

    i = 0;
    while (i < model.len) {
      var c = prog[i];
      var s = { addr: i, code: c, kind: 'cmd', conf: 'exact', notes: [] };
      s.cmd = cmdName(c);
      s.hex = hex2(c);

      /* --- переходы и циклы: три ячейки --- */
      if (isJump(c)) {
        s.kind = 'jump';
        var d1 = prog[i + 1], d2 = prog[i + 2];

        if (isDigitCode(d1) && isDigitCode(d2)) {
          s.target = d1 * 10 + d2;
          marks[s.target] = true;
          if (s.target >= model.len) {
            warnings.push('Переход с адреса ' + pad2(i) + ' ведёт на ' + pad2(s.target) + ', а последний шаг программы — ' +
              pad2(model.len - 1) + '. Там пустой шаг (К НОП), программа «провалится» дальше без остановки.');
          }
        } else {
          s.conf = 'unknown';
          s.notes.push('После «' + s.cmd + '» должны стоять две цифры адреса — десятки, затем единицы. ' +
            'В ячейке ' + pad2(i + 1) + ' записано ' + (isDigitCode(d1) ? d1 : 'не цифра (' + (d1 === undefined ? 'ячейки нет' : '0x' + hex2(d1)) + ')') +
            ', в ячейке ' + pad2(i + 2) + ' — ' + (isDigitCode(d2) ? d2 : 'не цифра (' + (d2 === undefined ? 'ячейки нет' : '0x' + hex2(d2)) + ')') + '.');
          s.notes.push('При пуске ядро выдаст ошибку адреса и остановится — такую программу надо править.');
        }

        var t = s.target;

        if (c === 0x51) {
          s.text = (t == null) ? 'перейти ??' : 'перейти м' + pad2(t);
          if (t != null) {
            s.notes.push('БП — безусловный переход на адрес ' + pad2(t) + '.');
            if (t <= i) s.notes.push('Переход назад или на себя: без условия это может быть вечный цикл.');
          }
        } else if (c === 0x53) {
          hasCall = true;
          s.text = (t == null) ? 'вызов ??' : 'вызов м' + pad2(t);
          if (t != null) {
            s.notes.push('ПП — вызов подпрограммы с адреса ' + pad2(t) + '; возврат придёт на адрес ' + pad2(i + 3) + ' по команде В/О.');
          }
          s.conf = (t == null) ? 'unknown' : 'exact';
        } else if (COND[c]) {
          if (t == null) {
            s.text = null;
          } else if (t > i) {
            s.text = 'если ' + COND[c].no + ' → м' + pad2(t);
            s.notes.push('«' + s.cmd + '»: если ' + COND[c].yes + ' — выполняется следующая ячейка (' + pad2(i + 3) + '), ' +
              'если ' + COND[c].no + ' — переход на ' + pad2(t) + '.');
          } else {
            s.text = 'если ' + COND[c].no + ' → м' + pad2(t);
            s.notes.push('Цикл: пока ' + COND[c].yes + ', тело повторяется с адреса ' + pad2(t) + '. ' +
              'Как только станет ' + COND[c].no + ' — выход на следующую ячейку (' + pad2(i + 3) + ').');
            s.loopHead = true;
          }
          s.conf = 'heuristic';
          s.notes.push('Границы тела восстановлены по адресу перехода — это догадка, проверь вручную.');
        } else if (LOOP[c] !== undefined) {
          var r = LOOP[c], rn = REG[r];
          regWrite[r] = true;
          var txt = 'R' + rn + ' = R' + rn + ' − 1';
          if (t != null) {
            txt += ' · если R' + rn + ' ≠ 0 → м' + pad2(t);
            s.notes.push('«' + s.cmd + '»: из R' + rn + ' вычитается 1. Если после вычитания не ноль — переход на ' + pad2(t) +
              ', если ноль — следующая ячейка (' + pad2(i + 3) + ').');
            s.notes.push('Обычно «' + s.cmd + '» стоит в конце тела: тело — адреса ' + pad2(t) + '…' + pad2(Math.max(t, i - 1)) +
              ', число проходов равно начальному значению R' + rn + '.');
            s.loopEnd = { target: t, reg: r };
          }
          s.text = txt;
          s.conf = 'heuristic';
        }

        steps.push(s);
        if (i + 1 < model.len) steps.push({ addr: i + 1, code: prog[i + 1], kind: 'addr', partOf: i, conf: 'exact', notes: [] });
        if (i + 2 < model.len) steps.push({ addr: i + 2, code: prog[i + 2], kind: 'addr', partOf: i, conf: 'exact', notes: [] });
        i += 3;
        continue;
      }

      /* --- число: цифры и точка собираются в одно значение --- */
      if (isDigitCode(c) || c === 0x0A) {
        var buf = '', parts = [], j = i, dot = false;
        while (j < model.len) {
          var cc = prog[j];
          if (isDigitCode(cc)) { buf += String(cc); parts.push(j); j++; continue; }
          if (cc === 0x0A && !dot) { dot = true; buf += (buf === '' ? '0' : '') + '.'; parts.push(j); j++; continue; }
          break;
        }
        if (buf === '' || buf === '0.') buf = '0';
        var num = parseFloat(buf);
        if (!isFinite(num)) num = 0;
        s.kind = 'num';
        s.text = 'X = ' + num;
        s.notes.push('Набор числа: стек сдвигается вверх, в X встаёт ' + num + '.');
        if (parts.length > 1) s.notes.push('Число занимает ячейки ' + pad2(parts[0]) + '–' + pad2(parts[parts.length - 1]) + '.');
        s.parts = parts.map(function (a) { return { addr: a, code: prog[a] }; });
        steps.push(s);
        i = j;
        continue;
      }

      /* --- одиночные команды --- */
      if (c >= 0x40 && c <= 0x4D) {
        var rs = c & 15;
        s.text = 'R' + REG[rs] + ' = X';
        s.notes.push('X → П ' + REG[rs] + ': число из X копируется в регистр R' + REG[rs] + ', сам X не меняется и стек не сдвигается.');
        regWrite[rs] = true;
        steps.push(s); i++; continue;
      }

      if (c >= 0x60 && c <= 0x6D) {
        var rl = c & 15;
        s.text = 'X = R' + REG[rl];
        s.notes.push('П → X ' + REG[rl] + ': в X кладётся значение R' + REG[rl] + ', стек сдвигается вверх.');
        regRead[rl] = true;
        steps.push(s); i++; continue;
      }

      if (c >= 0x70 && c <= 0xED) {
        var hi = (c >> 4) & 15, lo = c & 15, rk = REG[lo];
        var tbl = {
          7: { t: 'если X = 0 → переход по R' + rk, n: 'К x≠0 ' + rk + ': если X ≠ 0 — следующая ячейка, если X = 0 — переход по адресу из R' + rk + '.' },
          8: { t: 'перейти по R' + rk, n: 'К БП ' + rk + ': безусловный переход по адресу, записанному в R' + rk + '.' },
          9: { t: 'если X < 0 → переход по R' + rk, n: 'К x≥0 ' + rk + ': при X ≥ 0 — следующая ячейка, иначе переход по адресу из R' + rk + '.' },
          10: { t: 'вызов по R' + rk, n: 'К ПП ' + rk + ': вызов подпрограммы по адресу из R' + rk + '.' },
          11: { t: 'R[R' + rk + '] = X', n: 'К X→П ' + rk + ': номер регистра берётся из R' + rk + '. В какой именно регистр попадёт X — зависит от значения во время работы.' },
          12: { t: 'если X ≥ 0 → переход по R' + rk, n: 'К x<0 ' + rk + ': при X < 0 — следующая ячейка, иначе переход по адресу из R' + rk + '.' },
          13: { t: 'X = R[R' + rk + ']', n: 'К П→X ' + rk + ': читается регистр с номером из R' + rk + '.' },
          14: { t: 'если X ≠ 0 → переход по R' + rk, n: 'К x=0 ' + rk + ': при X = 0 — следующая ячейка, иначе переход по адресу из R' + rk + '.' }
        };
        var row = tbl[hi];
        s.text = row ? row.t : null;
        if (row) s.notes.push(row.n);
        s.notes.push('Косвенная адресация: адрес или номер регистра берётся из R' + rk + ' во время работы, по файлу его определить нельзя.');
        s.conf = 'heuristic';
        regRead[lo] = true;
        steps.push(s); i++; continue;
      }

      switch (c) {
        case 0x0B: s.text = 'X = −X'; s.notes.push('Смена знака числа в X.'); break;
        case 0x0C: s.text = null; s.conf = 'heuristic'; s.notes.push('ВП — ввод порядка степени. Отдельной строкой не переводится: порядок относится к соседним цифрам, прочитай их вместе.'); break;
        case 0x0D: s.text = 'X = 0'; s.notes.push('Cx — сброс X в ноль, стек не двигается.'); break;
        case 0x0E: s.text = 'X↑ (дубль X)'; s.notes.push('В↑ — X дублируется, старое X уходит в Y, дальше по стеку вниз.'); break;
        case 0x0F: s.text = 'X ↔ X1'; s.notes.push('Обмен X и вспомогательного регистра X1.'); break;
        case 0x10: s.text = 'X = Y + X'; s.notes.push('Сложение; результат в X, стек опускается на один.'); break;
        case 0x11: s.text = 'X = Y − X'; s.notes.push('Вычитание: из Y вычитается X, результат в X.'); break;
        case 0x12: s.text = 'X = Y × X'; s.notes.push('Умножение; результат в X, стек опускается.'); break;
        case 0x13: s.text = 'X = Y ÷ X'; s.notes.push('Деление: Y на X, результат в X. Деление на ноль даст ЕГГОГ.'); break;
        case 0x14: s.text = 'X ↔ Y'; s.notes.push('Меняются местами только X и Y.'); break;
        case 0x15: s.text = 'X = 10^X'; s.notes.push('Возведение 10 в степень X.'); break;
        case 0x16: s.text = 'X = e^X'; s.notes.push('Экспонента.'); break;
        case 0x17: s.text = 'X = lg(X)'; s.notes.push('Десятичный логарифм.'); break;
        case 0x18: s.text = 'X = ln(X)'; s.notes.push('Натуральный логарифм.'); break;
        case 0x19: s.text = 'X = arcsin(X)'; s.notes.push('Обратный синус. Результат зависит от переключателя Р-ГРД-Г — в файле это не хранится.'); break;
        case 0x1A: s.text = 'X = arccos(X)'; s.notes.push('Обратный косинус. Зависит от переключателя Р-ГРД-Г.'); break;
        case 0x1B: s.text = 'X = arctg(X)'; s.notes.push('Обратный тангенс. Зависит от переключателя Р-ГРД-Г.'); break;
        case 0x1C: s.text = 'X = sin(X)'; s.notes.push('Синус. Зависит от переключателя Р-ГРД-Г.'); break;
        case 0x1D: s.text = 'X = cos(X)'; s.notes.push('Косинус. Зависит от переключателя Р-ГРД-Г.'); break;
        case 0x1E: s.text = 'X = tg(X)'; s.notes.push('Тангенс. Зависит от переключателя Р-ГРД-Г.'); break;
        case 0x20: s.text = 'X = π'; s.notes.push('В X кладётся π, стек сдвигается.'); break;
        case 0x21: s.text = 'X = √X'; s.notes.push('Квадратный корень.'); break;
        case 0x22: s.text = 'X = X²'; s.notes.push('Квадрат числа из X.'); break;
        case 0x23: s.text = 'X = 1/X'; s.notes.push('Обратная величина.'); break;
        case 0x24: s.text = 'X = Y^X'; s.notes.push('Степень: Y в степени X, результат в X.'); break;
        case 0x25: s.text = 'F◯ (перестановка стека)'; s.notes.push('X ← Y, Y ← Z, Z ← T, T ← старое X.'); break;
        case 0x50: s.text = 'стоп'; hasStop = true; s.notes.push('С/П — остановка. Продолжение по повторному нажатию С/П (или уже ничего не выполнится, если это конец программы).'); break;
        case 0x52: s.text = 'возврат'; hasReturn = true; s.notes.push('В/О — возврат из подпрограммы по адресу, сохранённому ПП. Если вызовов не было, ядро перейдёт на адрес 00.'); break;
        case 0x54: s.kind = 'nop'; s.text = null; s.notes.push('К НОП — пустой шаг. Ядро просто идёт дальше.'); break;
        default:
          s.kind = 'unknown';
          s.text = null;
          s.conf = 'unknown';
          s.notes.push('Код 0x' + hex2(c) + ' не входит в систему команд Б3-34: при выполнении ядро выдаст ошибку (ЕГГОГ). ' +
            'Проверь, не перепутаны ли местами команда и адрес перехода.');
          break;
      }

      steps.push(s);
      i++;
    }

    /* --- проверки по всей программе --- */
    if (!hasStop) {
      warnings.push('В программе нет команды С/П: она не остановится сама, пока не кончится память или не будет ошибки.');
    }
    if (hasCall && !hasReturn) {
      warnings.push('Есть вызов подпрограммы (ПП), но нет команды В/О: возврат будет по адресу 00 — программа пойдёт сначала.');
    }
    Object.keys(regRead).forEach(function (k) {
      if (!regWrite[k]) {
        warnings.push('Регистр R' + REG[k] + ' читается, но нигде в программе не записывается: значение должно лежать там до пуска.');
      }
    });

    /* --- тела циклов для отступов --- */
    steps.forEach(function (st) {
      if (st.loopEnd && st.loopEnd.target != null) {
        var from, to, tg = st.loopEnd.target;
        if (tg <= st.addr) { from = tg; to = st.addr - 1; }
        else { from = st.addr + 3; to = tg - 1; }
        if (to >= from) model.bodies.push({ from: from, to: to, at: st.addr });
      }
      if (st.loopHead && st.target != null && st.target < st.addr) {
        if (st.addr - 1 >= st.target) model.bodies.push({ from: st.target, to: st.addr - 1, at: st.addr });
      }
    });

    return model;
  }

  function depthOf(model, addr) {
    var d = 0;
    (model.bodies || []).forEach(function (b) {
      if (addr >= b.from && addr <= b.to) d++;
    });
    return d;
  }

  /* ---------- общие помощники рендера ---------- */

  function headLines(model) {
    var out = [];
    var name = model.meta.name ? model.meta.name : 'Программа';
    out.push('# ' + name + ' — декодер Б3-34');
    out.push('# ячеек в программе: ' + model.len);

    var d = model.meta.data;
    if (d && d.length) {
      var parts = [];
      for (var k = 0; k < 14; k++) {
        if (typeof d[k] === 'number' && d[k] !== 0) parts.push('R' + REG[k] + ' = ' + d[k]);
      }
      out.push('# перед пуском: ' + (parts.length ? parts.join(' · ') : 'все регистры нулевые') + ' · X при пуске = 0');
    }
    if (model.meta.saved) out.push('# файл от ' + model.meta.saved);
    return out;
  }

  function confLabel(conf) {
    return conf === 'exact' ? 'точно' : (conf === 'heuristic' ? 'догадка' : 'не переведено');
  }

  function confMark(conf) {
    return conf === 'heuristic' ? '~' : (conf === 'unknown' ? '?' : '');
  }

  /* ---------- кратко и подробно ---------- */

  function briefText(model) {
    if (model.empty) return '# программа пуста';
    var out = headLines(model);
    out.push('');

    var printed = {};
    model.steps.forEach(function (s) {
      if (s.kind === 'addr') return;
      if (printed[s.addr]) return;
      if (model.marks[s.addr]) out.push('# м' + pad2(s.addr) + ':');

      if (s.kind === 'nop') return;
      if (s.parts) s.parts.forEach(function (p) { printed[p.addr] = true; });

      var ind = new Array(depthOf(model, s.addr) * 2 + 1).join(' ');
      if (s.text) out.push(ind + s.text);
      else out.push(ind + '# не переведено · шаг ' + pad2(s.addr) + ' · код 0x' + s.hex + ' (' + s.cmd + ')');
    });

    return out.join('\n');
  }

  function detailedText(model) {
    if (model.empty) return '# программа пуста';
    var out = headLines(model);
    out.push('');

    var printed = {};
    model.steps.forEach(function (s) {
      if (s.kind === 'addr') return;
      if (printed[s.addr]) return;
      if (model.marks[s.addr]) out.push('# м' + pad2(s.addr) + ':');

      if (s.parts) s.parts.forEach(function (p) { printed[p.addr] = true; });

      var ind = new Array(depthOf(model, s.addr) * 2 + 1).join(' ');

      if (s.kind === 'nop') {
        out.push(ind + '# ' + pad2(s.addr) + ' · К НОП · 0x54 — пустой шаг');
        return;
      }

      if (s.text) out.push(ind + s.text);

      out.push(ind + '  # ' + pad2(s.addr) + ' · ' + s.cmd + ' · 0x' + s.hex + ' · ' + confLabel(s.conf));
      (s.notes || []).forEach(function (n) { out.push(ind + '  #   ' + n); });
      out.push('');
    });

    if (model.warnings.length) {
      out.push('# ВНИМАНИЕ');
      model.warnings.forEach(function (w) { out.push('# - ' + w); });
    }
    return out.join('\n');
  }

  /* ---------- листинг: строки по ячейкам ---------- */

  function addrWidth(len) {
    var w = String(Math.max(len - 1, 0)).length;
    return w < 2 ? 2 : w;
  }

  function padA(a, w) {
    var s = String(a);
    while (s.length < w) s = '0' + s;
    return s;
  }

  /* Собирает строки листинга: одна строка — одна ячейка памяти. */
  function buildListing(model) {
    var prog = model.prog || [];
    var len = model.len;
    var aw = addrWidth(len);

    var stepAt = {}, addrCell = {}, inNum = {};

    model.steps.forEach(function (s) {
      if (s.kind === 'addr') { addrCell[s.addr] = s; return; }
      if (s.kind === 'num' && s.parts && s.parts.length) {
        var val = s.text ? String(s.text).replace(/^X = /, '') : '?';
        s.parts.forEach(function (p, idx) {
          inNum[p.addr] = { value: val, first: idx === 0, count: s.parts.length };
        });
        return;
      }
      stepAt[s.addr] = s;
    });

    var rows = [];
    for (var a = 0; a < len; a++) {
      var row = {
        addr: padA(a, aw),
        isMark: !!model.marks[a],
        hex: hex2(prog[a]),
        cmd: '',
        text: '',
        conf: 'exact',
        notes: []
      };

      if (inNum[a]) {
        var n = inNum[a];
        row.cmd = n.first ? 'ввод числа' : 'цифра числа';
        row.text = n.first ? ('X = ' + n.value) : ('в числе ' + n.value);
      } else if (addrCell[a]) {
        var which = (a === addrCell[a].partOf + 1) ? 'десятки' : 'единицы';
        row.cmd = 'адрес перехода';
        row.text = which + ': ' + (isDigitCode(prog[a]) ? prog[a] : 'не цифра');
      } else if (stepAt[a]) {
        var s = stepAt[a];
        row.cmd = s.cmd || '?';
        row.text = s.kind === 'nop' ? 'пустой шаг' : (s.text || 'НЕ ПЕРЕВЕДЕНО');
        row.conf = s.kind === 'nop' ? 'exact' : s.conf;
        row.notes = s.notes || [];
      } else {
        row.cmd = '?';
        row.text = 'нет данных';
        row.conf = 'unknown';
      }

      rows.push(row);
    }
    return { rows: rows, aw: aw };
  }

  function rowSegments(row, aw, compact) {
    var segs = [];
    if (row.isMark) {
      segs.push({ t: 'м' + row.addr + ':', cls: 'kMark' });
      segs.push({ t: '\n' });
    }
    segs.push({ t: row.addr, cls: 'kAddr' });
    segs.push({ t: compact ? ' ' : '  ' });
    segs.push({ t: row.hex, cls: 'kHex' });
    segs.push({ t: compact ? ' ' : '  ' });

    if (compact) {
      var body = row.cmd + (row.text && row.text !== row.cmd ? ' · ' + row.text : '');
      segs.push({ t: body, cls: row.conf === 'unknown' ? 'kUnk' : (row.conf === 'heuristic' ? 'kHeur' : 'kTxt') });
      var mk = confMark(row.conf);
      if (mk) { segs.push({ t: ' ' + mk, cls: 'kMark' }); }
    } else {
      segs.push({ t: padTo(row.cmd, 17), cls: 'kCmd' });
      segs.push({ t: '  ' });
      segs.push({ t: padTo(row.text, 40), cls: row.conf === 'unknown' ? 'kUnk' : 'kTxt' });
      segs.push({ t: '  ' });
      segs.push({ t: confLabel(row.conf), cls: 'kConf k' + (row.conf === 'exact' ? 'Exact' : (row.conf === 'heuristic' ? 'Heur' : 'Unk')) });
    }
    return segs;
  }

  function segmentsToText(segs) {
    return segs.map(function (s) { return s.t; }).join('');
  }

  function segmentsToHtml(segs) {
    return segs.map(function (s) {
      if (!s.cls) return esc(s.t);
      return '<span class="' + s.cls + '">' + esc(s.t) + '</span>';
    }).join('');
  }

  function listingHeader(model, opts) {
    var compact = !!(opts && opts.compact);
    var name = model.meta.name ? model.meta.name : 'Программа';
    var lines = [];
    lines.push('ЛИСТИНГ · ' + name + ' · ячеек ' + model.len);
    if (model.meta.saved) lines.push('файл от ' + model.meta.saved);
    if (!compact) {
      lines.push('');
      lines.push(padTo('адр', 3) + '  ' + 'код' + '   ' + padTo('команда', 17) + '  ' + padTo('текст', 40) + '  ' + 'достоверность');
      lines.push(new Array(3 + 2 + 3 + 3 + 17 + 2 + 40 + 2 + 13 + 1).join('-'));
    } else {
      lines.push('пометки: ~ догадка, ? не переведено');
      lines.push('');
    }
    return lines;
  }

  /* моноширинный ТЕКСТ листинга — то, что копируется и скачивается */
  function listingText(model, opts) {
    if (model.empty) return 'Программа пуста: в памяти нет ни одной значащей ячейки.';
    opts = opts || {};
    var compact = !!opts.compact;
    var built = buildListing(model);
    var out = listingHeader(model, opts);

    built.rows.forEach(function (row) {
      out.push(segmentsToText(rowSegments(row, built.aw, compact)));
    });

    var unknown = built.rows.filter(function (r) { return r.conf === 'unknown'; });
    if (unknown.length) {
      out.push('');
      out.push('ЧТО НЕ ПЕРЕВЕДЕНО И ПОЧЕМУ:');
      unknown.forEach(function (r) {
        out.push('ячейка ' + r.addr + ' · код 0x' + r.hex + ' · ' + r.cmd);
        (r.notes || []).forEach(function (n) { out.push('   ' + n); });
      });
    }

    if (model.warnings.length) {
      out.push('');
      out.push('ВНИМАНИЕ:');
      model.warnings.forEach(function (w) { out.push('- ' + w); });
    }

    return out.join('\n');
  }

  /* тот же листинг, но с подсветкой — вставлять через innerHTML */
  function listingHtml(model, opts) {
    if (model.empty) return 'Программа пуста: в памяти нет ни одной значащей ячейки.';
    opts = opts || {};
    var compact = !!opts.compact;
    var built = buildListing(model);
    var header = listingHeader(model, opts);

    var html = header.map(function (l) { return esc(l); }).join('\n');

    built.rows.forEach(function (row) {
      html += '\n' + segmentsToHtml(rowSegments(row, built.aw, compact));
    });

    var unknown = built.rows.filter(function (r) { return r.conf === 'unknown'; });
    if (unknown.length) {
      html += '\n\n' + esc('ЧТО НЕ ПЕРЕВЕДЕНО И ПОЧЕМУ:');
      unknown.forEach(function (r) {
        html += '\n' + esc('ячейка ' + r.addr + ' · код 0x' + r.hex + ' · ' + r.cmd);
        (r.notes || []).forEach(function (n) { html += '\n' + esc('   ' + n); });
      });
    }

    if (model.warnings.length) {
      html += '\n\n' + esc('ВНИМАНИЕ:');
      model.warnings.forEach(function (w) { html += '\n' + esc('- ' + w); });
    }

    return html;
  }

  /* ---------- прежний табличный вариант (по желанию) ---------- */
  function listingTable(model) {
    if (model.empty) return 'Программа пуста: в памяти нет ни одной значащей ячейки.';

    var lines = [];
    var name = model.meta.name ? model.meta.name : 'Программа';
    lines.push('ЛИСТИНГ: ' + name + ' · ячеек ' + model.len);
    if (model.meta.saved) lines.push('файл от ' + model.meta.saved);
    lines.push('');
    lines.push('адр | код  | команда         | текст                                   | достоверность');
    lines.push('----+------+-----------------+-----------------------------------------+---------------');

    var printed = {};
    model.steps.forEach(function (s) {
      if (printed[s.addr]) return;

      var cmd, text, conf;

      if (s.kind === 'addr') {
        cmd = (s.code >= 0 && s.code <= 9) ? 'цифра адреса ' + s.code : 'цифра адреса (не цифра: 0x' + hex2(s.code) + ')';
        text = 'часть команды с адреса ' + pad2(s.partOf);
        conf = 'точно';
      } else if (s.kind === 'num') {
        s.parts.forEach(function (p) { printed[p.addr] = true; });
        cmd = 'ввод числа';
        text = 'X = ' + (s.text ? s.text.replace('X = ', '') : '?');
        conf = 'точно';
      } else if (s.kind === 'nop') {
        cmd = 'К НОП';
        text = 'пустой шаг';
        conf = 'точно';
      } else {
        if (s.parts) s.parts.forEach(function (p) { printed[p.addr] = true; });
        cmd = s.cmd;
        text = s.text ? s.text : 'НЕ ПЕРЕВЕДЕНО';
        conf = confLabel(s.conf);
      }

      lines.push(pad2(s.addr) + ' | 0x' + hex2(s.code) + ' | ' + padTo(cmd, 15) + ' | ' + padTo(text, 39) + ' | ' + conf);
    });

    if (model.warnings.length) {
      lines.push('');
      lines.push('ВНИМАНИЕ:');
      model.warnings.forEach(function (w) { lines.push('- ' + w); });
    }

    var unknown = model.steps.filter(function (s) { return s.conf === 'unknown'; });
    if (unknown.length) {
      lines.push('');
      lines.push('ЧТО НЕ ПЕРЕВЕДЕНО И ПОЧЕМУ:');
      unknown.forEach(function (s) {
        lines.push('шаг ' + pad2(s.addr) + ' · код 0x' + s.hex + ' · ' + s.cmd);
        (s.notes || []).forEach(function (n) { lines.push('   ' + n); });
      });
    }

    return lines.join('\n');
  }

  function render(model, mode, opts) {
    if (!model) return '';
    opts = opts || {};
    if (mode === 'listing') return opts.html ? listingHtml(model, opts) : listingText(model, opts);
    if (mode === 'listingTable') return listingTable(model);
    if (mode === 'brief') return briefText(model);
    return detailedText(model);
  }

  global.B3Decode = {
    decodeProgram: decodeProgram,
    render: render,
    parseHex: parseHex,
    fromProgramFile: fromProgramFile,
    cmdName: cmdName,
    hex2: hex2
  };
})(typeof window !== 'undefined' ? window : this);
