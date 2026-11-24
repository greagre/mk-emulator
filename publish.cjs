#!/usr/bin/env node
/**
 * publish.cjs — ревизия 2. Публикация разобранных программ Б3-34/МК-61.
 *
 * Читает каталог MKPro/readable (после scripts/export-readable.cjs),
 * проверяет условия готовности и раскладывает результат:
 *
 *   programs/b3-34/*.json|*.txt   — программы линии 34 (до 98 шагов)
 *   programs/mk61/*.json|*.txt    — программы линии 61 (до 105 шагов)
 *   programs/_unresolved/<раздел>/ — не прошло, причина в первой строке
 *   programs/_unresolved/_details/ — полные причины (не больше 200 знаков в каталоге)
 *   programs/_catalog.json         — имя, серия, модель, шаги, статус
 *
 * Ревизия 2 — что изменено против ревизии 1:
 *   1. Модель определяется по объёму (адрес последнего шага), а не по букве «К».
 *      Старое правило считало «КНОП» K-функцией и штамповало МК-61 всем.
 *   2. Нормализация начертаний: FLO/FO/Fo → F0, Fѻ → F eˣ, FѺ/F круг → F◯,
 *      Ftgᐨ¹ → F tg⁻¹, «К 2» → «К2», «3ВП» → «3 ВП», русская «х» в П→х → x.
 *   3. Одиночный символ — обрывок текста, а не команда: адрес занимает место,
 *      но шагом не считается и в замечания не идёт.
 *   4. Пропуск ровно одного адреса (92 на месте 91) принимается молча и уходит
 *      в структуру; настоящий сдвиг (75 на месте 19) остаётся замечанием.
 *   5. Замыкающее В/О после последнего шага не считается шагом (снимает «106 из 105»).
 *   6. Многосоставный файл делится по повтору адреса 00: имя-2, имя-3…
 *   7. Причина в каталоге — одна строка до 200 знаков; полный текст отдельным файлом.
 *   8. Шаги считаются по адресам, а не по числу распознанных строк.
 *
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

const LINE_34 = 98;   // 00…97
const LINE_61 = 105;  // 00…104
const MAX_REASON = 200;

// ---------- серии: чтобы редакции одной игры не терялись ----------------------

const SERIES = [
  [/kon-?tiki|lunolet|gravilet|kepler|mascon/i, 'Kon-Tiki'],
  [/morskoy-boy|sea-battle|morskoe-srazhenie/i, 'Морской бой'],
  [/^karate/i, 'Каратэ'],
  [/^menedzher|^manager/i, 'Менеджер'],
  [/trenirovka-pamyati|memory-training/i, 'Тренировка памяти'],
  [/^bitva/i, 'Битва'],
  [/^elite|^elita/i, 'Elite'],
  [/^beskonechnaya-istoriya/i, 'Бесконечная история'],
  [/^lovkach|^vorishka|^treasure-cave/i, 'Ловкач'],
  [/^domino/i, 'Домино'],
  [/^chest|^chot-nechot|^naval-battle/i, 'Чёт-нечёт']
];

function detectSeries(base) {
  for (const [re, name] of SERIES) if (re.test(base)) return name;
  return '';
}

// ---------- нормализация команд ----------------------------------------------

const NORMALIZE = [
  [/^FLO$/, 'FL0'],
  [/^FO$/, 'F0'],
  [/^Fo$/, 'F0'],
  [/^Ffl$/, 'F◯'],
  [/^Fѻ$/, 'F eˣ'],
  [/^FѺ$/, 'F◯'],
  [/^F\s*круг$/i, 'F◯'],
  [/^Ftg[ᐨ\-^]*1$/, 'F tg⁻¹'],
  [/^Ftg\^?-?\^?1$/, 'F tg⁻¹'],
  [/^3ВП$/, '3 ВП'],
  [/^К 2$/, 'К2'],
  [/^К 1$/, 'К1'],
  [/^К 3$/, 'К3'],
  [/^К П→х$/, 'К П→x'],
  [/^П→х$/, 'П→x'],
  [/^Пх$/, 'Пx'],
  [/^Кх$/, 'Кx'],
  [/^Fx>0$/, 'F x>0'],
  [/^Fx≥0$/, 'F x≥0'],
  [/^Fx<0$/, 'F x<0'],
  [/^Kx>00$/, 'K x≥0']
];

const LONE = /^[A-Za-zА-Яа-яЁё]$/;

function normalizeCmd(raw) {
  let s = String(raw || '').trim();
  if (!s) return { cmd: '', fragment: false };
  s = s.replace(/\s+/g, ' ');

  // одиночная буква — обрывок текста из источника, а не команда
  if (LONE.test(s)) return { cmd: '', fragment: true };

  // русская «х» вместо латинской в регистровых командах
  if (/→х/.test(s) || /^[ПК]х/.test(s) || /^К\s*П/.test(s)) {
    s = s.replace(/х/g, 'x');
  }

  for (const [re, to] of NORMALIZE) {
    if (re.test(s)) { s = to; break; }
  }
  return { cmd: s, fragment: false };
}

// ---------- разбор листинга ----------------------------------------------------

/**
 * Строка листинга: «00   04   КНОП» или с хвостом-примечанием:
 * «31   5D   FL0 мутант и Шреддер будут сильнее»
 */
