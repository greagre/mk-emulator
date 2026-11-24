#!/usr/bin/env node
/* =========================================================
   mk-emulator / publish.cjs — ревизия 3

   Собирает programs/ из листингов MKPro/games/**/*.txt.

   Правила разбора (после разбора каталога на 696 файлов):
   1. Источник — строка "адрес <таб> подпись". Hex в этих файлах нет.
   2. Пропуск адресов разрешён, если следующий адрес больше
      предыдущего и разрыв не больше 3 — это места под
      двухадресные команды (ПП 75, БП 50, К x≥0 e).
   3. Число шагов = maxAddr + 1, а не сумма разобранных строк.
   4. Аргумент-регистр отрезается от подписи ТОЛЬКО если
      остаток есть в словаре (Кx≥0e -> "К x≥0" + "e").
   5. Повтор адреса 00 = новая программа в том же файле.
   6. Модель по объёму: <= 98 шагов — Б3-34, <= 105 — МК-61.
   7. Причина отсева в каталоге — не длиннее 200 знаков,
      полный текст кладётся в _unresolved/_details/<name>.txt
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'programs');
const DETAILS = path.join(OUT, '_unresolved', '_details');
const MAX_REASON = 200;

/* ---------- где лежит источник ---------- */

function findGames() {
  const env = process.env.MKPRO_GAMES || process.env.MKPRO_DIR || '';
  const cands = [];
  if (env) {
    cands.push(env, path.join(env, 'games'), path.join(path.dirname(env), 'games'));
  }
  cands.push(
    path.join(ROOT, 'MKPro', 'games'),
    path.join(ROOT, '.src-MKPro', 'games'),
    path.join(ROOT, '..', '.src-MKPro', 'games')
  );
  for (const c of cands) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch (e) { /* нет такой — идём дальше */ }
  }
  return null;
}

/* ---------- словарь подписей ---------- */

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const MAIN = [
  '↔', 'В↑', 'С/П', 'ПП', 'БП', 'В/О', 'Cx', '/-/', '÷', 'ВП', 'F◯',
  '×', 'π', '√', '−', 'x²', '1/x', '+', 'x^y', 'e^x', 'ln', '•',
  'x→П', 'П→X', '<->'
];

const F_LAYER = [
  'F sin', 'F cos', 'F tg', 'F arcsin', 'F arccos', 'F arctg',
  'F lg', 'F 10^x', 'F e^x', 'F x^y', 'F π', 'F √', 'F x²', 'F 1/x',
  'F ◯', 'F Вx', 'F Cx', 'F ↔', 'F В↑',
  'F x<0', 'F x=0', 'F x≥0', 'F x≠0',
  'F L0', 'F L1', 'F L2', 'F L3'
];

const K_LAYER = [
  'К НОП', 'К x≠0', 'К x≥0', 'К x<0', 'К x=0',
  'К |x|', 'К {x}', 'К [x]', 'К ЗН', 'К ИНВ',
  'К ПП', 'К П→x', 'К x→П',
  'К ⊕', 'К ∧', 'К ∨',
  'К sin', 'К cos', 'К tg', 'К 1/x', 'К x²', 'К √',
  'К e^x', 'К 10^x', 'К ln', 'К lg', 'К ВП', 'К Вx',
  'К A', 'К B', 'К C', 'К D', 'К E', 'К F'
];

const LABELS = new Set([].concat(DIGITS, MAIN, F_LAYER, K_LAYER));

/* Синонимы: то, как команду пишут в листингах, -> канон.
   Только проверенные соответствия, ничего не додумываем. */
