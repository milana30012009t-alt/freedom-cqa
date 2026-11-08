// Export of Results JSON 1.0: load the organisers' set → evaluate every dialog → one record per dialog →
// write atomically → validate. A model is required for a submission file: without it nothing is written
// to results/<set>/results.json (an offline-rules preview goes to results/preview/ and says so).
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServices, initServices } from '../app.js';
import { RULES_ENGINE_VERSION } from '../evaluation/rules/rules-engine.js';
import { buildDocument, buildRecord, endpointMode, errorRecord, modelFromEvaluations, pickChecklistVersion } from './official-format.js';
import { validateResults } from './validator.js';
import { passedSample, reusableEvaluation } from './model-check.js';

export class ExportError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

export const EXPECTED = { dev: 65, prod: 10 };
export const DEFAULT_GROUP = { dev: 'DEV', prod: null };

export function resultsPath(root, set, engine) {
  return engine === 'rules' ? join(root, 'results', 'preview', `${set}.rules-preview.json`) : join(root, 'results', set, 'results.json');
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

async function pool(items, size, worker) {
  const queue = [...items.entries()];
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (queue.length) {
      const [i, item] = queue.shift();
      out[i] = await worker(item, i);
    }
  }));
  return out;
}

/** The organisers' raw records of a group, exactly as received (for counts, ids and transcripts). */
export function readSourceRecords(cfg, group) {
  const p = join(cfg.dataDir, 'datasets', `${group}.raw.json`);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  const records = raw?.data?.records;
  return Array.isArray(records) ? { group, records, path: p } : null;
}

/**
 * @param {object} o
 * @param {object} o.cfg loaded config
 * @param {'dev'|'prod'} o.set
 * @param {string} [o.group] dataset group (DEV / organisers' control group_id)
 * @param {string} [o.file] organisers' JSON saved to disk (alternative to the API)
 * @param {'ai'|'rules'} [o.engine]
 * @param {string} o.teamName
 * @param {string} [o.root] project root (results/ is created there)
 * @param {string} [o.out] explicit output path
 * @param {string} [o.checklist] 'official' | 'active' | version number
 * @param {boolean} [o.allowCount] do not stop when the PROD set does not have exactly 10 records
 * @param {boolean} [o.resume] reuse successful evaluations of the same model (default: on for claude-code-cli)
 * @param {boolean} [o.skipCheck] do not require a passed trial run (npm run check:model) for claude-code-cli
 */
