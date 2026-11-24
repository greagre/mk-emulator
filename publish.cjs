#!/usr/bin/env node
'use strict';

/**
 * publish.cjs — ревизия 2.
 *
 * Раскладывает разобранные программы из MKPro/readable в programs/:
 *   programs/b3-34/<имя>.json|.txt
 *   programs/mk61/<имя>.json|.txt
 *   programs/_unresolved/<раздел>/<имя>.txt      (причина в первой строке)
 *   programs/_unresolved/_details/<раздел>/<имя>.txt
 *   programs/_catalog.json, programs/README.md
 *
 * Что изменилось против ревизии 1:
 *   1. Модель определяется по объёму программы, а не по наличию буквы «К»
 *      (из-за /К/ все программы уходили в mk61, b3-34 не появлялся вообще).
 *   2. Нормализация начертаний: FLO/FL0/FO/Fo -> F0, Fѻ/FѺ/«F круг» -> F eˣ/F◯,
 *      Ftgᐨ¹ -> F tg⁻¹, «К 2» -> К2, «3ВП» -> 3 ВП, П→х -> П→x, ШГ-> -> ШГ→.
 *   3. Одиночная буква или слово — обрывок текста, а не команда.
 *   4. Пропуск ровно одного адреса (92 на месте 91) принимается молча,
 *      настоящий сдвиг остаётся замечанием.
 *   5. Замыкающее В/О после последнего шага шагом не считается.
 *   6. Многосоставные файлы делятся по повтору адреса 00 на имя-2, имя-3.
 *   7. Причина в каталоге — до 200 знаков, полный текст в _details/.
 *   8. Шаги считаются по адресам, а не по числу распознанных строк.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = process.env.MKPRO_DIR || path.join(ROOT, 'MKPro', 'readable');
const OUT = path.join(ROOT, 'programs');

const SECTIONS = [
  'action', 'adventure', 'arcade', 'educational', 'gambling',
  'logic', 'simulation', 'sports', 'strategy', 'utilities'
];

const LIMIT_B3 = 98;      // полный объём Б3-34
const LIMIT_MK61 = 105;   // полный объём МК-61
const REASON_MAX = 200;

const ANNOT = /^(?:перед\s+пуском|входные\s+данные|порядок\s+ввода)\s*:?\s*/i;

/* ------------------------------------------------------------------ */
/* Нормализация начертаний                                            */
/* ------------------------------------------------------------------ */