const SYNONYMS = {
  'FL0': 'F L0', 'FLO': 'F L0', 'Fl0': 'F L0',
  'F0': 'F ◯', 'FO': 'F ◯', 'Fo': 'F ◯', 'F○': 'F ◯', 'F◯': 'F ◯',
  'F>0': 'F x>0',
  'К2': 'К ∧', 'K2': 'К ∧',
  'C/П': 'С/П', 'CП': 'С/П', 'СП': 'С/П',
  'B/O': 'В/О', 'ВО': 'В/О', 'BO': 'В/О',
  'B↑': 'В↑',
  'П→x': 'П→X', 'П→х': 'П→X',
  'x→П': 'x→П', 'х→П': 'x→П',
  'F<->': 'F ↔', '<->': '↔',
  'ШГ->': 'ШГ→',
  'K√': 'К √'
};

/* Команды, которые допускают аргумент-регистр вплотную (Кx≥0e). */
const ARG_LABELS = [
  'К x≠0', 'К x≥0', 'К x<0', 'К x=0',
  'К ПП', 'К П→x', 'К x→П',
  'БП', 'ПП', 'F L0', 'F L1', 'F L2', 'F L3',
  'F x<0', 'F x=0', 'F x≥0', 'F x≠0'
];

const REG_CHARS = '0123456789abcdefABCDEF';

/* ---------- нормализация подписи ---------- */

function tidy(s) {
  return String(s)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2013\u2014]/g, '−')
    .replace(/\s+/g, ' ')
    .trim();
}

function canon(raw) {
  let t = tidy(raw);
  if (!t) return '';

  /* F<команда>, К<команда> без пробела -> с пробелом */
  if (/^[FК]\S/.test(t) && !/^F\s/.test(t) && !/^К\s/.test(t)) {
    t = t[0] + ' ' + t.slice(1);
  }
  /* латинская x в К-командах и П-командах -> кириллический канон ядра */
  t = t.replace(/К\s*x/gi, 'К x');
  t = t.replace(/\bFL\s*0\b/, 'F L0');
  t = t.replace(/\s+/g, ' ').trim();

  if (SYNONYMS[t]) t = SYNONYMS[t];

  /* «F круг» словами — это F◯, но такое пишем только когда это ровно оно */
  if (/^F\s*круг$/i.test(t)) t = 'F ◯';

  return t;
}

/* Отрезать аргумент-регистр: Кx≥0e -> К x≥0, но КНОП -> К НОП */
function stripArg(label) {
  if (LABELS.has(label)) return { label, arg: '' };
  const last = label.slice(-1);
  const head = label.slice(0, -1).trim();
  if (REG_CHARS.includes(last) && ARG_LABELS.includes(head)) {
    return { label: head, arg: last.toLowerCase() };
  }
  /* аргумент из двух символов: Кx≥08 -> К x≥0 + 8 */
  const last2 = label.slice(-1);
  const head2 = label.slice(0, -1).trim();
  if (head2 && ARG_LABELS.includes(head2) && REG_CHARS.includes(last2)) {
    return { label: head2, arg: last2.toLowerCase() };
  }
  return { label, arg: '' };
}

/* Отделить комментарий автора от подписи.
   Признаки: " - ", " – ", либо три и более слова, которых нет в словаре. */
function splitComment(tail) {
  let t = tidy(tail);
  const dash = t.search(/\s[-–—]\s/);
  if (dash > 0) {
    return { cmd: t.slice(0, dash).trim(), comment: t.slice(dash + 3).trim() };
  }
  const words = t.split(' ');
  if (words.length > 3) {
    let cut = -1;
    for (let i = 2; i < words.length; i++) {
      const head = words.slice(0, i).join(' ');
      if (LABELS.has(canon(head)) || ARG_LABELS.includes(canon(head))) cut = i;
    }
    if (cut > 0) {
      return {
        cmd: words.slice(0, cut).join(' '),
        comment: words.slice(cut).join(' ')
      };
    }
  }
  return { cmd: t, comment: '' };
}

/* ---------- разбор одного файла ---------- */

/* Строка листинга: "00\tКППe", "00  53  ПП", "12	" */
const STEP_RE = /^\s*(-?\d+)\s+(.+?)\s*$/;