function parseStepLine(line) {
  const m = line.match(/^\s*(-?\d{1,3})\s+([0-9A-Fa-f]{2})\s+(.*)$/);
  if (!m) return null;
  const addr = parseInt(m[1], 10);
  const code = parseInt(m[2], 16);
  const tail = (m[3] || '').trim();

  // Команда — до первого пробела перед кириллицей, но не длиннее трёх токенов.
  let cmd = tail;
  let comment = '';
  const cut = tail.search(/\s(?=[А-Яа-яЁё])/);
  const cut2 = tail.search(/\s\S+\s\S+\s\S+/);
  const at = cut >= 0 ? cut : cut2;
  if (at >= 0) {
    cmd = tail.slice(0, at).trim();
    comment = tail.slice(at).trim();
  }
  return { addr, code, cmd, comment };
}

function parseInputs(text) {
  const m = text.match(/Перед пуском\s*:\s*([^\n]+)/i);
  if (!m) return [];
  const raw = m[1].trim();
  if (!raw || /^(нет|—|-|пусто)$/i.test(raw)) return [];
  return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
}

/**
 * Разбор файла в одну или несколько программ.
 * Новая программа начинается при повторе адреса 00 после того,
 * как уже набрано не меньше пяти шагов (так выглядят файлы с «Программа 2»).
 */
function parseFile(fileText) {
  const lines = fileText.split(/\r?\n/);
  const programs = [];

  let cur = { steps: [], comments: [], fragments: 0, skipAddr: [] };
  let seen = new Set();
  let closedVo = 0;

  const flush = () => {
    if (cur.steps.length) programs.push(cur);
    cur = { steps: [], comments: [], fragments: 0, skipAddr: [] };
    seen = new Set();
  };

  for (const line of lines) {
    const st = parseStepLine(line);
    if (!st) continue;

    if (st.addr === 0 && cur.steps.length >= 5) flush();

    const { cmd, fragment } = normalizeCmd(st.cmd);
    if (fragment) {
      cur.fragments++;
      if (!cmd && st.cmd && !cur.comments.some(c => c.addr === st.addr)) {
        cur.comments.push({ addr: st.addr, text: st.cmd + ' (обрывок текста в листинге)' });
      }
    }
    if (st.comment) cur.comments.push({ addr: st.addr, text: st.comment });

    // Второй проход листинга: адреса −0…−4 идут повторной пятёркой.
    const secondPass = st.addr < 0;

    if (!secondPass && seen.has(st.addr) && st.addr !== 0) {
      cur.skipAddr.push(st.addr);
    }
    seen.add(st.addr);

    cur.steps.push({ addr: st.addr, code: st.code, cmd, fragment: fragment || !cmd });
  }
  flush();

  // Замыкающее В/О после последнего шага в отрицательной ячейке — не шаг программы.
  for (const p of programs) {
    while (p.steps.length >= 2) {
      const last = p.steps[p.steps.length - 1];
      const prev = p.steps[p.steps.length - 2];
      if (last.cmd === 'В/О' && last.addr <= 0 && prev.addr >= LINE_34) {
        p.steps.pop();
        closedVo++;
      } else break;
    }
  }

  return { programs, inputs: parseInputs(fileText), closedVo, secondPass: /^\s*-\d/m.test(fileText) };
}

