#!/usr/bin/env node
// Results JSON 1.0 export.
//   npm run export:dev                          → results/dev/results.json   (65 DEV dialogs, needs a model)
//   npm run export:prod -- --group <ID>         → results/prod/results.json  (exactly 10 control chats from the API)
// Options: --file <saved API response>  --team "<name>"  --engine rules (preview without a model → results/preview/)
//          --checklist official|active|<n>  --allow-count  --fetch (DEV: re-download from the API)
//          --resume / --fresh: reuse (or not) dialogs this model already evaluated successfully
//          (default: reuse for AI_PROVIDER=claude-code-cli, to spend subscription limits once per dialog)
import { loadConfig } from '../server/config.js';
import { exportResults, ExportError } from '../server/results/exporter.js';
import { setLogLevel } from '../server/lib/logger.js';

const args = process.argv.slice(2);
const set = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const flag = (name) => args.includes(`--${name}`);
if (!['dev', 'prod'].includes(set)) {
  console.error('Использование: node scripts/export-results.js dev|prod [--group ID] [--file path] [--team "…"] [--engine ai|rules]');
  process.exit(1);
}
setLogLevel('warn');
const cfg = loadConfig();
try {
  const r = await exportResults({
    cfg, set, group: opt('group'), file: opt('file'), engine: opt('engine') || 'ai', teamName: opt('team') || cfg.teamName,
    checklist: opt('checklist') || 'official', allowCount: flag('allow-count'), fetch: flag('fetch'), out: opt('out'), log: (m) => console.log(m),
    resume: flag('fresh') ? false : flag('resume') ? true : undefined,
  });
  const { stats, errors, warnings } = r.report;
  console.log(`\nФайл: ${r.path}`);
  console.log(`model: ${JSON.stringify(r.model)} · чек-лист v${r.checklistVersion} · ${r.seconds} с · sha256 ${r.sha256.slice(0, 16)}…${r.reused ? ` · без повторной отправки: ${r.reused}` : ''}`);
  console.log(`Записей: ${stats.records} (ok ${stats.ok}, error ${stats.error}); критериев ${stats.criteria}; номеров реплик ${stats.evidence_turns}; проверено цитат ${stats.quotes_checked}`);
  console.log(`Проверка: ${r.report.ok ? 'ПРОЙДЕНА' : `НЕ ПРОЙДЕНА — ${errors.length} ошибок`}${warnings.length ? `, предупреждений ${warnings.length}` : ''}`);
  errors.slice(0, 20).forEach((e) => console.log(`  ✖ ${e}`));
  warnings.slice(0, 10).forEach((w) => console.log(`  ! ${w}`));
  if (stats.error > 0) {
    console.log(`\n! ${stats.error} из ${stats.records} записей со статусом error (причины — в строках ERROR выше). `
      + `Устраните причину и запустите эту же команду ещё раз: файл будет создан заново целиком.`);
  }
  process.exit(r.report.ok ? 0 : 4);
} catch (e) {
  console.error(`\n✖ ${e.message}`);
  process.exit(e instanceof ExportError ? e.code : 1);
}
