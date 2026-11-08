#!/usr/bin/env node
// Strict validation of Results JSON 1.0 before git push.
//   npm run validate:results                       → results/dev/results.json (65, DEV) and results/prod/results.json (10)
//   npm run validate:results -- <file> [--expect N] [--group ID] [--preview]
// The source of truth for ids and transcripts is the organisers' data saved by the exporter (data/datasets/<group>.raw.json).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { validateResults } from '../server/results/validator.js';
import { readSourceRecords } from '../server/results/exporter.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const cfg = loadConfig();
let manifest = {};
try { manifest = JSON.parse(readFileSync(join(cfg.dataDir, 'results-manifest.json'), 'utf8')); } catch { /* none yet */ }

const targets = [];
const file = args.find((a) => !a.startsWith('--') && !['--expect', '--group'].includes(args[args.indexOf(a) - 1]));
if (file) targets.push({ path: resolve(file), expect: opt('expect') ? Number(opt('expect')) : null, group: opt('group'), label: file });
else {
  targets.push({ path: resolve('results/dev/results.json'), expect: 65, group: 'DEV', label: 'DEV' });
  targets.push({ path: resolve('results/prod/results.json'), expect: 10, group: opt('group') || manifest.prod?.group || null, label: 'PROD' });
}

let failed = false;
for (const t of targets) {
  console.log(`\n=== ${t.label}: ${t.path}`);
  if (!existsSync(t.path)) {
    console.log(t.label === 'PROD' ? '— файла ещё нет (контрольный набор не обработан): npm run export:prod -- --group <ID>' : '✖ файла нет');
    if (t.label !== 'PROD') failed = true;
    continue;
  }
  const source = t.group ? readSourceRecords(cfg, t.group) : null;
  if (!source) console.log(`! исходный набор ${t.group || '(group_id не известен)'} не найден в data/datasets — сверка ID и номеров реплик с данными организаторов пропущена`);
  const r = validateResults(readFileSync(t.path), { expectCount: t.expect, source, mode: args.includes('--preview') ? 'preview' : 'submission' });
  console.log(`Записей ${r.stats.records} (ok ${r.stats.ok}, error ${r.stats.error}); критериев ${r.stats.criteria}; номеров реплик ${r.stats.evidence_turns}; проверено цитат ${r.stats.quotes_checked}${source ? `; сверено с ${source.path}` : ''}`);
  r.errors.slice(0, 40).forEach((e) => console.log(`  ✖ ${e}`));
  if (r.errors.length > 40) console.log(`  … и ещё ${r.errors.length - 40} ошибок`);
  r.warnings.slice(0, 15).forEach((w) => console.log(`  ! ${w}`));
  if (r.warnings.length > 15) console.log(`  … и ещё ${r.warnings.length - 15} предупреждений`);
  console.log(r.ok ? '✔ ПРОЙДЕНА' : `✖ НЕ ПРОЙДЕНА (${r.errors.length} ошибок)`);
  if (!r.ok) failed = true;
}
process.exit(failed ? 1 : 0);
