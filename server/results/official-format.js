// Results JSON 1.0 — the official submission format (appendix to the Student Guide).
// Fixed criterion ids, value types and weights; one record per source dialog.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateChecklist } from '../../shared/checklist-schema.js';
import { computeScore } from '../../shared/scoring-engine.js';

export const SCHEMA_VERSION = '1.0';
export const MODEL_MODES = Object.freeze(['local', 'external_api', 'hybrid']);

/** Official criteria in the order of the appendix; `code` links them to the checklist PDF numbering. */
export const OFFICIAL_CRITERIA = Object.freeze([
  { id: 'contact', code: '01', kind: 'boolean', nullable: false, weight: 10 },
  { id: 'discovery', code: '02', kind: 'boolean', nullable: true, weight: 15 },
  { id: 'identification', code: '03', kind: 'boolean', nullable: true, weight: 20 },
  { id: 'consultation', code: '04', kind: 'scale', values: [0, 5, 10, 15, 20], nullable: true, weight: 20 },
  { id: 'empathy', code: '05', kind: 'boolean', nullable: false, weight: 15 },
  { id: 'dialogue', code: '06', kind: 'scale', values: [0, 4, 7, 10], nullable: false, weight: 15 },
  { id: 'closure', code: '07', kind: 'boolean', nullable: true, weight: 5 },
  { id: 'critical', code: '08', kind: 'boolean', nullable: false, weight: 0, flag: true },
]);

const SEED_PATH = fileURLToPath(new URL('../../checklists/freedom-official.v1.json', import.meta.url));
let seedCache = null;
/** The official checklist (PDF wording) used as the scoring reference for final_score. */
export function officialChecklist() {
  if (!seedCache) seedCache = validateChecklist(JSON.parse(readFileSync(SEED_PATH, 'utf8'))).checklist;
  return seedCache;
}

const stepValues = (c) => (c.answer_type === 'scale' ? (c.scale.steps || []).map((s) => Number(s.value)).sort((a, b) => a - b) : null);

/**
 * Does a checklist version produce answers for the 8 official criteria with the official types?
 * @returns {{ok:boolean, problems:string[], wordingDiffers:boolean, map:Map<string,object>}}
 */
export function checkCompatibility(checklist) {
  const problems = [];
  const map = new Map();
  const seed = officialChecklist();
  let wordingDiffers = false;
  for (const oc of OFFICIAL_CRITERIA) {
    const c = checklist.criteria.find((x) => x.code === oc.code && x.enabled);
    if (!c) { problems.push(`нет включённого критерия ${oc.code} (${oc.id})`); continue; }
    if (oc.flag ? c.scoring_role !== 'flag' : c.scoring_role !== 'weighted') problems.push(`${oc.code}: другая роль критерия (${c.scoring_role})`);
    if (oc.kind === 'boolean' && c.answer_type !== 'binary') problems.push(`${oc.code}: тип ответа ${c.answer_type}, нужен Да/Нет`);
    if (oc.kind === 'scale' && JSON.stringify(stepValues(c)) !== JSON.stringify(oc.values)) problems.push(`${oc.code}: шкала ${JSON.stringify(stepValues(c))}, нужна ${JSON.stringify(oc.values)}`);
    if (Boolean(c.na_allowed) !== oc.nullable) problems.push(`${oc.code}: N/A ${c.na_allowed ? 'разрешён' : 'запрещён'}, по формату — ${oc.nullable ? 'разрешён' : 'запрещён'}`);
    const s = seed.criteria.find((x) => x.code === oc.code);
    if (s && (s.name !== c.name || s.description !== c.description)) wordingDiffers = true;
    map.set(oc.id, c);
  }
  return { ok: problems.length === 0, problems, wordingDiffers, map };
}

/** Pick the checklist version to evaluate with: the newest one identical in wording to the official PDF. */
export function pickChecklistVersion(checklistService, requested = 'official') {
  const versions = checklistService.list().map((v) => checklistService.get(v.version)).filter(Boolean).sort((a, b) => b.version - a.version);
  if (requested !== 'official' && requested !== 'active') {
    const v = checklistService.get(Number(requested));
    if (!v) throw new Error(`Версия чек-листа v${requested} не найдена`);
    const cc = checkCompatibility(v.checklist);
    if (!cc.ok) throw new Error(`Версия v${v.version} несовместима с форматом 1.0: ${cc.problems.join('; ')}`);
    return { version: v, compatibility: cc };
  }
  const active = checklistService.getActive();
  if (requested === 'active') {
    const cc = checkCompatibility(active.checklist);
    if (!cc.ok) throw new Error(`Активная версия v${active.version} несовместима с форматом 1.0: ${cc.problems.join('; ')}`);
    return { version: active, compatibility: cc };
  }
  for (const v of versions) {
    const cc = checkCompatibility(v.checklist);
    if (cc.ok && !cc.wordingDiffers) return { version: v, compatibility: cc };
  }
  throw new Error('Нет сохранённой версии чек-листа с официальными формулировками (PDF). Импортируйте checklists/freedom-official.v1.json');
}