// ---------- условия готовности -------------------------------------------------

function checkReady(prog) {
  const reasons = [];
  const real = prog.steps.filter(s => !s.fragment);

  if (!prog.steps.length) {
    reasons.push('листинг не найден');
    return reasons;
  }
  if (!real.length) {
    reasons.push('ни одной распознанной команды');
    return reasons;
  }
  if (prog.fragments) {
    reasons.push('обрывков текста на месте команд: ' + prog.fragments);
  }

  // Адреса: пропуск ровно одного номера — принято, больше — замечание.
  const addrs = prog.steps.filter(s => s.addr >= 0).map(s => s.addr);
  const skipped = [];
  for (let i = 1; i < addrs.length; i++) {
    const d = addrs[i] - addrs[i - 1];
    if (d === 1) continue;
    if (d === 2) { skipped.push(addrs[i - 1] + 1); continue; }
    reasons.push('адреса не подряд: ' + addrs[i - 1] + ' → ' + addrs[i]);
    break;
  }
  if (prog.skipAddr.length) {
    reasons.push('адрес на месте уже занятого: ' + prog.skipAddr.slice(0, 3).join(', '));
  }

  return reasons;
}

// ---------- модель -------------------------------------------------------------

/**
 * Модель — по объёму памяти, а не по наличию буквы «К»:
 * старое правило считало «КНОП» K-функцией и всем ставило МК-61.
 */
function detectModel(prog) {
  const maxAddr = prog.steps.reduce((a, s) => Math.max(a, s.addr), 0);
  const len = maxAddr + 1;
  return len <= LINE_34 ? 'b3-34' : 'mk61';
}

// ---------- запись -------------------------------------------------------------

function pad(n, w) { return String(n).padStart(w, ' '); }
function hex(code) { return code.toString(16).toUpperCase().padStart(2, '0'); }

function renderTxt(rec) {
  const out = [];
  out.push(rec.name);
  out.push('Модель: ' + rec.model + '  (' + rec.steps + ' шагов)');
  if (rec.series) out.push('Серия: ' + rec.series);
  out.push('Перед пуском: ' + (rec.inputs.length ? rec.inputs.join(', ') : 'нет'));
  out.push('Ожидаемый результат: ' + (rec.result || 'см. описание источника'));
  out.push('');
  out.push('ЛИСТИНГ');
  for (const s of rec.prog) {
    if (s.fragment) {
      out.push(pad(s.addr, 4) + '  ' + pad(hex(s.code), 3) + '  —');
      continue;
    }
    out.push(pad(s.addr, 4) + '  ' + pad(hex(s.code), 3) + '  ' + s.cmd);
  }
  if (rec.comments.length) {
    out.push('');
    out.push('КОММЕНТАРИИ АВТОРА');
    for (const c of rec.comments) out.push(pad(c.addr, 4) + '  — ' + c.text);
  }
  return out.join('\n') + '\n';
}

function renderJson(rec) {
  const src = rec.prog.map(s =>
    pad(s.addr, 4) + '  ' + pad(hex(s.code), 3) + '  ' + (s.fragment ? '—' : s.cmd)
  ).join('\n');

  return JSON.stringify({
    app: 'mk-emulator',
    format: 'programs',
    version: 2,
    model: rec.model,
    saved: new Date().toISOString().slice(0, 10),
    programs: [{
      name: rec.name,
      prog: rec.prog.filter(s => !s.fragment).map(s => s.code),
      data: rec.data || {},
      inputs: rec.inputs,
      layout: {},
      src,
      savedAt: new Date().toISOString()
    }]
  }, null, 2) + '\n';
}

// ---------- главный проход -----------------------------------------------------

