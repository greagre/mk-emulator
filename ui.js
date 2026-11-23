/* =========================================================
   mk-emulator / ui.js
   Только показ и нажатия. Никаких вычислений:
   всё считает core, здесь лишь чтение состояния и отрисовка.

   Два режима:
     work  — «Работа»: корпус, дисплей, клавиатура, Пуск/Сброс.
     study — «Учёба»: плюс стек, регистры, листинг, Шаг/Авто/00.
   ========================================================= */
(function () {
  'use strict';

  var MODELS = window.MKProfiles || {};
  var STORE_KEY = 'mk-emulator/state/';
  var MODE_KEY = 'mk-emulator/mode';
  var TEMPO_KEY = 'mk-emulator/tempo';
  var RUN_LIMIT = 200000;

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
    regs: document.getElementById('regs'),
    keys: document.getElementById('keys'),
    prog: document.getElementById('prog'),
    hint: document.getElementById('hint'),
    service: document.getElementById('service'),
    tempo: document.getElementById('tempo'),
    tempoRow: document.getElementById('tempoRow'),
    status: document.getElementById('status'),
    modeseg: document.getElementById('modeseg')
  };

  var profile = null;
  var core = null;
  var pick = null;
  var storeKey = '';

  var uiMode = 'study';
  var autoTimer = null;
  var stepCount = 0;

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
        : 'Режим «Учёба»: стек, регистры, листинг, шаг с любого адреса и авто-прогон с темпом.');
    }
  }

  function loadMode() {
    var m = null;
    try { m = localStorage.getItem(MODE_KEY); } catch (e) {}
    setMode(m === 'work' ? 'work' : 'study', true);
  }

  /* ---------- события ядра ---------- */
  function onEvent(type, data) {
    if (type === 'pick-register') {
      pick = { mode: (data && data.mode) || 'stox' };
      document.body.classList.toggle('picking', !!pick);
      render();
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

    renderStack();
    renderRegs();
    renderKeys();
    renderService();
    renderStatus();
    renderProgram();
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

  /* ---------- нажатия ---------- */
  function press(k) {
    core.key(k);

    /* С/П и ПП в автоматическом режиме запускают прогон программы */
    if ((k.a === 'sp' && core.ST.run) || k.a === 'pp') {
      if (core.ST.run) runProgram();
    }
    render();
  }

  function runProgram() {
    var res = core.run(RUN_LIMIT);
    stepCount += (res && res.steps) || 0;
    if (res.overflow) {
      setHint('Остановлено по лимиту шагов (' + RUN_LIMIT + ') — похоже на вечный цикл');
    } else if (res.err) {
      setHint('Ошибка на шаге ' + res.steps);
    } else {
      setHint('Остановка на адресе ' + pad2(core.ST.ip) + ' · шагов: ' + res.steps + ' · X = ' + core.fmt(core.ST.X));
    }
  }

  function doStep() {
    var r = core.step();
    stepCount++;
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
    setHint('Сброшено: стек, регистры и адрес 00');
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
    setHint('Пример 7! в памяти: R0 = 7. Нажми «Пуск» — должно получиться 5040.');
    render();
  }

  /* ---------- авто-прогон с темпом ---------- */
  function tempoSec() {
    return parseInt(el.tempo && el.tempo.value, 10) || 0;
  }

  function toggleAuto() {
    if (autoTimer) { stopAuto(); setHint('Авто остановлено на адресе ' + pad2(core.ST.ip)); render(); return; }
    var sec = tempoSec();
    if (!sec) { setHint('Темп «вручную»: жми «Шаг ▶» по одной команде.'); return; }
    autoTimer = setInterval(function () {
      var r = core.step();
      stepCount++;
      render();
      if (r === 'stop' || r === 'error') {
        stopAuto();
        setHint(r === 'stop'
          ? 'Авто: С/П на адресе ' + pad2(core.ST.ip) + ' · X = ' + core.fmt(core.ST.X)
          : 'Авто: ошибка на адресе ' + pad2(core.ST.ip));
        render();
      }
    }, sec * 1000);
    setHint('Авто: шаг каждые ' + sec + ' с');
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

  if (el.tempo) {
    el.tempo.addEventListener('change', function () {
      try { localStorage.setItem(TEMPO_KEY, el.tempo.value); } catch (e) {}
      if (autoTimer) { stopAuto(); toggleAuto(); } else renderTitleOnly();
    });
  }

  function renderTitleOnly() {
    renderStatus();
  }

  /* ---------- старт ---------- */
  buildModelList();
  setModel(el.model.value || Object.keys(MODELS)[0]);
  try {
    var savedTempo = localStorage.getItem(TEMPO_KEY);
    if (savedTempo && el.tempo) el.tempo.value = savedTempo;
  } catch (e) {}
  loadMode();
})();
