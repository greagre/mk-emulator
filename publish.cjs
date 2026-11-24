#!/usr/bin/env node
/**
 * publish.cjs — публикация разобранных программ в проект mk-emulator.
 *
 * Источник: каталог MKPro/readable (файлы .txt с листингами).
 * Результат: programs/<model>/<slug>.json  — для импорта в корпус (format: programs, version 2)
 *            programs/<model>/<slug>.txt   — для чтения и ручного ввода
 *            programs/_unresolved/...      — всё, что не прошло проверку, с причиной
 *            programs/_catalog.json        — сводка
 *            programs/README.md            — как пользоваться
 *
 * Запуск: node publish.cjs
 * Env: SRC_DIR (по умолчанию MKPro-src/readable), OUT_DIR (по умолчанию programs)
 *
 * Правило: публикуем только то, в чём уверены. Пять условий — см. check().
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(process.env.SRC_DIR || 'MKPro-src/readable');
const OUT = path.resolve(process.env.OUT_DIR || 'programs');

const MODEL_DIR = {
  'МК-61': 'mk61',
  'МК-54': 'mk54',
  'МК-52': 'mk52',
  'МК-51': 'mk51',
  'МК-56': 'mk56',
  'Б3-34': 'b3-34',
};

// адрес: 00..99 или −0..−4 (запись адресов 100..104 в листингах МК)
const STEP_RE = /^([−-]?\d{1,2})\s+([0-9A-Fa-f]{2})\s+(\d{1,3})\s+(.+?)\s*$/;

// Запись «адрес 100 повторён внутри программы» — ложное срабатывание разборщика:
// адреса 100..104 в листингах записываются как −0…−4 и идут ПОСЛЕ 99.
// Это не второй проход и не дубль, поэтому такие строки структуры не считаем замечанием.
const STRUCT_NOISE = /^адрес \d{1,3} повторён внутри программы/i;

function addrToNum(raw) {
  const t = raw.replace('−', '-');
  if (t.startsWith('-')) return 100 + Number(t.slice(1));
  return Number(t);
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.txt')) out.push(p);
  }
  return out.sort();
}

function parse(text, rel) {
  const lines = text.split(/\r?\n/);
  const meta = {
    rel, header: '', model: '', name: '', author: '', source: '',
    section: '', tags: '', series: '', inputs: '', total: 0,
  };

  const first = lines.findIndex((l) => l.trim());
  if (first >= 0) {
    meta.header = lines[first].trim();
    const m = meta.header.match(/^(.+?)\s*[·•]\s*(.+)$/);
    if (m) {
      meta.model = m[1].trim();
      meta.name = m[2].trim();
    }
  }

  const steps = [];
  const structure = [];
  const notes = [];
  let section = null;

  for (let i = first + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (/^Структура файла\s*:?$/i.test(t)) { section = 'structure'; continue; }
    if (/^Замечания при разборе\s*:?$/i.test(t)) { section = 'notes'; continue; }
    if (/^Коды получены|^ожидаемый экран/i.test(t)) { section = 'tail'; continue; }

    if (section === 'structure') {
      if (t) structure.push(t.replace(/^[-•]\s*/, ''));
      continue;
    }
    if (section === 'notes') {
      if (t) notes.push(t.replace(/^[-•]\s*/, ''));
      continue;
    }
    if (section === 'tail') continue;

    if (!steps.length) {
      const kv = raw.match(/^([^:]{1,40}):\s*(.*)$/);
      if (kv) {
        const k = kv[1].trim().toLowerCase();
        const v = kv[2].trim();
        if (k === 'автор') meta.author = v;
        else if (k === 'источник') meta.source = v;
        else if (k === 'раздел') meta.section = v.split('·')[0].trim();
        else if (k === 'теги') meta.tags = v;
        else if (k === 'серия') meta.series = v;
        else if (k === 'перед пуском') meta.inputs = v;
        else if (k === 'шагов') {
          const m2 = v.match(/(\d+)\s*из\s*(\d+)/);
          if (m2) meta.total = Number(m2[2]);
        }
        continue;
      }
    }

    const m3 = raw.match(STEP_RE);
    if (m3) {
      steps.push({
        addrRaw: m3[1],
        addr: addrToNum(m3[1]),
        hex: m3[2].toUpperCase(),
        dec: Number(m3[3]),
        cmd: m3[4].trim(),
      });
    }
  }

  return { meta, steps, structure, notes };
}

/**
 * Пять условий готовности. Возвращает массив причин: пусто — публикуем.
 */
function check(meta, steps, structure, notes) {
  const problems = [];

  // 1. ни одного замечания разбора
  if (notes.length) {
    problems.push(`замечания: ${notes.join(' | ')}`);
  }

  // 5. структура без ложного повтора — всё остальное считается замечанием
  const realStructure = structure.filter((s) => !STRUCT_NOISE.test(s));
  if (realStructure.length) {
    problems.push(`структура: ${realStructure[0]}`);
  }

  // 3. листинг найден и шагов столько же, сколько заявлено
  if (!steps.length) {
    problems.push('листинг не распознан');
  } else if (meta.total && steps.length !== meta.total) {
    problems.push(`шагов ${steps.length} из ${meta.total}`);
  }

  // 2. адреса идут подряд, без дыр и повторов
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].addr !== i) {
      problems.push(`адрес ${steps[i].addrRaw} стоит на месте ${i}`);
      break;
    }
  }

  // 4. «Перед пуском» на месте
  if (!meta.inputs) {
    problems.push('нет строки «Перед пуском»');
  }

  // модель должна быть известна ядру
  if (!MODEL_DIR[meta.model]) {
    problems.push(`модель не распознана: «${meta.model || '—'}»`);
  }

  return problems;
}