function shortReason(reasons) {
  const s = reasons.join('; ');
  return s.length <= MAX_REASON ? s : s.slice(0, MAX_REASON - 1) + '…';
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Нет исходного каталога: ' + SRC);
    process.exit(1);
  }

  fs.mkdirSync(path.join(OUT, 'mk61'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'b3-34'), { recursive: true });
  fs.mkdirSync(path.join(OUT, '_unresolved'), { recursive: true });
  fs.mkdirSync(path.join(OUT, '_unresolved', '_details'), { recursive: true });

  const catalog = [];
  const byModel = { 'b3-34': 0, mk61: 0 };
  let total = 0, ready = 0, unresolved = 0, splitFiles = 0, skippedAddr = 0, closedVo = 0;

  for (const section of SECTIONS) {
    const dir = path.join(SRC, section);
    if (!fs.existsSync(dir)) continue;

    for (const fname of fs.readdirSync(dir).sort()) {
      if (!/\.txt$/i.test(fname)) continue;
      total++;

      const text = fs.readFileSync(path.join(dir, fname), 'utf8');
      const base = fname.replace(/\.txt$/i, '');
      const series = detectSeries(base);
      const parsed = parseFile(text);
      if (parsed.programs.length > 1) splitFiles++;
      if (parsed.closedVo) closedVo += parsed.closedVo;

      parsed.programs.forEach((prog, idx) => {
        const suffix = idx === 0 ? '' : '-' + (idx + 1);
        const name = (base + suffix).replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());
        const model = detectModel(prog);
        const reasons = checkReady(prog);

        const rec = {
          name,
          base: base + suffix,
          section,
          series,
          model,
          inputs: parsed.inputs,
          prog: prog.steps,
          steps: prog.steps.filter(s => !s.fragment).length,
          comments: prog.comments,
          data: {}
        };

        if (reasons.length) {
          unresolved++;
          const dirU = path.join(OUT, '_unresolved', section);
          fs.mkdirSync(dirU, { recursive: true });
          fs.writeFileSync(
            path.join(dirU, rec.base + '.txt'),
            'НЕ РАЗОБРАНО: ' + shortReason(reasons) + '\n\n' + renderTxt(rec),
            'utf8'
          );
          fs.writeFileSync(
            path.join(OUT, '_unresolved', '_details', rec.base + '.txt'),
            'Файл: ' + section + '/' + fname + '\n' +
            'Причины:\n' + reasons.map(r => '  - ' + r).join('\n') + '\n',
            'utf8'
          );
          catalog.push({
            name, section, series, model, steps: rec.steps,
            status: 'не разобрано', reason: shortReason(reasons)
          });
        } else {
          ready++;
          byModel[model]++;
          const dirR = path.join(OUT, model);
          fs.writeFileSync(path.join(dirR, rec.base + '.json'), renderJson(rec), 'utf8');
          fs.writeFileSync(path.join(dirR, rec.base + '.txt'), renderTxt(rec), 'utf8');
          catalog.push({
            name, section, series, model, steps: rec.steps, status: 'готово',
            json: model + '/' + rec.base + '.json',
            txt: model + '/' + rec.base + '.txt'
          });
        }

        // счёт пропуска одного адреса — только для отчёта
        const addrs = prog.steps.filter(s => s.addr >= 0).map(s => s.addr);
        for (let i = 1; i < addrs.length; i++) if (addrs[i] - addrs[i - 1] === 2) skippedAddr++;
      });
    }
  }

  fs.writeFileSync(
    path.join(OUT, '_catalog.json'),
    JSON.stringify({
      generated: new Date().toISOString(),
      revision: 2,
      total, ready, unresolved,
      byModel,
      splitFiles, skippedAddr, closedVo,
      programs: catalog
    }, null, 2) + '\n',
    'utf8'
  );

  console.log('Ревизия 2');
  console.log('Всего файлов:      ' + total);
  console.log('Готово:            ' + ready);
  console.log('  b3-34:           ' + byModel['b3-34']);
  console.log('  mk61:            ' + byModel.mk61);
  console.log('В _unresolved:     ' + unresolved);
  console.log('Многосоставных:    ' + splitFiles);
  console.log('Снято замыкающих В/О: ' + closedVo);
  console.log('Принято пропусков адреса: ' + skippedAddr);

  const groups = {};
  for (const c of catalog.filter(c => c.status !== 'готово')) {
    for (const r of c.reason.split('; ')) {
      const key = r.replace(/\d+/g, 'N').slice(0, 70);
      groups[key] = (groups[key] || 0) + 1;
    }
  }
  console.log('\nПочему не разобрано:');
  Object.entries(groups).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log('  ' + v + ' × ' + k));
}

main();
