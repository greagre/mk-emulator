#!/usr/bin/env node
/**
 * publish.cjs — публикация разобранных программ МК/Б3-34 в наш проект.
 *
 * Читает каталог MKPro/readable (после scripts/export-readable.cjs),
 * проверяет пять условий готовности и раскладывает результат:
 *
 *   programs/mk61/*.json      — для импорта в корпус (format:"programs", version:2)
 *   programs/mk61/*.txt       — читаемый листинг (тот же, для ручного ввода)
 *   programs/b3-34/*         — то же для 98-шаговой модели
 *   programs/_unresolved/    — не прошло условия, причина в первой строке TXT
 *   programs/_catalog.json   — список: имя, модель, раздел, статус
 *
 * Один проход даёт оба файла, поэтому JSON и TXT разойтись не могут.
 * Использование:
 *   node publish.cjs --src ../MKPro/readable [--out ./programs]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const SRC = path.resolve(arg('src', path.join(__dirname, '..', 'MKPro', 'readable')));
const OUT = path.resolve(arg('out', path.join(__dirname, 'programs')));

const SECTIONS = [
  'action', 'adventure', 'arcade', 'educational', 'gambling',
  'logic', 'simulation', 'sports', 'strategy', 'utilities'
];

// ---------- разбор листинга ----------------------------------------------------

/**
 * Строка листинга вида «00   04   КНОП» или с хвостом-комментарием:
 * «31   5D   FL0 мутант и Шреддер будут сильнее»
 * Возвращает {addr, code, cmd, comment} либо null.
 */
function parseStepLine(line) {
  const m = line.match(/^\s*(-?\d{1,3})\s+([0-9A-Fa-f]{2})\s+(.*)$/);
  if (!m) return null;
  const addr = parseInt(m[1], 10);
  const code = parseInt(m[2], 16);
  let tail = (m[3] || '').trim();

  // Команда — до первого пробела перед кириллицей/«длинным» текстом.
  let cmd = tail;
  let comment = '';
  const cut = tail.search(/\s(?=[А-Яа-яЁё])/);
  const cut2 = tail.search(/\s\S+\s\S+\s\S+/); // три и больше слов — точно не команда
  const at = cut >= 0 ? cut : cut2;
  if (at >= 0) {
    cmd = tail.slice(0, at).trim();
    comment = tail.slice(at).trim();
  }
  return { addr, code, cmd, comment };
}

/** Разбор раздела «Перед пуском: …» → список входных значений. */
function parseInputs(text) {
  const m = text.match(/Перед пуском\s*:\s*([^\n]+)/i);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw || /^(нет|—|-|пусто)$/i.test(raw)) return [];
  return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

/** Разбор файла раздела в одну или несколько программ. */
function parseFile(fileText) {
  const lines = fileText.split(/\r?\n/);
  const steps = [];
  const comments = [];
  const warnings = [];
  let secondPass = false;
  let seenAddr = new Set();

  for (const line of lines) {
    const st = parseStepLine(line);
    if (!st) continue;

    // Второй проход листинга: адреса −0…−4 повторяются сразу пятёркой.
    if (seenAddr.has(st.addr)) {
      if (st.addr <= -0) { secondPass = true; }
      else warnings.push('адрес ' + st.addr + ' повторён');
    }
    seenAddr.add(st.addr);

    if (!st.cmd) warnings.push('шаг ' + st.addr + ': нет команды');
    if (st.comment) comments.push({ addr: st.addr, text: st.comment });

    steps.push({ addr: st.addr, code: st.code, cmd: st.cmd });
  }

  // Структурный повтор пятёрки — это не замечание файла, а двойная запись листинга.
  const realWarn = warnings.filter(w => !/^адрес -\d+ повторён$/.test(w));

  return {
    steps,
    comments,
    inputs: parseInputs(fileText),
    secondPass,
    warnings: realWarn,
    programsCount: 1
  };
}

// ---------- условия готовности -------------------------------------------------

function checkReady(parsed) {
  const reasons = [];
  if (!parsed.steps.length) reasons.push('листинг не найден');

  const bad = parsed.steps.filter(s => !/^[\x20-\x7EА-Яа-яЁё↑↓↔↕√∫×÷°⁻¹²³π ]+$/.test(s.cmd || ''));
  if (bad.length) reasons.push('не распознано команд: ' + bad.length);

  const addrs = parsed.steps.map(s => s.addr).filter(a => a >= 0);
  for (let i = 1; i < addrs.length; i++) {
    if (addrs[i] !== addrs[i - 1] + 1) {
      reasons.push('адреса не подряд: ' + addrs[i - 1] + ' → ' + addrs[i]);
      break;
    }
  }
  if (parsed.warnings.length) reasons.push(...parsed.warnings);

  return reasons;
}

// ---------- модель -------------------------------------------------------------