function parsePrograms(text, baseName) {
  const lines = text.split(/\r?\n/);
  const programs = [];
  let cur = null;
  const header = [];

  function open() {
    cur = { name: baseName, steps: [], comments: [], notes: [], header: header.slice() };
    programs.push(cur);
  }

  for (const line of lines) {
    if (!line.trim()) continue;

    /* строки-комментарии источника */
    if (/^\s*[;#\/]{1,2}/.test(line) || /^\s*[А-Яа-яЁё][^0-9]*$/.test(line) === false && /^\s*[;#'"]/.test(line)) {
      const c = line.replace(/^\s*[;#\/]{1,2}\s?/, '').trim();
      if (c) {
        header.push(c);
        if (cur) cur.comments.push(c);
      }
      continue;
    }
    if (/^\s*[;#]/ .test(line)) continue;

    const m = STEP_RE.exec(line);
    if (!m) {
      const plain = line.trim();
      if (plain) header.push(plain);
      continue;
    }

    const addr = parseInt(m[1], 10);
    const tail = m[2];

    /* повтор адреса 00 при уже начатой программе = следующая программа */
    if (addr === 0 && cur && cur.steps.length) {
      open();
    } else if (!cur) {
      open();
    }

    const { cmd, comment } = splitComment(tail);
    const label = canon(cmd);
    const fin = stripArg(label);

    cur.steps.push({
      addr,
      raw: tidy(tail),
      label: fin.label,
      arg: fin.arg,
      comment: comment || ''
    });
    if (comment) cur.comments.push(comment);
  }

  return programs.filter(p => p.steps.length);
}

/* ---------- проверка программы ---------- */

function checkProgram(p) {
  const reasons = [];
  const structure = [];
  const steps = p.steps;

  /* адреса */
  const seen = new Map();
  let prev = null;
  let anom = [];
  for (const s of steps) {
    if (seen.has(s.addr)) {
      if (s.addr <= 0) {
        structure.push('адрес ' + s.addr + ' задан повторно (зона -0…-4)');
      } else {
        anom.push('адрес ' + s.addr + ' задан дважды');
      }
    } else {
      seen.set(s.addr, s);
    }
    if (prev !== null && s.addr > prev) {
      const gap = s.addr - prev - 1;
      if (gap > 3) {
        anom.push('разрыв адресов ' + prev + '→' + s.addr);
      } else if (gap > 0) {
        structure.push('пропуск ' + gap + ' адр. после ' + prev);
      }
    }
    prev = s.addr;
  }
  for (const a of anom) reasons.push(a);

  /* неизвестные подписи */
  const unknown = steps.filter(s => !LABELS.has(s.label) && !DIGITS.includes(s.label));
  for (const u of unknown.slice(0, 6)) {
    reasons.push('не разобрано на ' + u.addr + ': ' + u.raw);
  }
  if (unknown.length > 6) reasons.push('... ещё ' + (unknown.length - 6) + ' нераспознанных');

  /* длина */
  const maxAddr = steps.reduce((a, s) => Math.max(a, s.addr), 0);
  const length = Math.max(maxAddr + 1, 0);

  let model = null;
  if (length <= 98) model = 'b3-34';
  else if (length <= 105) model = 'mk61';
  else reasons.push('шагов ' + length + ' — больше 105');

  /* входные регистры из шапки */
  const inputs = [];
  for (const h of p.header) {
    const mm = /(Перед пуском|на вход|вход)\s*:?\s*(.+)/i.exec(h);
    if (mm) inputs.push(mm[2].trim());
  }

  return {
    ready: reasons.length === 0 && model !== null,
    model,
    length,
    reasons,
    structure,
    inputs,
    unknown: unknown.length
  };
}

/* ---------- формат вывода ---------- */

function stepDec(label, arg) {
  /* десятичный код команды берём из профиля ядра, если он там есть */
  const DEC = {
    '↔': 20, 'В↑': 14, 'Cx': 13, '/-/': 11, '÷': 19, 'ВП': 12,
    '×': 18, '−': 17, '+': 16, 'x^y': 36, 'e^x': 22, 'ln': 24,
    'π': 32, '√': 33, 'x²': 34, '1/x': 35, 'F ◯': 37, 'В/О': 80,
    'F Вx': 15, 'F x<0': 92, 'F x=0': 94, 'F x≥0': 89, 'F x≠0': 87,
    'F L0': 93, 'F L1': 91, 'F L2': 88, 'F L3': 90,
    'К НОП': 84, 'С/П': 80
  };
  if (label.length === 1 && DIGITS.includes(label)) return 8 + parseInt(label, 10) - 8;
  if (DEC[label] !== undefined) return DEC[label];
  if (label === 'БП') return 81;
  if (label === 'ПП') return 83;
  return null;
}

function toTxt(p, chk, meta) {
  const rows = [];
  rows.push('Программа: ' + meta.title);
  rows.push('Модель: ' + chk.model);
  rows.push('Шагов: ' + chk.length);
  if (chk.inputs.length) rows.push('Перед пуском: ' + chk.inputs.join('; '));
  else rows.push('Перед пуском: вход не требуется');
  if (meta.expect) rows.push('Ожидаемый результат: ' + meta.expect);
  if (chk.structure.length) rows.push('Структура: ' + chk.structure.join('; '));
  rows.push('');
  rows.push('Адр.  Код   Команда');
  rows.push('----------------------------');
  for (const s of p.steps) {
    const d = stepDec(s.label, s.arg);
    const code = d === null ? '  - ' : String(d).padStart(3, ' ');
    const cmd = s.label + (s.arg ? ' ' + s.arg : '');
    rows.push(String(s.addr).padStart(3, ' ') + '   ' + code + '   ' + cmd +
      (s.comment ? '   ; ' + s.comment : ''));
  }
  if (p.comments.length) {
    rows.push('');
    rows.push('Примечания автора:');
    for (const c of Array.from(new Set(p.comments)).slice(0, 40)) rows.push('  ' + c);
  }
  return rows.join('\n') + '\n';
}

/* ---------- сборка ---------- */

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.txt$/i.test(e.name)) out.push(p);
  }
  return out;
}

function writeFileSafe(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
}

function main() {
  const GAMES = findGames();
  if (!GAMES) {
    console.error('Не найдена папка MKPro/games (ни MKPro/games, ни .src-MKPro/games).');
    process.exit(1);
  }
  console.log('Источник: ' + GAMES);

  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(DETAILS, { recursive: true });

  const files = walk(GAMES, []).sort();
  console.log('Файлов к разбору: ' + files.length);

  const catalog = { app: 'mk-emulator', format: 'catalog', version: 3, model: 'multi', savedAt: new Date().toISOString(), total: 0, ready: 0, unresolved: 0, byModel: { 'b3-34': 0, mk61: 0 }, programs: [] };

  for (const file of files) {
    const section = path.relative(GAMES, path.dirname(file)).split(path.sep).join('/') || 'root';
    const slug = path.basename(file, '.txt').replace(/\s+/g, '-');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }

    let progs;
    try {
      progs = parsePrograms(text, slug);
    } catch (e) {
      progs = [];
    }

    if (!progs.length) {
      catalog.total++;
      catalog.unresolved++;
      const reason = 'нет строк вида «адрес  команда»';
      catalog.programs.push({ name: slug, section, ready: false, model: null, steps: 0, reason, json: null, txt: null });
      writeFileSafe(path.join(DETAILS, section, slug + '.txt'), reason + '\n\n' + text.slice(0, 20000));
      continue;
    }

    progs.forEach((p, idx) => {
      const name = idx === 0 ? slug : slug + '-' + (idx + 1);
      const chk = checkProgram(p);
      catalog.total++;
      const entry = {
        name,
        section,
        ready: chk.ready,
        model: chk.model,
        steps: chk.length,
        inputs: chk.inputs,
        structure: chk.structure,
        json: null,
        txt: null
      };

      if (chk.ready) {
        catalog.ready++;
        catalog.byModel[chk.model]++;
        const meta = { title: name, expect: '' };
        const prog = p.steps.map(s => ({ addr: s.addr, label: s.label, arg: s.arg, comment: s.comment }));
        const outDir = path.join(OUT, chk.model);
        writeFileSafe(path.join(outDir, name + '.json'), JSON.stringify({
          app: 'mk-emulator',
          format: 'programs',
          version: 2,
          model: chk.model,
          name,
          section,
          steps: chk.length,
          inputs: chk.inputs,
          savedAt: new Date().toISOString(),
          programs: [{ name, prog, data: {}, layout: {}, src: '', savedAt: new Date().toISOString() }]
        }, null, 2));
        writeFileSafe(path.join(outDir, name + '.txt'), toTxt(p, chk, meta));
        entry.json = 'programs/' + chk.model + '/' + name + '.json';
        entry.txt = 'programs/' + chk.model + '/' + name + '.txt';
      } else {
        catalog.unresolved++;
        const full = chk.reasons.join('; ');
        entry.reason = full.length > MAX_REASON ? full.slice(0, MAX_REASON - 1) + '…' : full;
        entry.reasons = chk.reasons;
        writeFileSafe(path.join(DETAILS, section, name + '.txt'),
          'Программа: ' + name + '\n' +
          'Раздел: ' + section + '\n' +
          'Шагов: ' + chk.length + '\n' +
          'Замечания:\n  - ' + chk.reasons.join('\n  - ') + '\n' +
          (chk.structure.length ? 'Структура: ' + chk.structure.join('; ') + '\n' : '') +
          '\nЛистинг:\n' + p.steps.map(s => String(s.addr).padStart(4, ' ') + '  ' + s.raw).join('\n') + '\n');
      }
      catalog.programs.push(entry);
    });
  }

  catalog.bySection = {};
  for (const p of catalog.programs) {
    catalog.bySection[p.section] = catalog.bySection[p.section] || { total: 0, ready: 0 };
    catalog.bySection[p.section].total++;
    if (p.ready) catalog.bySection[p.section].ready++;
  }

  writeFileSafe(path.join(OUT, '_catalog.json'), JSON.stringify(catalog, null, 2));

  const readme = [
    '# programs/',
    '',
    'Собрано из MKPro/games автоматически, publish.cjs ревизия 3.',
    '',
    '| Показатель | Значение |',
    '|:---|---:|',
    '| Всего программ | ' + catalog.total + ' |',
    '| Готово | ' + catalog.ready + ' |',
    '| Б3-34 | ' + catalog.byModel['b3-34'] + ' |',
    '| МК-61 | ' + catalog.byModel.mk61 + ' |',
    '| Разобрать не вышло | ' + catalog.unresolved + ' |',
    '',
    'Папки `b3-34/` и `mk61/` — готовые программы, у каждой пара `.json` (для импорта) и `.txt` (для чтения).',
    'Папка `_unresolved/` — то, что не прошло проверку, с причиной в подробном файле `_details/`.',
    '',
    '## По разделам',
    ''
  ].concat(Object.keys(catalog.bySection).sort().map(s => '- ' + s + ': ' + catalog.bySection[s].ready + ' из ' + catalog.bySection[s].total)).join('\n');
  writeFileSafe(path.join(OUT, 'README.md'), readme + '\n');

  console.log('');
  console.log('всего ' + catalog.total + ', готово ' + catalog.ready +
    ' (Б3-34 ' + catalog.byModel['b3-34'] + ', МК-61 ' + catalog.byModel.mk61 + '), ' +
    'не разобрано ' + catalog.unresolved);
}

main();