function listingText(steps) {
  const w = Math.max(...steps.map((s) => s.addrRaw.length), 2);
  return steps
    .map((s) => `${s.addrRaw.padStart(w)}  ${s.hex}  ${String(s.dec).padStart(3, '0')}  ${s.cmd}`)
    .join('\n');
}

function renderTxt(meta, steps) {
  const head = [
    meta.name || path.basename(meta.rel, '.txt'),
    [meta.model, meta.section, meta.author].filter(Boolean).join(' · '),
  ];
  if (meta.source) head.push(`Источник: ${meta.source}`);
  head.push(`Перед пуском: ${meta.inputs}`, `Шагов: ${steps.length}`, '');
  head.push('ЛИСТИНГ');
  const body = steps.map(
    (s) => `${s.addrRaw.padStart(2)}  ${s.hex}  ${String(s.dec).padStart(3, '0')}  ${s.cmd}`
  );
  return [...head, ...body, '', 'КОММЕНТАРИИ АВТОРА', '(нет)', ''].join('\n');
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Нет папки источника: ${SRC}`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const files = walk(SRC);
  const catalog = [];
  const unresolvedList = [];
  const byReason = new Map();

  for (const file of files) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const { meta, steps, structure, notes } = parse(text, rel);
    const problems = check(meta, steps, structure, notes);
    const slug = path.basename(file, '.txt');
    const section = meta.section || rel.split('/')[0] || 'unknown';

    if (problems.length) {
      const dir = path.join(OUT, '_unresolved', section);
      fs.mkdirSync(dir, { recursive: true });
      const reason = problems[0];
      fs.writeFileSync(
        path.join(dir, `${slug}.txt`),
        `не разобрано: ${problems.join('; ')}\n\n${text}`,
        'utf8'
      );
      const key = reason.replace(/\d+/g, 'N').slice(0, 80);
      byReason.set(key, (byReason.get(key) || 0) + 1);
      unresolvedList.push({ slug, section, reason: problems.join('; ') });
      catalog.push({
        slug, name: meta.name || slug, model: meta.model, section,
        steps: steps.length, status: 'не разобрано', reason: problems.join('; '),
      });
      continue;
    }

    const modelDir = MODEL_DIR[meta.model];
    const dir = path.join(OUT, modelDir);
    fs.mkdirSync(dir, { recursive: true });

    const item = {
      name: meta.name || slug,
      prog: steps.map((s) => s.dec),
      data: {},
      layout: {},
      inputs: [meta.inputs],
      src: listingText(steps),
      savedAt: new Date().toISOString(),
    };

    const payload = {
      app: 'mk-emulator',
      format: 'programs',
      version: 2,
      model: modelDir,
      saved: new Date().toISOString().slice(0, 16).replace('T', ' '),
      programs: [item],
    };

    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, `${slug}.txt`), renderTxt(meta, steps), 'utf8');

    catalog.push({
      slug, name: item.name, model: modelDir, section,
      steps: steps.length, status: 'готово',
      json: `programs/${modelDir}/${slug}.json`,
      txt: `programs/${modelDir}/${slug}.txt`,
    });
  }

  const ready = catalog.filter((c) => c.status === 'готово');
  const models = {};
  for (const c of ready) models[c.model] = (models[c.model] || 0) + 1;

  const summary = {
    generated: new Date().toISOString(),
    source: 'MKPro/readable',
    total: catalog.length,
    ready: ready.length,
    unresolved: unresolvedList.length,
    models,
    topReasons: [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([reason, count]) => ({ reason, count })),
    programs: catalog,
  };

  fs.writeFileSync(path.join(OUT, '_catalog.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const readme = [
    '# Программы для эмулятора',
    '',
    'Готовые программы, разобранные по адресам и кодам. Каждая лежит в двух видах:',
    '',
    '- `<slug>.json` — импорт в корпус: меню программ → «Импорт», формат `programs`, версия 2;',
    '- `<slug>.txt` — листинг для чтения и ручного ввода: адрес, hex, десятичный код, команда.',
    '',
    '## Папки',
    '',
    '- `mk61/` — МК-61 (105 шагов, K-функции);',
    '- `b3-34/` — Б3-34 (98 шагов);',
    '- `_unresolved/` — не прошло проверку; причина записана первой строкой файла.',
    '',
    '## Условия публикации',
    '',
    '1. нет замечаний при разборе;',
    '2. адреса идут подряд, без дыр и повторов;',
    '3. число шагов совпадает с заявленным;',
    '4. строка «Перед пуском» на месте;',
    '5. в структуре файла нет неоднозначностей.',
    '',
    `Сводка: ${ready.length} готово, ${unresolvedList.length} не разобрано из ${catalog.length}.`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'README.md'), readme, 'utf8');

  console.log(`Источник: ${SRC}`);
  console.log(`Всего файлов: ${catalog.length}`);
  console.log(`Готово: ${ready.length}`);
  console.log(`Не разобрано: ${unresolvedList.length}`);
  console.log('По моделям:', JSON.stringify(models));
  if (summary.topReasons.length) {
    console.log('Частые причины:');
    for (const r of summary.topReasons) console.log(`  ${r.count} × ${r.reason}`);
  }
}

main();