function detectModel(parsed) {
  const last = parsed.steps.reduce((a, s) => Math.max(a, s.addr), 0);
  const hasK = parsed.steps.some(s => /(^|\s)К/.test(s.cmd || ''));
  if (last <= 97 && !hasK) return 'b3-34';
  return 'mk61';
}

// ---------- запись -------------------------------------------------------------

function pad(n, w) { return String(n).padStart(w, ' '); }

function renderTxt(rec) {
  const out = [];
  out.push(rec.name);
  out.push('Модель: ' + rec.model);
  out.push('Перед пуском: ' + (rec.inputs.length ? rec.inputs.join(', ') : 'нет'));
  out.push('Ожидаемый результат: ' + (rec.result || 'см. описание источника'));
  out.push('');
  out.push('ЛИСТИНГ');
  for (const s of rec.prog) {
    out.push(pad(s.addr, 4) + '  ' + pad(s.code.toString(16).toUpperCase().padStart(2, '0'), 3) + '  ' + s.cmd);
  }
  if (rec.comments.length) {
    out.push('');
    out.push('КОММЕНТАРИИ АВТОРА');
    for (const c of rec.comments) out.push(pad(c.addr, 4) + '  — ' + c.text);
  }
  return out.join('\n') + '\n';
}

function renderJson(rec) {
  return JSON.stringify({
    app: 'mk-emulator',
    format: 'programs',
    version: 2,
    model: rec.model,
    saved: new Date().toISOString().slice(0, 10),
    programs: [{
      name: rec.name,
      prog: rec.prog.map(s => s.code),
      data: rec.data || {},
      inputs: rec.inputs,
      layout: {},
      src: rec.prog.map(s => pad(s.addr, 4) + '  ' + pad(s.code.toString(16).toUpperCase().padStart(2, '0'), 3) + '  ' + s.cmd).join('\n'),
      savedAt: new Date().toISOString()
    }]
  }, null, 2) + '\n';
}

// ---------- главный проход -----------------------------------------------------

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Нет исходного каталога: ' + SRC);
    console.error('Укажи --src путь/к/MKPro/readable');
    process.exit(1);
  }

  fs.mkdirSync(path.join(OUT, 'mk61'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'b3-34'), { recursive: true });
  fs.mkdirSync(path.join(OUT, '_unresolved'), { recursive: true });

  const catalog = [];
  let total = 0, ready = 0, unresolved = 0;

  for (const section of SECTIONS) {
    const dir = path.join(SRC, section);
    if (!fs.existsSync(dir)) continue;

    for (const fname of fs.readdirSync(dir)) {
      if (!/\.txt$/i.test(fname)) continue;
      total++;
      const full = path.join(dir, fname);
      const text = fs.readFileSync(full, 'utf8');
      const name = fname.replace(/\.txt$/i, '').replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());
      const parsed = parseFile(text);
      const reasons = checkReady(parsed);

      const rec = {
        name,
        section,
        model: detectModel(parsed),
        inputs: parsed.inputs,
        prog: parsed.steps,
        comments: parsed.comments,
        data: {}
      };

      if (reasons.length) {
        unresolved++;
        const dirU = path.join(OUT, '_unresolved', section);
        fs.mkdirSync(dirU, { recursive: true });
        const head = fname.replace(/\.txt$/i, '');
        fs.writeFileSync(
          path.join(dirU, head + '.txt'),
          'НЕ РАЗОБРАНО: ' + reasons.join('; ') + '\n\n' + renderTxt(rec),
          'utf8'
        );
        catalog.push({ name, section, model: rec.model, status: 'не разобрано', reason: reasons.join('; ') });
      } else {
        ready++;
        const dirR = path.join(OUT, rec.model);
        const base = fname.replace(/\.txt$/i, '');
        fs.writeFileSync(path.join(dirR, base + '.json'), renderJson(rec), 'utf8');
        fs.writeFileSync(path.join(dirR, base + '.txt'), renderTxt(rec), 'utf8');
        catalog.push({
          name, section, model: rec.model, status: 'готово',
          json: rec.model + '/' + base + '.json',
          txt: rec.model + '/' + base + '.txt'
        });
      }
    }
  }

  fs.writeFileSync(
    path.join(OUT, '_catalog.json'),
    JSON.stringify({ generated: new Date().toISOString(), total, ready, unresolved, programs: catalog }, null, 2) + '\n',
    'utf8'
  );

  console.log('Всего файлов:      ' + total);
  console.log('Готово:            ' + ready);
  console.log('В _unresolved:     ' + unresolved);

  const groups = {};
  for (const c of catalog.filter(c => c.status !== 'готово')) {
    for (const r of c.reason.split('; ')) {
      const key = r.replace(/\d+/g, 'N').slice(0, 60);
      groups[key] = (groups[key] || 0) + 1;
    }
  }
  console.log('\nПочему не разобрано:');
  Object.entries(groups).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + v + ' × ' + k));
}

main();
