/* =========================================================
   mk-emulator / ui.js
   Только показ и нажатия. Никаких вычислений:
   всё считает core, здесь лишь чтение состояния и отрисовка.
   ========================================================= */
(function () {
  'use strict';

  var MODELS = window.MKProfiles || {};
  var STORE_KEY = 'mk-emulator/state/';
  var RUN_LIMIT = 200000;

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
    hint: document.getElementById('hint')
  };

  var profile = null;
  var core = null;
  var pick = null;
  var storeKey = '';

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
    loadState();
    render();
    setHint('Модель ' + profile.model + '. Клавиша f — второй слой, k — косвенные команды.');
  }

  /* ---------- события ядра ---------- */
  function onEvent(type, data) {
    if (type === 'pick-register') {
      pick = { mode: (data && data.mode) || 'stox' };
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
    if (res.overflow) {
      setHint('Остановлено по лимиту шагов (' + RUN_LIMIT + ') — похоже на вечный цикл');
    } else if (res.err) {
      setHint('Ошибка на шаге ' + res.steps);
    } else {
      setHint('Остановка на адресе ' + pad2(core.ST.ip) + ' · шагов: ' + res.steps);
    }
  }

  /* ---------- служебные кнопки ---------- */
  document.getElementById('btnStep').addEventListener('click', function () {
    var r = core.step();
    if (r === 'stop') setHint('С/П на адресе ' + pad2(core.ST.ip));
    else if (r === 'error') setHint('Ошибка выполнения на адресе ' + pad2(core.ST.ip));
    render();
  });

  document.getElementById('btnRun').addEventListener('click', function () {
    runProgram();
    render();
  });

  document.getElementById('btnReset').addEventListener('click', function () {
    core.reset(false);
    pick = null;
    setHint('Сброшено: стек, регистры и адрес 00');
    render();
  });

  el.model.addEventListener('change', function () {
    try { localStorage.removeItem(storeKey); } catch (e) {}
    setModel(el.model.value);
  });

  /* ---------- старт ---------- */
  buildModelList();
  setModel(el.model.value || Object.keys(MODELS)[0]);
})();