export const turnOf = (messageId) => {
  const m = /^m(\d+)$/.exec(String(messageId));
  return m ? Number(m[1]) + 1 : null; // message m<i> is transcript[i]; turns are 1-based over ALL messages
};

/** Convert one internal result to an official criterion entry, or explain why it cannot be expressed. */
export function toOfficialCriterion(oc, r) {
  if (!r) return { error: `${oc.id}: нет результата оценки` };
  let value;
  if (r.status === 'na') {
    if (!oc.nullable) return { error: `${oc.id}: N/A недопустим по формату, а автоматическая оценка вернула N/A` };
    value = null;
  } else if (r.status !== 'scored') {
    return { error: `${oc.id}: критерий не оценён автоматически${r.explanation ? ` (${r.explanation})` : ''}` };
  } else if (oc.kind === 'boolean') {
    if (r.answer === 'yes') value = true;
    else if (r.answer === 'no') value = false;
    else return { error: `${oc.id}: недопустимый ответ ${JSON.stringify(r.answer)}` };
  } else {
    value = Number(r.answer);
    if (!oc.values.includes(value)) return { error: `${oc.id}: недопустимое значение шкалы ${JSON.stringify(r.answer)}` };
  }
  const explanation = String(r.explanation || '').trim();
  const rationale = (r.status === 'na' && r.na_reason ? `N/A: ${String(r.na_reason).trim()} ${explanation}` : explanation).trim();
  if (!rationale) return { error: `${oc.id}: нет обоснования` };
  const turns = [...new Set((r.evidence || []).map((e) => turnOf(e.message_id)).filter((t) => Number.isInteger(t)))].sort((a, b) => a - b);
  return { entry: { criterion_id: oc.id, value, rationale, evidence_turns: turns } };
}

/**
 * Build the official record for one evaluated dialog. Automatic answers only (`results`), never reviewer overrides:
 * the file states what the declared model produced. final_score uses the official weights (deterministic engine).
 */
export function buildRecord(conversationId, evaluation, checklist) {
  const cc = checkCompatibility(checklist);
  if (!cc.ok) return errorRecord(conversationId, `Чек-лист несовместим с форматом 1.0: ${cc.problems.join('; ')}`);
  const criteria = [];
  const problems = [];
  const forScore = [];
  const seed = officialChecklist();
  for (const oc of OFFICIAL_CRITERIA) {
    const c = cc.map.get(oc.id);
    const r = evaluation.results.find((x) => x.criterion_id === c.id);
    const { entry, error } = toOfficialCriterion(oc, r);
    if (error) { problems.push(error); continue; }
    criteria.push(entry);
    const s = seed.criteria.find((x) => x.code === oc.code);
    forScore.push({ criterion_id: s.id, status: entry.value === null ? 'na' : 'scored', answer: oc.kind === 'boolean' ? (entry.value ? 'yes' : 'no') : entry.value });
  }
  if (problems.length) return errorRecord(conversationId, `Автоматическая оценка неполная: ${problems.join('; ')}`);
  const score = computeScore(seed, forScore);
  if (!Number.isFinite(score.total)) return errorRecord(conversationId, 'Итог не рассчитывается: нет применимых критериев с весом');
  const critical = criteria.find((x) => x.criterion_id === 'critical').value;
  return { conversation_id: conversationId, status: 'ok', criteria, score: { final_score: score.total, critical_flag: critical }, error: null };
}

export function errorRecord(conversationId, reason) {
  return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: String(reason || 'Неизвестная ошибка').slice(0, 1000) };
}

/** Local endpoints (Ollama, LM Studio, vLLM on this machine or LAN) → "local"; anything else → "external_api". */
export function endpointMode(endpoint) {
  if (!endpoint) return null;
  let host;
  try { host = new URL(endpoint).hostname; } catch { return null; }
  if (['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host) || host.endsWith('.local')) return 'local';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 'local';
  return 'external_api';
}

/** Model block from the evaluations that were actually produced by a model (never from the rules engine). */
export function modelFromEvaluations(evaluations) {
  const used = evaluations.filter((e) => e && e.engine && e.engine.used !== 'rules' && !e.engine.fallback);
  if (!used.length) return null;
  const modes = new Set(used.map((e) => e.engine.model_mode || endpointMode(e.engine.endpoint)).filter(Boolean));
  const names = new Set(used.map((e) => e.engine.model_served || e.engine.model).filter(Boolean));
  if (!modes.size || !names.size) return null;
  return { mode: modes.size > 1 ? 'hybrid' : [...modes][0], name: [...names].join(' + ') };
}

/** Exact top-level shape of the format: no extra fields. */
export function buildDocument({ teamName, model, records }) {
  return { schema_version: SCHEMA_VERSION, team_name: teamName, model: { mode: model.mode, name: model.name }, results: records };
}