export async function exportResults(o) {
  const log = o.log || (() => {});
  const set = o.set;
  if (!['dev', 'prod'].includes(set)) throw new ExportError('Набор: dev или prod');
  const engine = o.engine || 'ai';
  const group = o.group || DEFAULT_GROUP[set];
  if (!group) throw new ExportError('Для PROD укажите group_id контрольного набора: --group <ID>');
  const teamName = String(o.teamName || '').trim();
  if (engine === 'ai' && !teamName) throw new ExportError('Не задано название команды: TEAM_NAME в .env или --team "…"');

  const cfg = { ...o.cfg, ai: { ...o.cfg.ai, fallbackToRules: false }, dataset: { ...o.cfg.dataset, autoload: false } };
  const s = createServices(cfg, { providerOverride: o.providerOverride, datasetFetchImpl: o.datasetFetchImpl });
  await initServices(s);

  // 1. data: file → API (PROD always fetches fresh unless a file is given) → already loaded group
  if (o.file) {
    const r = await s.datasets.importPayload(group, readFileSync(o.file, 'utf8'), 'file');
    log(`Набор ${group} загружен из файла: ${r.record_count} записей`);
  } else if (set === 'prod' || o.fetch) {
    if (!cfg.dataset.apiUrl) throw new ExportError('DATASET_API_URL не задан в .env — нельзя получить набор из API (или укажите --file)');
    const r = await s.datasets.fetchFromApi(group);
    log(`Набор ${group} получен из API организаторов: ${r.record_count} записей`);
  } else if (!s.datasets.conversations(group).length) {
    if (!cfg.dataset.apiUrl) throw new ExportError(`Набор ${group} не загружен: npm run import -- <файл> --group ${group}, или задайте DATASET_API_URL`);
    const r = await s.datasets.fetchFromApi(group);
    log(`Набор ${group} получен из API организаторов: ${r.record_count} записей`);
  }
  const source = readSourceRecords(cfg, group);
  if (!source) throw new ExportError(`Нет исходного файла набора ${group}`);
  const convs = s.datasets.conversations(group);
  const sourceIds = source.records.map((r) => String(r.conversation_id));
  const uniqueIds = [...new Set(sourceIds)];
  if (uniqueIds.length !== sourceIds.length) log(`ВНИМАНИЕ: в исходном наборе есть повторяющиеся conversation_id (${sourceIds.length - uniqueIds.length})`);
  const expectCount = o.allowCount ? null : EXPECTED[set];
  if (expectCount !== null && uniqueIds.length !== expectCount) {
    throw new ExportError(`В наборе ${group} ${uniqueIds.length} диалогов, по регламенту для ${set.toUpperCase()} нужно ровно ${expectCount}. Проверьте group_id (или --allow-count, если организаторы изменили число)`, 3);
  }

  // 2. model
  const provider = engine === 'rules' ? null : s.evaluations.provider();
  if (engine === 'ai' && !provider) {
    throw new ExportError('Модель не подключена: задайте в .env AI_PROVIDER=claude-code-cli (подписка Claude через Claude Code), ANTHROPIC_API_KEY или OPENAI_BASE_URL + OPENAI_MODEL (локальная модель, например Ollama). '
      + 'Файл результатов не записан: офлайн-правила нельзя выдавать за модель. Для предварительной проверки без модели: --engine rules', 2);
  }
  const subscription = engine === 'ai' && provider.info.id === 'claude-code-cli';
  if (subscription) {
    // Subscription limits are spent per dialog: check the CLI login first and never start the full run
    // before a trial run on RU, KZ and EN dialogs has succeeded (npm run check:model).
    try {
      const pf = await provider.preflight();
      log(`Claude Code ${pf.version || ''}: вход через подписку Claude${pf.auth.subscriptionType ? ` (${pf.auth.subscriptionType})` : ''}, ключ API не используется`);
    } catch (e) {
      throw new ExportError(`${e.message}. Файл результатов не записан.`, 6);
    }
    if (!o.skipCheck && !passedSample(cfg, provider.info)) {
      throw new ExportError('Сначала пробный прогон через подписку: npm run check:model (1 диалог), затем npm run check:model -- --sample (RU, KZ, EN). Полный прогон запускается только после успешной проверки.', 7);
    }
  }
  const resume = engine === 'ai' && (o.resume ?? subscription);
  const picked = pickChecklistVersion(s.checklists, o.checklist || 'official');
  log(`Чек-лист: v${picked.version.version}${picked.compatibility.wordingDiffers ? ' (формулировки отличаются от PDF)' : ' (формулировки PDF)'}; движок: ${engine === 'ai' ? provider.info.label : `офлайн-правила ${RULES_ENGINE_VERSION} (без AI, предварительно)`}${resume ? '; уже успешно оценённые этой моделью диалоги повторно не отправляются' : ''}`);

  // 3. evaluate every dialog of the source, in source order; failures become status "error" records
  const byId = new Map(convs.map((c) => [c.conversation_id, c]));
  const started = Date.now();
  let done = 0;
  let reused = 0;
  let aborted = null; // a fatal provider error (usage limit, login): stop sending further dialogs
  const evaluated = await pool(uniqueIds, engine === 'ai' ? cfg.ai.concurrency : 1, async (id) => {
    const conv = byId.get(id);
    let rec;
    let evaluation = null;
    let note = '';
    if (!conv) rec = errorRecord(id, 'Запись не прошла проверку структуры при загрузке набора');
    else if (resume && (evaluation = reusableEvaluation(s.evaluations, conv, provider.info, picked.version.version))) {
      rec = buildRecord(id, evaluation, evaluation.checklist);
      reused += 1;
      note = `  (оценка от ${evaluation.created_at.slice(0, 16).replace('T', ' ')}, повторно не отправлялся)`;
    } else if (aborted) {
      rec = errorRecord(id, `Не отправлен: ${aborted}`);
      return { rec, evaluation: null, skipped: true };
    } else {
      try {
        evaluation = await s.evaluations.evaluate(conv.uid, { engine, checklistVersion: picked.version.version, actor: { role: 'system', name: `Экспорт результатов ${set.toUpperCase()}` } });
        if (engine === 'ai' && (evaluation.engine.used === 'rules' || evaluation.engine.fallback)) rec = errorRecord(id, `AI-оценка не выполнена: ${evaluation.engine.fallback?.reason || 'модель недоступна'}`);
        else rec = buildRecord(id, evaluation, evaluation.checklist);
      } catch (e) {
        if (e.details?.fatal && !aborted) aborted = e.message.replace(/^Ошибка AI-оценки: /, '');
        rec = errorRecord(id, `Ошибка оценки: ${e.message}`);
      }
    }
    done += 1;
    log(`${String(done).padStart(3)}/${uniqueIds.length} ${id.padEnd(14)} ${rec.status === 'ok' ? `ok  ${String(rec.score.final_score).padStart(6)}${rec.score.critical_flag ? '  critical' : ''}${note}` : `ERROR ${rec.error.slice(0, 120)}`}`);
    return { rec, evaluation: rec.status === 'ok' ? evaluation : null };
  });

  // A fatal provider error (subscription limit, lost login, not a subscription) leaves the run incomplete:
  // nothing is written, the previous file stays; successful evaluations are kept and reused next time.
  if (aborted) {
    const ok = evaluated.filter((x) => x.rec.status === 'ok').length;
    throw new ExportError(`Прогон остановлен: ${aborted}. Успешно оценено ${ok} из ${uniqueIds.length}${reused ? ` (из них ${reused} — ранее)` : ''}; эти оценки сохранены. `
      + `Файл не записан, прежний файл (если был) не изменён. Устраните причину или дождитесь сброса лимита и запустите ту же команду ещё раз — оценённые диалоги повторно не отправляются${resume ? '' : ' (добавьте --resume)'}.`, 6);
  }

  // A model that answered nothing (wrong key, no network, model not running) must not overwrite a good file
  // with a file of error records that formally passes validation.
  if (engine === 'ai' && !evaluated.some((x) => x.rec.status === 'ok')) {
    throw new ExportError(`Ни один диалог не оценён моделью: ${String(evaluated[0]?.rec.error || 'нет ответа').replace(/\.+$/, '')}. Файл не записан, прежний файл (если был) не изменён.`, 5);
  }

  // 4. model block from what actually produced the successful records
  let model;
  if (engine === 'rules') model = { mode: 'local', name: `NO-LLM offline rules ${RULES_ENGINE_VERSION} — preview, not for submission` };
  else {
    model = modelFromEvaluations(evaluated.map((x) => x.evaluation));
    if (!model) {
      const info = provider.info;
      model = { mode: info.mode || endpointMode(info.endpoint) || 'external_api', name: info.model };
      log('ВНИМАНИЕ: ни одна запись не оценена моделью — в model указана настроенная модель, все записи со статусом error');
    }
  }
  const doc = buildDocument({ teamName: teamName || 'НЕ ЗАДАНО (preview)', model, records: evaluated.map((x) => x.rec) });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const out = o.out ? resolve(o.out) : resultsPath(o.root || process.cwd(), set, engine);
  writeAtomic(out, text);

  // 5. validate the written bytes against the organisers' source
  const report = validateResults(readFileSync(out), { expectCount, source, mode: engine === 'rules' ? 'preview' : 'submission' });
  const sha256 = createHash('sha256').update(text).digest('hex');
  const manifestPath = join(cfg.dataDir, 'results-manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* first export */ }
  manifest[engine === 'rules' ? `${set}-preview` : set] = { group, file: out, exported_at: new Date().toISOString(), sha256, engine, model, checklist_version: picked.version.version, records: doc.results.length, ok: report.stats.ok, error: report.stats.error, valid: report.ok };
  writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: out, doc, report, sha256, seconds: Math.round((Date.now() - started) / 1000), checklistVersion: picked.version.version, model, reused };
}
