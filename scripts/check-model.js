#!/usr/bin/env node
// Trial run of the configured model on a few DEV dialogs before the full export.
//   npm run check:model                 → 1 dialog (the first Russian chat)
//   npm run check:model -- --sample     → 3 dialogs: Russian, Kazakh, English chats (other than the first one)
//   npm run check:model -- --ids a,b,c  → the given dialogs
// Each answer is converted to a Results JSON 1.0 record and checked by the strict validator against the
// organisers' transcript. Nothing is written to results/dev or results/prod; the trial file goes to
// results/preview/ (not in Git). Successful evaluations are reused by `npm run export:dev`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { createServices, initServices } from '../server/app.js';
import { setLogLevel } from '../server/lib/logger.js';
import { buildDocument, buildRecord, errorRecord, modelFromEvaluations, pickChecklistVersion } from '../server/results/official-format.js';
import { validateResults } from '../server/results/validator.js';
import { readSourceRecords } from '../server/results/exporter.js';
import { passedSample, recordCheck, SAMPLE_LANGUAGES } from '../server/results/model-check.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const sample = args.includes('--sample');
const group = opt('group') || 'DEV';
setLogLevel('warn');
const base = loadConfig();
const cfg = { ...base, ai: { ...base.ai, fallbackToRules: false }, dataset: { ...base.dataset, autoload: false } };
const s = createServices(cfg);
await initServices(s);

const provider = s.evaluations.provider();
if (!provider) {
  console.error('✖ Модель не подключена (AI_PROVIDER в .env). Для подписки Claude: AI_PROVIDER=claude-code-cli');
  process.exit(2);
}
if (provider.info.id === 'claude-code-cli') {
  try {
    const pf = await provider.preflight();
    console.log(`Claude Code ${pf.version || ''} · вход через подписку Claude${pf.auth.subscriptionType ? ` (${pf.auth.subscriptionType})` : ''} · ключ API не используется · модель ${provider.info.model}`);
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(6);
  }
} else console.log(`Модель: ${provider.info.label}`);

if (!s.datasets.conversations(group).length) {
  if (!cfg.dataset.apiUrl) {
    console.error(`✖ Набор ${group} не загружен: запустите npm start (загрузит DEV из API) или npm run import -- <файл> --group ${group}`);
    process.exit(1);
  }
  const r = await s.datasets.fetchFromApi(group);
  console.log(`Набор ${group} получен из API организаторов: ${r.record_count} записей`);
}
const source = readSourceRecords(cfg, group);
const convs = s.datasets.conversations(group).slice().sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
const chats = (lang) => convs.filter((c) => c.channel_type === 'chat' && String(c.language).toUpperCase() === lang);

let picked;
if (opt('ids')) {
  const want = opt('ids').split(',').map((x) => x.trim()).filter(Boolean);
  picked = want.map((id) => convs.find((c) => c.conversation_id === id) || id);
  const missing = picked.filter((x) => typeof x === 'string');
  if (missing.length) { console.error(`✖ Нет в наборе ${group}: ${missing.join(', ')}`); process.exit(1); }
} else if (sample) picked = [chats('RU')[1], chats('KZ')[0], chats('EN')[0]].filter(Boolean);
else picked = [chats('RU')[0]].filter(Boolean);
if (!picked.length) { console.error('✖ Не найдено подходящих диалогов'); process.exit(1); }

const version = pickChecklistVersion(s.checklists, 'official').version.version;
console.log(`Пробный прогон: ${picked.length} ${picked.length === 1 ? 'диалог' : 'диалога'} (${picked.map((c) => `${c.conversation_id} ${c.language}`).join(', ')}), чек-лист v${version}. Файлы results/dev и results/prod не изменяются.\n`);