const EXACT = [
  [/^F\s*tg\s*[⁻−\-–—'’]?\s*1$/i, 'F tg⁻¹'],
  [/^F\s*[ѻѺΘ]$/, 'F eˣ'],
  [/^F\s*(?:круг|K|◯)$/i, 'F◯'],
  [/^F\s*(?:LО|LO|L0)$/, 'FL0'],
  [/^F\s*(?:o|O|0)$/, 'F0'],
  [/^[КK]\s*(?:√|V)$/i, 'К √'],
  [/^[КK]\s*ПП$/i, 'К ПП'],
  [/^C\s*\/\s*А$/i, 'С/А'],
  [/^[КK]\s*(?:⊕|XOR)$/i, 'К ⊕'],
  [/^[КK]\s*(?:∧|AND)$/i, 'К ∧'],
  [/^[КK]\s*(?:∨|OR)$/i, 'К ∨']
];

function normalizeCmd(input) {
  let c = String(input).replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!c) return c;
  for (const [re, to] of EXACT) if (re.test(c)) return to;
  c = c
    .replace(/П\s*→\s*х/g, 'П→x')
    .replace(/х\s*→\s*П/g, 'x→П')
    .replace(/ШГ\s*->/g, 'ШГ→')
    .replace(/ШГ\s*<-/g, 'ШГ←')
    .replace(/^([КK])\s+([0-9A-Ea-exх])$/, 'К$2');
  if (/^[КK]\d$/.test(c)) return 'К' + c.slice(1);
  return c;
}

/* ------------------------------------------------------------------ */
/* Разбор строки шага                                                 */
/* ------------------------------------------------------------------ */

const ADDR_RE = /^\s*(-?\d+)\s+(.+?)\s*$/;
const ADDR_CMD = /^\s*(-?\d+)\s+([^\s]+)\s+(.+?)\s*$/;
const TAB = /^([^\t]+?)\t+(.*)$/;

function parseStepLine(line) {
  let addr = null;
  let tail = '';

  let m = ADDR_RE.exec(line);
  if (m) {
    addr = parseInt(m[1], 10);
    tail = m[2];
  } else {
    m = TAB.exec(line);
    if (!m) return null;
    const maybe = m[1].trim();
    if (!/^-?\d+$/.test(maybe)) return null;
    addr = parseInt(maybe, 10);
    tail = m[2];
  }

  // команда / hex / подпись / комментарий
  let cmd = '';
  let hex = '';
  let label = '';

  const parts = tail.split(/\t+|\s{2,}/).map(s => s.trim()).filter(Boolean);
  const words = parts.length > 1 ? parts : tail.split(/\s+/);

  const hexIdx = words.findIndex(w => /^(?:[0-9A-F]{2}){1,4}$/i.test(w) && /[0-9]/i.test(w));

  if (hexIdx >= 0 && words.length >= 2 && words.slice(0, hexIdx).length <= 1) {
    hex = words[hexIdx].toUpperCase();
    cmd = words[hexIdx + 1] || '';
    label = words.slice(hexIdx + 2).join(' ');
  } else if (words.length >= 2 && /^[0-9A-F]{2,4}$/i.test(words[0]) && /[A-F]/i.test(words[0])) {
    hex = words[0].toUpperCase();
    cmd = words[1];
    label = words.slice(2).join(' ');
  } else {
    cmd = words[0] || '';
    label = words.slice(1).join(' ');
  }

  // склейка команды с примечанием автора: «04 БП 12 - вечное топливо»
  const note = label && !/^[0-9A-F]{2}$/i.test(label) ? label : '';
  if (words.length > 2 && !note) cmd = words.slice(0, 2).join(' ');

  return { addr, cmd: normalizeCmd(cmd), hex, note };
}

/* ------------------------------------------------------------------ */
/* Текст или команда                                                  */
/* ------------------------------------------------------------------ */

const TEXT_WORDS = /^(?:sin|cos|tg|ctg|ln|lg|max|min|mod|КНОП|БП|ПП|ВП|СЧ|В\/О|С\/П)$/i;

function looksLikeText(cmd) {
  const c = (cmd || '').trim();
  if (!c) return true;
  if (/^[+\-×÷/^√=]$/.test(c)) return false;          // одиночный знак операции
  if (/^[\d.,]+$/.test(c)) return false;              // число
  if (c.length <= 1) return true;                     // одиночная буква — обрывок
  if (TEXT_WORDS.test(c)) return false;
  if (!/[А-Яа-яЁё]/.test(c) && c.length <= 3) return false;  // короткие латинские — команды
  if (/[А-Яа-яЁё]{3,}/.test(c)) return true;          // слово кириллицей — текст
  if (/^(?:Б|Л|О|К|Н|И|П|А|С|В|М|Т|Р|Х|Ш|Э|Ю|Я)$/.test(c)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Серии и редакции                                                   */
/* ------------------------------------------------------------------ */

function seriesOf(name) {
  const n = name.toLowerCase();
  if (/^(?:kon-tiki-)?(?:lunolet|atmosphere|gravilet|kepler|mascon|mr-2|os-\d|peak|pk-1)/.test(n)) return 'Kon-Tiki';
  if (/^(?:morskoy-boy|sea-battle|morskoe-srazhenie)/.test(n)) return 'Морской бой';
  if (/^karate/.test(n)) return 'Каратэ';
  if (/^(?:menedzher|manager)/.test(n)) return 'Менеджер';
  if (/^bitva/.test(n)) return 'Битва';
  if (/^elite|^elita/.test(n)) return 'Elite';
  if (/^treasure-cave/.test(n)) return 'Treasure Cave';
  if (/^(?:lovkach|vorishka)/.test(n)) return 'Ловкач/Воришка';
  if (/^(?:trenirovka-pamyati|memory-training)/.test(n)) return 'Тренировка памяти';
  if (/^(?:chet-nechet|chetnochet)/.test(n)) return 'Чёт-нечёт';
  if (/dolgushin/.test(n)) return 'Долгушин';
  if (/gaishtut/.test(n)) return 'Гайштут';
  if (/erichware/.test(n)) return 'erichware';
  if (/renat/.test(n)) return 'Ренат';
  if (/lunokhod|marsokhod/.test(n)) return 'Планетоходы';
  return null;
}

/* ------------------------------------------------------------------ */
/* Разбор файла                                                       */
/* ------------------------------------------------------------------ */

function newProgram() {
  return { steps: [], inputs: [], comments: [], card: [] };
}

function parseFile(content) {
  const lines = content.split(/\r?\n/);
  const programs = [];
  let cur = null;
  let seenZero = false;
  let listingStarted = false;

  const flush = () => {
    if (cur && (cur.steps.length || cur.inputs.length)) programs.push(cur);
    cur = null;
    seenZero = false;
  };

  for (const raw of lines) {
    const line = raw.replace(/\u00A0/g, ' ').trimEnd();
    if (!line.trim()) continue;

    const t = line.trim();

    if (ANNOT.test(t)) {
      if (!cur) cur = newProgram();
      cur.inputs.push(t.replace(ANNOT, '').trim());
      continue;
    }

    const step = parseStepLine(line);

    if (step) {
      if (!cur) cur = newProgram();
      // новая программа в том же файле
      if (step.addr === 0 && seenZero && cur.steps.length >= 3) flush();
      if (!cur) cur = newProgram();

      const fragment = looksLikeText(step.cmd);
      cur.steps.push({ ...step, fragment });
      if (step.addr === 0) seenZero = true;
      listingStarted = true;
      continue;
    }

    if (!cur) cur = newProgram();
    if (listingStarted) cur.comments.push(t);
    else cur.card.push(t);
  }
  flush();

  return programs.filter(p => p.steps.some(s => !s.fragment));
}

/* ------------------------------------------------------------------ */
/* Проверка и метрики                                                 */
/* ------------------------------------------------------------------ */

const ROMAN = {
  'b3-34': 'Б3-34',
  mk61: 'МК-61'
};

function analyse(prog) {
  const notes = [];
  const reasons = [];

  // отбрасываем замыкающее В/О
  let real = prog.steps.filter(s => !s.fragment);
  let droppedTail = false;
  if (real.length > 1 && /^В\/О$/i.test(real[real.length - 1].cmd)) {
    const last = real[real.length - 1];
    const prev = real[real.length - 2];
    if (last.addr > prev.addr) {
      real = real.slice(0, -1);
      droppedTail = true;
    }
  }

  const fragments = prog.steps.filter(s => s.fragment);

  // шаги по адресам
  let maxAddr = -1;
  for (const s of real) {
    const a = s.addr >= 0 ? s.addr : 100 + Math.abs(s.addr);
    if (a > maxAddr) maxAddr = a;
  }
  const steps = maxAddr + 1;

  let model = 'b3-34';
  if (steps > LIMIT_B3) model = 'mk61';
  if (steps > LIMIT_MK61) {
    reasons.push(`шагов ${steps}, больше ${LIMIT_MK61}`);
  }

  if (droppedTail) notes.push('замыкающее В/О шагом не считается');
  if (fragments.length) {
    notes.push('обрывки текста на адресах ' + fragments.map(f => f.addr).join(', '));
  }

  // адреса
  let prev = null;
  for (const s of real) {
    if (prev !== null) {
      const a = s.addr >= 0 ? s.addr : 100 + Math.abs(s.addr);
      const p = prev >= 0 ? prev : 100 + Math.abs(prev);
      if (a === p) {
        if (s.addr < 0) notes.push(`отрицательный адрес ${s.addr} после ${prev}`);
        else reasons.push(`адрес ${s.addr} задан дважды`);
      } else if (a === p + 2) {
        notes.push(`пропущен адрес ${p + 1}`);
      } else if (a !== p + 1) {
        reasons.push(`адрес ${s.addr} стоит на месте ${p + 1}`);
      }
    }
    prev = s.addr;
  }

  if (!prog.inputs.length) {
    notes.push('блок «Перед пуском» не найден');
  }

  for (const s of real) {
    const c = s.cmd;
    if (!c) { reasons.push(`адрес ${s.addr}: пустая команда`); continue; }
    if (/^[КK]\s*[0-9]$/.test(c)) continue;
    if (/^A\d$/i.test(c)) continue;
    if (/^F\s*L[0-3]$/i.test(c)) continue;
  }

  const unique = [];
  for (const r of reasons) if (!unique.includes(r)) unique.push(r);

  return {
    steps,
    model,
    notes,
    reasons: unique,
    ready: unique.length === 0 && steps > 0,
    inputs: prog.inputs,
    comments: prog.comments,
    card: prog.card
  };
}

/* ------------------------------------------------------------------ */
/* Выгрузка                                                           */
/* ------------------------------------------------------------------ */

function clip(s, n = REASON_MAX) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function writeProgram(dir, name, section, prog, info) {
  fs.mkdirSync(dir, { recursive: true });

  const slug = name;
  const jsonName = slug + '.json';
  const txtName = slug + '.txt';

  const bytes = prog.steps.filter(s => !s.fragment).map(s => ({
    addr: s.addr,
    hex: s.hex || '',
    cmd: s.cmd,
    note: s.note || ''
  }));

  const payload = {
    app: 'mk-emulator',
    format: 'programs',
    version: 2,
    model: info.model,
    saved: new Date().toISOString(),
    programs: [{
      name,
      section,
      steps: info.steps,
      inputs: info.inputs,
      prog: bytes,
      data: {},
      layout: {},
      notes: info.notes,
      src: 'MKPro/readable/' + section + '/' + name + '.txt'
    }]
  };

  fs.writeFileSync(path.join(dir, jsonName), JSON.stringify(payload, null, 2), 'utf8');

  const lines = [];
  lines.push(`# ${name}`);
  lines.push('');
  lines.push('Раздел: ' + section + ' · Модель: ' + (ROMAN[info.model] || info.model) + ' · Шагов: ' + info.steps);
  lines.push('');

  if (info.inputs.length) {
    lines.push('## Перед пуском');
    for (const i of info.inputs) lines.push('- ' + i);
    lines.push('');
  }

  lines.push('## Листинг');
  lines.push('');
  for (const s of bytes) {
    const hex = s.hex ? s.hex.padEnd(4) : '    ';
    lines.push(String(s.addr).padStart(3) + '  ' + hex + '  ' + s.cmd + (s.note ? '  — ' + s.note : ''));
  }
  lines.push('');

  if (info.comments.length) {
    lines.push('## Комментарии автора');
    for (const c of info.comments) lines.push(c);
    lines.push('');
  }

  if (info.notes.length) {
    lines.push('## Примечания разбора');
    for (const n of info.notes) lines.push('- ' + n);
    lines.push('');
  }

  fs.writeFileSync(path.join(dir, txtName), lines.join('\n'), 'utf8');
}

/* ------------------------------------------------------------------ */
/* Главный проход                                                     */
/* ------------------------------------------------------------------ */

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Не найдена папка с разобранными программами: ' + SRC);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const catalog = [];
  const summary = {
    total: 0,
    ready: 0,
    b3: 0,
    mk61: 0,
    unresolved: 0,
    byModel: {},
    topReasons: {},
    notes: {}
  };

  for (const section of SECTIONS) {
    const dir = path.join(SRC, section);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.txt'));
    for (const file of files) {
      const baseName = file.replace(/\.txt$/i, '');
      const content = fs.readFileSync(path.join(dir, file), 'utf8');

      const programs = parseFile(content);
      if (!programs.length) {
        summary.total++;
        summary.unresolved++;
        const reason = 'листинг не найден';
        summary.topReasons[reason] = (summary.topReasons[reason] || 0) + 1;
        writeUnresolved(section, baseName, [reason], content);
        catalog.push({ file: baseName, section, model: '—', status: 'unresolved', reason });
        continue;
      }

      programs.forEach((prog, idx) => {
        const name = idx === 0 ? baseName : baseName + '-' + (idx + 1);
        const info = analyse(prog);
        summary.total++;

        if (info.ready) {
          summary.ready++;
          summary.byModel[info.model] = (summary.byModel[info.model] || 0) + 1;
          if (info.model === 'b3-34') summary.b3++; else summary.mk61++;

          writeProgram(path.join(OUT, info.model), name, section, prog, info);

          for (const n of info.notes) summary.notes[n.slice(0, 40)] = (summary.notes[n.slice(0, 40)] || 0) + 1;

          catalog.push({
            file: name,
            section,
            model: info.model,
            status: 'ready',
            steps: info.steps,
            series: seriesOf(name),
            json: 'programs/' + info.model + '/' + name + '.json',
            txt: 'programs/' + info.model + '/' + name + '.txt'
          });
        } else {
          summary.unresolved++;
          for (const r of info.reasons) {
            const key = clip(r, 60);
            summary.topReasons[key] = (summary.topReasons[key] || 0) + 1;
          }
          const reason = clip(info.reasons[0] || 'не прошла проверку');
          writeUnresolved(section, name, info.reasons, content, info);
          catalog.push({
            file: name,
            section,
            model: info.model,
            status: 'unresolved',
            steps: info.steps,
            series: seriesOf(name),
            reason
          });
        }
      });
    }
  }

  fs.writeFileSync(
    path.join(OUT, '_catalog.json'),
    JSON.stringify({
      app: 'mk-emulator',
      format: 'catalog',
      version: 2,
      generated: new Date().toISOString(),
      source: 'MKPro/readable',
      summary: {
        total: summary.total,
        ready: summary.ready,
        unresolved: summary.unresolved,
        byModel: summary.byModel
      },
      programs: catalog
    }, null, 2),
    'utf8'
  );

  const readme = [
    '# Каталог программ',
    '',
    'Разложено из `MKPro/readable` автоматически, генератор — `publish.cjs` (ревизия 2).',
    '',
    '## Итоги',
    '',
    '| Показатель | Значение |',
    '|:---|---:|',
    '| Всего файлов | ' + summary.total + ' |',
    '| Готово | ' + summary.ready + ' |',
    '| Б3-34 | ' + summary.b3 + ' |',
    '| МК-61 | ' + summary.mk61 + ' |',
    '| Не разобрано | ' + summary.unresolved + ' |',
    '',
    '## Папки',
    '',
    '- `b3-34/` — программы до 98 шагов, `.json` для импорта и `.txt` для чтения;',
    '- `mk61/` — программы до 105 шагов, то же;',
    '- `_unresolved/<раздел>/` — причина в первой строке файла;',
    '- `_unresolved/_details/` — полный разбор причин;',
    '- `_catalog.json` — полный список с ссылками и сериями.'
  ].join('\n');

  fs.writeFileSync(path.join(OUT, 'README.md'), readme, 'utf8');

  console.log('Всего файлов: ' + summary.total);
  console.log('Готово: ' + summary.ready + ' (Б3-34: ' + summary.b3 + ', МК-61: ' + summary.mk61 + ')');
  console.log('Не разобрано: ' + summary.unresolved);

  console.log('\nТОП ПРИЧИН ОТСЕВА:');
  Object.entries(summary.topReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .forEach(([r, n]) => console.log('  ' + n + ' × ' + r));
}

function writeUnresolved(section, name, reasons, content, info) {
  const dir = path.join(OUT, '_unresolved', section);
  fs.mkdirSync(dir, { recursive: true });

  const head = clip(reasons[0] || 'не прошла проверку', REASON_MAX);
  fs.writeFileSync(path.join(dir, name + '.txt'), head + '\n\n' + content, 'utf8');

  if (info) {
    const ddir = path.join(OUT, '_unresolved', '_details', section);
    fs.mkdirSync(ddir, { recursive: true });
    const lines = [];
    lines.push(name + ' — ' + section);
    lines.push('модель: ' + (info.model || '—') + ', шагов: ' + (info.steps || 0));
    lines.push('');
    lines.push('Причины:');
    for (const r of reasons) lines.push('- ' + r);
    if (info.notes && info.notes.length) {
      lines.push('');
      lines.push('Примечания:');
      for (const n of info.notes) lines.push('- ' + n);
    }
    fs.writeFileSync(path.join(ddir, name + '.txt'), lines.join('\n'), 'utf8');
  }
}

main();
