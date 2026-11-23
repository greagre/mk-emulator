/* =========================================================
   mk-emulator / ui.js
   Только показ и нажатия. Никаких вычислений:
   всё считает core, здесь лишь чтение состояния и отрисовка.

   Два режима:
     work  — «Работа»: корпус, дисплей, клавиатура, Пуск/Сброс.
     study — «Учёба»: плюс четыре вкладки
                      Числа · Регистры · Код · Журнал,
                      Шаг/Авто/00 и темп.
   ========================================================= */
(function () {
  'use strict';

  var MODELS = window.MKProfiles || {};
  var STORE_KEY = 'mk-emulator/state/';
  var MODE_KEY = 'mk-emulator/mode';
  var TAB_KEY = 'mk-emulator/tab';
  var TEMPO_KEY = 'mk-emulator/tempo';
  var RUN_LIMIT = 20000;
  var LOG_MAX = 100;

  /* Демонстрационная программа: 7! — 5040.
     R0 — счётчик цикла, R1 — накопитель. */
  var DEMO_FACT = [
    0x40,       /* 00  X→П 0 : n в счётчик   */
    0x01,       /* 01  1                      */
    0x41,       /* 02  X→П 1 : накопитель = 1 */
    0x61,       /* 03  П→X 1 : начало цикла   */
    0x60,       /* 04  П→X 0                  */
    0x12,       /* 05  ×                      */
    0x41,       /* 06  X→П 1                  */
    0x5D, 0x00, 0x03, /* 07  F L0 03          */
    0x61,       /* 10  П→X 1 : результат      */
    0x50        /* 11  С/П                    */
  ];

  var el = {
    model: document.getElementById('model'),
    modelName: document.getElementById('modelName'),
    lcd: document.getElementById('lcd'),
    mode: document.getElementById('stMode'),
    layer: document.getElementById('stLayer'),
    step: document.getElementById('stStep'),
    stack: document.getElementById('stack'),
    regs: document.getElementById('tabRegs'),
    keys: document.getElementById('keys'),
    prog: document.getElementById('prog'),
    hint: document.getElementById('hint'),
    service: document.getElementById('service'),
    tempo: document.getElementById('tempo'),
    tempoRow: document.getElementById('tempoRow'),
    status: document.getElementById('status'),
    modeseg: document.getElementById('modeseg'),
    tabs: document.getElementById('tabs'),
    log: document.getElementById('log'),
    logClear: document.getElementById('logClear'),
    logCount: document.getElementById('logCount')
  };

  var profile = null;
  var core = null;
  var pick = null;
  var storeKey = '';

  var uiMode = 'study';
  var uiTab = 'num';
  var autoTimer = null;
  var stepCount = 0;
  var journal = [];

  /* ---------- модели ---------- */
  function buildModelList() {
    var ids = Object.keys(MODELS);
    el.model.innerHTML = '';
    ids.forEach(function (id) {
      var o = document.createElement('option');
      o.value = id;
      o.textContent = MODELS[id].model;
      el.model.appendChild(o);
    });
    if (!ids.length) el.model.style.display = 'none';
  }

  function setModel(id) {
    profile = MODELS[id];
    if (!profile) return;
    storeKey = STORE_KEY + id;
    el.modelName.textContent = profile.model;
    core = window.MKCore.create({ onEvent: onEvent });
    pick = null;
    stepCount = 0;
    journal = [];
    stopAuto();
    loadState();
    render();
    setHint('Модель ' + profile.model + '. Клавиша f — второй слой, k — косвенные команды.');
  }

  /* ---------- режим Работа / Учёба ---------- */
  function setMode(mode, silent) {
    uiMode = (mode === 'work') ? 'work' : 'study';
    document.body.dataset.mode = uiMode;
    try { localStorage.setItem(MODE_KEY, uiMode); } catch (e) {}
    Array.prototype.forEach.call(el.modeseg.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.mode === uiMode);
    });
    if (uiMode === 'work') stopAuto();
    render();
    if (!silent) {
      setHint(uiMode === 'work'
        ? 'Режим «Работа»: клавиатура и Пуск. Переключись в «Учёбу», чтобы видеть листинг и шаги.'
        : 'Режим «Учёба»: вкладки Числа · Регистры · Код · Журнал, шаг с любого адреса и авто с темпом.');
    }
  }

  function loadMode() {
    var m = null;
    try { m = localStorage.getItem(MODE_KEY); } catch (e) {}
    setMode(m === 'work' ? 'work' : 'study', true);
  }

  /* ---------- вкладки Учёбы ---------- */
  var TABS = ['num', 'regs', 'code', 'log'];

  function setTab(tab, silent) {
    uiTab = (TABS.indexOf(tab) >= 0) ? tab : 'num';
    document.body.dataset.tab = uiTab;
    try { localStorage.setItem(TAB_KEY, uiTab); } catch (e) {}
    Array.prototype.forEach.call(el.tabs.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === uiTab);
    });
    renderPanes();
    if (!silent) {
      setHint(uiTab === 'num' ? 'Числа: стек X Y Z T X1.'
        : uiTab === 'regs' ? 'Регистры: R0…Rd. Меняются командами x→П и П→X, П→X, x→П.'
        : uiTab === 'code' ? 'Код: листинг программы. Нажми строку — шаг пойдёт с этого адреса.'
        : 'Журнал: что выполнилось и какие регистры изменились.');
    }
  }

  function loadTab() {
    var t = null;
    try { t = localStorage.getItem(TAB_KEY); } catch (e) {}
    setTab(t || 'num', true);
  }

  function renderPanes() {
    if (uiTab === 'num') renderStack();
    else if (uiTab === 'regs') renderRegs();
    else if (uiTab === 'code') renderProgram();
    else renderLog();
  }

  /* ---------- события ядра ---------- */
  function onEvent(type, data) {
    if (type === 'pick-register') {
      pick = { mode: (data && data.mode) || 'stox' };
      document.body.classList.toggle('picking', !!pick);
      /* выбрать регистр можно только на вкладке «Регистры» */
      if (uiMode === 'study' && uiTab !== 'regs') setTab('regs', true);
      render();
      setHint('Выбери регистр: ' + window.MKCore.REG_NAMES[0] + ' … ' + window.MKCore.REG_NAMES[window.MKCore.REG_COUNT - 1]);
      return;
    }
    if (type === 'hint' && typeof data === 'string') {
      setHint(data);
      return;
    }
    if (type === 'change' || type === 'error') render();
  }

  function setHint(text) {
    el.hint.textContent = text || '';
  }

  /* ---------- сохранение ---------- */
  function saveState() {
    try {
      localStorage.setItem(storeKey, JSON.stringify(core.snapshot()));
    } catch (e) { /* приватный режим — просто не сохраняем */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(storeKey);
      if (raw) core.restore(JSON.parse(raw));
    } catch (e) { /* битое состояние не должно мешать запуску */ }
  }

  /* ---------- отрисовка ---------- */
  function lcdText() {
    var st = core.ST;
    if (st.err) return 'ЕГГОГ';
    return core.fmt(st.X);
  }

  function pad2(n) {
    var s = String(n | 0);
    return s.length < 2 ? '0' + s : s;
  }

  function render() {
    if (!core) return;
    var st = core.ST;

    el.lcd.textContent = lcdText();
    el.lcd.classList.toggle('err', !!st.err);
    el.mode.textContent = st.mode === 'PRG' ? 'ПРГ' : 'АВТ';
    el.layer.textContent = st.layer === 'f' ? 'F' : (st.layer === 'k' ? 'K' : '—');
    el.step.textContent = pad2(st.ip);

    renderPanes();
    renderKeys();
    renderService();
    renderStatus();
    saveState();
  }

  function renderStack() {
    var st = core.ST;
    var rows = [
      ['X', lcdText()],
      ['Y', core.fmt(st.Y)],
      ['Z', core.fmt(st.Z)],
      ['T', core.fmt(st.T)],
      ['X1', core.fmt(st.X1)]
    ];
    el.stack.innerHTML = '';
    rows.forEach(function (row) {
      var d = document.createElement('div');
      d.className = 'cell' + (row[0] === 'X' ? ' cur' : '');
      var b = document.createElement('b');
      b.textContent = row[0];
      var s = document.createElement('span');
      s.textContent = row[1];
      d.appendChild(b);
      d.appendChild(s);
      el.stack.appendChild(d);
    });
  }

  function renderRegs() {
    var st = core.ST;
    el.regs.innerHTML = '';
    for (var i = 0; i < window.MKCore.REG_COUNT; i++) {
      (function (idx) {
        var d = document.createElement(pick ? 'button' : 'div');
        if (pick) d.type = 'button';
        d.className = 'reg' + (pick ? ' pick' : '');
        var b = document.createElement('b');
        b.textContent = window.MKCore.REG_NAMES[idx];
        var s = document.createElement('span');
        s.textContent = core.fmt(st.R[idx]);
        d.appendChild(b);
        d.appendChild(s);
        if (pick) {
          d.addEventListener('click', function () {
            var mode = pick.mode === 'stox' ? 'sto' : (pick.mode === 'loadx' ? 'ld' : 'k');
            pick = null;
            document.body.classList.remove('picking');
            core.key({ a: 'reg', r: idx, mode: mode });
            setHint('Регистр ' + window.MKCore.REG_NAMES[idx] + ' = ' + core.fmt(st.R[idx]));
            render();
          });
        }
        el.regs.appendChild(d);
      })(i);
    }
  }

  function renderKeys() {
    var layer = core.ST.layer || 'main';
    var keys = (profile.layers[layer] || profile.layers.main);
    el.keys.innerHTML = '';
    keys.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'key' + (k.cls ? ' ' + k.cls : '');
      if ((k.a === 'pref-f' && layer === 'f') || (k.a === 'pref-k' && layer === 'k')) {
        b.classList.add('on');
      }
      b.textContent = k.t;
      b.addEventListener('click', function () { press(k); });
      el.keys.appendChild(b);
    });
  }

  /* ---------- служебные кнопки по режиму ---------- */
  function mkBtn(text, handler, on) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (on) b.classList.add('on');
    b.addEventListener('click', handler);
    return b;
  }

  function renderService() {
    el.service.innerHTML = '';
    el.service.classList.toggle('wide', uiMode === 'work');

    if (uiMode === 'work') {
      el.service.appendChild(mkBtn('▶ Пуск', function () { runProgram(); render(); }));
      el.service.appendChild(mkBtn('⟲ Сброс', function () { doReset(); }));
      el.service.appendChild(mkBtn('Пример: 7!', function () { loadDemo(); }));
      el.service.appendChild(mkBtn('Очистить память', function () { clearProg(); }));
      return;
    }

    el.service.appendChild(mkBtn('Шаг ▶', function () { doStep(); }));
    el.service.appendChild(mkBtn(autoTimer ? '⏸ Стоп' : '▷ Авто', function () { toggleAuto(); }, !!autoTimer));
    el.service.appendChild(mkBtn('00', function () { setAddressZero(); }));
    el.service.appendChild(mkBtn('⟲ Сброс', function () { doReset(); }));
    el.service.appendChild(mkBtn('Пример: 7!', function () { loadDemo(); }));
    el.service.appendChild(mkBtn('Очистить память', function () { clearProg(); }));
  }

  function renderStatus() {
    if (!el.status) return;
    var MK = window.MKCore;
    el.status.innerHTML = '';
    var l = document.createElement('span');
    l.innerHTML = 'шаг <b>' + stepCount + '</b> · PC <b>' + pad2(core.ST.ip) + '</b> / ' + MK.PROG_LEN;
    var r = document.createElement('span');
    r.textContent = autoTimer ? 'авто ' + tempoSec() + ' с' : 'вручную';
    el.status.appendChild(l);
    el.status.appendChild(r);
  }

  /* ---------- листинг программы ---------- */
  function rowText(code, i) {
    var st = core.ST;
    var MK = window.MKCore;
    if (code === MK.NOP) return { label: '—', code: '', empty: true };

    if (MK.isJumpCmd(code)) {
      var a = st.prog[(i + 1) % MK.PROG_LEN];
      var b = st.prog[(i + 2) % MK.PROG_LEN];
      var ad = (a <= 9 && b <= 9) ? (a * 10 + b) : -1;
      return {
        label: MK.cmdName(code) + (ad >= 0 ? ' → ' + pad2(ad) : ' → ??'),
        code: MK.codeStr(code) + ' ' + a + b,
        empty: false
      };
    }
    return { label: MK.cmdName(code), code: MK.codeStr(code), empty: false };
  }

  function renderProgram() {
    if (!el.prog) return;
    var st = core.ST;
    var MK = window.MKCore;
    var last = core.lastStep();

    var end = Math.max(last + 1, st.ip + 1, 12);
    if (end > MK.PROG_LEN) end = MK.PROG_LEN;

    el.prog.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'prog-head';
    var left = document.createElement('span');
    left.textContent = 'Программа';
    var right = document.createElement('span');
    right.innerHTML = 'адрес <b>' + pad2(st.ip) + '</b> · занято <b>' + Math.max(last + 1, 0) + '</b> из ' + MK.PROG_LEN;
    head.appendChild(left);
    head.appendChild(right);
    el.prog.appendChild(head);

    var i = 0;
    while (i < end) {
      var code = st.prog[i] & 255;
      var info = rowText(code, i);
      var wide = (code !== MK.NOP && MK.isJumpCmd(code)) ? 3 : 1;

      var row = document.createElement('div');
      row.className = 'prow' + (info.empty ? ' empty' : '') + (i === st.ip ? ' cur' : '');

      var a = document.createElement('span');
      a.className = 'paddr';
      a.textContent = pad2(i);

      var t = document.createElement('span');
      t.className = 'plabel';
      t.textContent = info.label;

      var c = document.createElement('span');
      c.className = 'pcode';
      c.textContent = info.code;

      row.appendChild(a);
      row.appendChild(t);
      row.appendChild(c);

      (function (addr, label, empty) {
        row.addEventListener('click', function () {
          core.ST.ip = addr;
          setHint('Адрес ' + pad2(addr) + (empty ? ' — пустая ячейка' : ': ' + label));
          render();
        });
      })(i, info.label, info.empty);

      el.prog.appendChild(row);
      i += wide;
    }

    var cur = el.prog.querySelector('.prow.cur');
    if (cur && uiMode === 'study' && el.prog.scrollHeight > el.prog.clientHeight) {
      var top = cur.offsetTop - el.prog.clientHeight / 2;
      el.prog.scrollTop = Math.max(0, top);
    }
  }

  /* ---------- журнал шагов ---------- */
  function snap() {
    var st = core.ST;
    var R = [];
    for (var i = 0; i < window.MKCore.REG_COUNT; i++) R.push(st.R[i] & 255);
    return { R: R, X: st.X, ip: st.ip };
  }

  function collectDiff(before) {
    var st = core.ST;
    var out = [];
    for (var i = 0; i < window.MKCore.REG_COUNT; i++) {
      var now = st.R[i] & 255;
      if (now !== before.R[i]) {
        out.push(window.MKCore.REG_NAMES[i] + ' ' + core.fmt(before.R[i]) + '→' + core.fmt(now));
      }
    }
    if ((st.X & 255) !== (before.X & 255) || Math.abs(st.X - before.X) > 1e-12) {
      out.push('X ' + core.fmt(before.X) + '→' + core.fmt(st.X));
    }
    return out;
  }

  function journalAdd(before, label, result) {
    var st = core.ST;
    var diff = collectDiff(before);
    if (st.ip !== before.ip) diff.push('→ ' + pad2(st.ip));
    var note = '';
    if (result === 'stop') note = 'С/П';
    else if (result === 'error') note = 'ошибка';

    journal.push({
      n: stepCount,
      addr: before.ip,
      label: label,
      diff: diff,
      note: note,
      err: result === 'error'
    });
    if (journal.length > LOG_MAX) journal.shift();
  }

  function renderLog() {
    if (!el.log) return;
    if (el.logCount) el.logCount.textContent = String(journal.length);
    el.log.innerHTML = '';

    if (!journal.length) {
      var e = document.createElement('div');
      e.className = 'logempty';
      e.textContent = 'Пусто. Загрузи пример и жми «Шаг ▶» или «▷ Авто» — здесь появятся выполненные команды.';
      el.log.appendChild(e);
      return;
    }

    journal.forEach(function (rec) {
      var row = document.createElement('div');
      row.className = 'logrow' + (rec.err ? ' err' : '');

      var n = document.createElement('span');
      n.className = 'lnum';
      n.textContent = '#' + rec.n;

      var a = document.createElement('span');
      a.className = 'laddr';
      a.textContent = pad2(rec.addr);

      var l = document.createElement('span');
      l.className = 'llab';
      l.textContent = rec.label + (rec.note ? ' · ' + rec.note : '');

      var d = document.createElement('span');
      d.className = 'ldiff' + (rec.diff.length ? '' : ' dim');
      d.textContent = rec.diff.length ? rec.diff.join(' · ') : 'без изменений';

      row.appendChild(n);
      row.appendChild(a);
      row.appendChild(l);
      row.appendChild(d);
      el.log.appendChild(row);
    });

    el.log.scrollTop = el.log.scrollHeight;
  }

  function clearJournal(silent) {
    journal = [];
    renderLog();
    if (!silent) setHint('Журнал шагов очищен');
  }

  /* ---------- нажатия ---------- */
  function press(k) {
    var isSp = (k.a === 'sp');
    var before = core.ST.run ? null : null;
    core.key(k);

    /* С/П в автоматическом режиме запускает прогон программы */
    if (isSp && core.ST.run) {
      runProgram();
    }
    render();
  }

  function stepOnce() {
    var before = snap();
    var code = core.ST.prog[core.ST.ip] & 255;
    var info = rowText(code, core.ST.ip);
    var r = core.step();
    stepCount++;
    journalAdd(before, info.empty ? 'пустая ячейка' : info.label, r);
    return r;
  }

  function runProgram() {
    stopAuto();
    var steps = 0;
    var overflow = false;
    var err = false;

    while (steps < RUN_LIMIT) {
      var r = stepOnce();
      steps++;
      if (r === 'stop') break;
      if (r === 'error') { err = true; break; }
    }
    if (steps >= RUN_LIMIT) overflow = true;

    if (overflow) {
      setHint('Остановлено по лимиту шагов (' + RUN_LIMIT + ') — похоже на вечный цикл');
    } else if (err) {
      setHint('Ошибка выполнения на шаге ' + steps + ' · адрес ' + pad2(core.ST.ip));
    } else {
      setHint('Остановка на адресе ' + pad2(core.ST.ip) + ' · шагов: ' + steps + ' · X = ' + core.fmt(core.ST.X));
    }
    render();
  }

  function doStep() {
    var r = stepOnce();
    if (r === 'stop') setHint('С/П на адресе ' + pad2(core.ST.ip));
    else if (r === 'error') setHint('Ошибка выполнения на адресе ' + pad2(core.ST.ip));
    else setHint('Шаг выполнен · адрес ' + pad2(core.ST.ip));
    render();
  }

  function doReset() {
    stopAuto();
    core.reset(false);
    pick = null;
    document.body.classList.remove('picking');
    stepCount = 0;
    journal = [];
    setHint('Сброшено: стек, регистры, адрес 00 и журнал шагов');
    render();
  }

  function setAddressZero() {
    stopAuto();
    core.ST.ip = 0;
    setHint('Счётчик команд на адресе 00');
    render();
  }

  function clearProg() {
    stopAuto();
    core.clearProgram();
    core.ST.ip = 0;
    stepCount = 0;
    journal = [];
    setHint('Программная память очищена, адрес 00');
    render();
  }

  function loadDemo() {
    stopAuto();
    core.setProgram(DEMO_FACT, false);
    core.setX(7);
    pick = null;
    document.body.classList.remove('picking');
    stepCount = 0;
    journal = [];
    setHint('Пример 7! в памяти: R0 = 7. Нажми «Пуск» — должно получиться 5040.');
    render();
  }

  /* ---------- авто-прогон с темпом ---------- */
  function tempoSec() {
    return parseInt(el.tempo && el.tempo.value, 10) || 0;
  }

  function toggleAuto() {
    if (autoTimer) {
      stopAuto();
      setHint('Авто остановлено на адресе ' + pad2(core.ST.ip));
      render();
      return;
    }
    var sec = tempoSec();
    if (!sec) {
      setHint('Темп «вручную»: жми «Шаг ▶» по одной команде.');
      return;
    }
    autoTimer = setInterval(function () {
      var r = stepOnce();
      render();
      if (r === 'stop' || r === 'error') {
        stopAuto();
        setHint(r === 'stop'
          ? 'Авто: С/П на адресе ' + pad2(core.ST.ip) + ' · X = ' + core.fmt(core.ST.X)
          : 'Авто: ошибка на адресе ' + pad2(core.ST.ip));
        render();
      }
    }, sec * 1000);
    setHint('Авто: шаг каждые ' + sec + ' с · журнал пополняется');
    render();
  }

  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  }

  /* ---------- обработчики вне клавиатуры ---------- */
  el.model.addEventListener('change', function () {
    try { localStorage.removeItem(storeKey); } catch (e) {}
    setModel(el.model.value);
  });

  el.modeseg.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  el.tabs.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });

  if (el.logClear) {
    el.logClear.addEventListener('click', function () { clearJournal(); });
  }

  if (el.tempo) {
    el.tempo.addEventListener('change', function () {
      try { localStorage.setItem(TEMPO_KEY, el.tempo.value); } catch (e) {}
      if (autoTimer) { stopAuto(); toggleAuto(); } else renderStatus();
    });
  }

  /* ---------- старт ---------- */
  buildModelList();
  setModel(el.model.value || Object.keys(MODELS)[0]);
  try {
    var savedTempo = localStorage.getItem(TEMPO_KEY);
    if (savedTempo && el.tempo) el.tempo.value = savedTempo;
  } catch (e) {}
  loadMode();
  loadTab();
})();