const records = [];
const evals = [];
let fatal = null;
for (const conv of picked) {
  const t0 = Date.now();
  let rec;
  let ev = null;
  try {
    ev = await s.evaluations.evaluate(conv.uid, { engine: 'ai', checklistVersion: version, actor: { role: 'system', name: 'Пробный прогон модели' } });
    rec = buildRecord(conv.conversation_id, ev, ev.checklist);
  } catch (e) {
    rec = errorRecord(conv.conversation_id, e.message);
    if (e.details?.fatal) fatal = e.message;
  }
  const sec = Math.round((Date.now() - t0) / 1000);
  records.push(rec);
  if (rec.status === 'ok') evals.push(ev);
  const tok = ev ? ` · токены: вход ${ev.usage.input_tokens}, выход ${ev.usage.output_tokens}` : '';
  console.log(`${rec.status === 'ok' ? '✔' : '✖'} ${conv.conversation_id} (${conv.language}, ${conv.channel_type}) · ${sec} с${ev ? ` · модель ${ev.engine.model_served || ev.engine.model}` : ''}${tok}`);
  if (rec.status === 'ok') {
    console.log(`   итог ${rec.score.final_score}${rec.score.critical_flag ? ' · critical' : ''} · ${rec.criteria.map((c) => `${c.criterion_id}=${c.value}`).join(' ')}`);
    const first = rec.criteria[0];
    console.log(`   пример обоснования (${first.criterion_id}, реплики ${first.evidence_turns.join(', ')}): ${first.rationale.slice(0, 220)}`);
  } else console.log(`   ${rec.error.slice(0, 400)}`);
  if (fatal) break;
}

const model = modelFromEvaluations(evals) || { mode: provider.info.mode || 'external_api', name: provider.info.model };
const doc = buildDocument({ teamName: cfg.teamName || 'ПРОБНЫЙ ПРОГОН', model, records });
const ids = new Set(records.map((r) => r.conversation_id));
const report = validateResults(Buffer.from(JSON.stringify(doc, null, 2)), {
  expectCount: records.length,
  source: source ? { records: source.records.filter((r) => ids.has(String(r.conversation_id))) } : null,
  mode: cfg.teamName ? 'submission' : 'preview',
});
mkdirSync(join(process.cwd(), 'results', 'preview'), { recursive: true });
const file = join('results', 'preview', `model-check-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

const allOk = records.length === picked.length && records.every((r) => r.status === 'ok');
const ok = allOk && report.ok;
console.log(`\nmodel: ${JSON.stringify(model)}`);
console.log(`Проверка по формату JSON 1.0: ${report.ok ? 'ПРОЙДЕНА' : `НЕ ПРОЙДЕНА — ${report.errors.length} ошибок`} (записей ${report.stats.records}, ok ${report.stats.ok}, error ${report.stats.error}; номеров реплик ${report.stats.evidence_turns}; цитат проверено ${report.stats.quotes_checked})`);
report.errors.slice(0, 15).forEach((e) => console.log(`  ✖ ${e}`));
report.warnings.slice(0, 5).forEach((w) => console.log(`  ! ${w}`));
console.log(`Файл пробного прогона: ${file}`);
recordCheck(cfg, provider.info, { at: new Date().toISOString(), ids: [...ids], languages: [...new Set(picked.map((c) => String(c.language).toUpperCase()))], ok });

if (fatal) {
  console.log(`\n✖ Прогон остановлен: ${fatal}`);
  process.exit(6);
}
if (!ok) {
  console.log('\n✖ Пробный прогон не пройден — полный прогон не запускайте. Пришлите этот вывод.');
  process.exit(1);
}
if (passedSample(cfg, provider.info)) {
  const avg = Math.round(evals.reduce((a, e) => a + (e.duration_ms || 0), 0) / Math.max(1, evals.length) / 1000);
  console.log(`\n✔ Проверка на ${SAMPLE_LANGUAGES.join(', ')} пройдена. Можно запускать все 65 диалогов: npm run export:dev`);
  console.log(`  (уже оценённые здесь диалоги повторно не отправляются; ~${avg} с на диалог → около ${Math.ceil((avg * 65) / 60 / Math.max(1, cfg.ai.concurrency))} мин при AI_CONCURRENCY=${cfg.ai.concurrency}, если не будет достигнут лимит подписки)`);
} else {
  console.log(`\n✔ Пробный прогон пройден. Следующий шаг: npm run check:model -- --sample (по одному диалогу на ${SAMPLE_LANGUAGES.join(', ')})`);
}
