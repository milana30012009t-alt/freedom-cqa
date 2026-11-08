// Trial runs of a model before the full export (npm run check:model) and reuse of evaluations that the same
// model already produced. Both exist to spend a subscription's limits only once per dialog.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROMPT_VERSION } from '../evaluation/output-schema.js';
import { buildRecord } from './official-format.js';

export const SAMPLE_LANGUAGES = Object.freeze(['RU', 'KZ', 'EN']);

const checkPath = (cfg) => join(cfg.dataDir, 'model-check.json');

/** Key of a model configuration: provider, configured model and prompt version must all match. */
export function modelKey(info) {
  return `${info.id}|${info.model}|${PROMPT_VERSION}`;
}

export function readChecks(cfg) {
  try { return JSON.parse(readFileSync(checkPath(cfg), 'utf8')); } catch { return {}; }
}

export function recordCheck(cfg, info, entry) {
  const all = readChecks(cfg);
  const key = modelKey(info);
  const prev = all[key] || { provider: info.id, model: info.model, prompt_version: PROMPT_VERSION, checks: [] };
  prev.checks.push(entry);
  all[key] = prev;
  mkdirSync(dirname(checkPath(cfg)), { recursive: true });
  writeFileSync(checkPath(cfg), `${JSON.stringify(all, null, 2)}\n`);
  return prev;
}

/** Has a trial run with RU, KZ and EN dialogs succeeded for this provider/model/prompt? */
export function passedSample(cfg, info) {
  const e = readChecks(cfg)[modelKey(info)];
  return Boolean(e?.checks?.some((c) => c.ok && SAMPLE_LANGUAGES.every((l) => (c.languages || []).includes(l))));
}

/**
 * The newest stored evaluation of this dialog that the same provider and model produced with the same prompt,
 * checklist version and transcript, and that converts to a valid "ok" record — or null.
 */
export function reusableEvaluation(evaluations, conv, info, checklistVersion) {
  const list = evaluations.listFor(conv.uid);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    const en = e?.engine;
    if (!en || en.used !== info.id || en.fallback || en.model !== info.model || en.prompt_version !== PROMPT_VERSION) continue;
    if (e.checklist_version !== checklistVersion || e.transcript_hash !== conv.transcript_hash) continue;
    if (buildRecord(conv.conversation_id, e, e.checklist).status === 'ok') return e;
  }
  return null;
}
