// Structured output contract for the AI evaluator + strict validation before anything is stored.
// The schema avoids features that constrained decoding handles poorly (all fields required,
// additionalProperties:false, answers as strings — validated against the checklist in code).
import { normalizeAnswer } from '../../shared/checklist-schema.js';
import { normQuote, quotesToCheck } from '../../shared/quotes.js';

export const PROMPT_VERSION = 'cqa-prompt-v2';

const STATUS = ['scored', 'na', 'not_evaluated'];
const SITUATION = ['met', 'partial', 'not_met', 'na', 'unclear'];
const EVIDENCE_TYPE = ['supporting_messages', 'checked_range', 'none'];

export const AI_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria', 'critical_findings', 'overall_summary', 'transcript_issues'],
  properties: {
    criteria: {
      type: 'array',
      description: 'Ровно один элемент на каждый критерий из checklist.criteria',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion_id', 'status', 'answer', 'situation', 'explanation', 'evidence_ids', 'quotes', 'evidence_type',
          'confidence', 'na_reason', 'recommendation', 'critical_flag', 'needs_human_review', 'flag_subtypes'],
        properties: {
          criterion_id: { type: 'string' },
          status: { type: 'string', enum: STATUS },
          answer: { type: 'string', description: 'Значение из allowed_answers; пустая строка для na и not_evaluated' },
          situation: { type: 'string', enum: SITUATION },
          explanation: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
          quotes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['message_id', 'quote'],
              properties: { message_id: { type: 'string' }, quote: { type: 'string' } },
            },
          },
          evidence_type: { type: 'string', enum: EVIDENCE_TYPE },
          confidence: { type: 'number', description: 'Уверенность от 0 до 1' },
          na_reason: { type: 'string' },
          recommendation: { type: 'string' },
          critical_flag: { type: 'boolean' },
          needs_human_review: { type: 'boolean' },
          flag_subtypes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    critical_findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule_id', 'detected', 'severity', 'explanation', 'evidence_ids', 'confidence', 'possible_legitimate_context'],
        properties: {
          rule_id: { type: 'string' },
          detected: { type: 'boolean' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          explanation: { type: 'string' },
          evidence_ids: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          possible_legitimate_context: { type: 'boolean' },
        },
      },
    },
    overall_summary: { type: 'string' },
    transcript_issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['message_id', 'issue'],
        properties: { message_id: { type: 'string' }, issue: { type: 'string' } },
      },
    },
  },
};

export class AiOutputError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'AiOutputError';
    this.errors = errors;
  }
}

/** Tolerant JSON extraction from model text (code fences, leading prose). */
export function parseModelJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').trim();
  if (!s) throw new AiOutputError('AI вернул пустой ответ');
  try {
    return JSON.parse(s);
  } catch { /* try harder */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* continue */ }
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* fallthrough */ }
  }
  throw new AiOutputError('AI вернул текст, который не является корректным JSON');
}

function normId(id, validIds) {
  if (id === null || id === undefined) return null;
  const s = String(id).trim().replace(/^\[|\]$/g, '');
  const m = /^m?(\d+)$/i.exec(s);
  const cand = m ? `m${Number(m[1])}` : s;
  return validIds.has(cand) ? cand : null;
}

function clamp01(x) {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null;
}

function squash(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”„'’]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * «…» quotes inside the model's explanation must be verbatim transcript text (the explanation becomes the
 * rationale of Results JSON). Verified quotes return the message they come from; a fragment that is not in the
 * transcript is kept as the model's wording but explicitly marked as a paraphrase, never presented as a quote.
 * Same extraction and comparison as the Results JSON validator (shared/quotes.js).
 */
export function checkExplanationQuotes(explanation, conv) {
  const texts = conv.messages.map((m) => ({ id: m.id, t: normQuote(m.text) }));
  let out = '';
  let pos = 0;
  const cited = [];
  const invented = [];
  for (const q of quotesToCheck(explanation)) {
    const nq = normQuote(q.text);
    if (nq.length < 4) continue;
    const hit = texts.find((x) => x.t.includes(nq));
    if (hit) {
      cited.push({ id: hit.id, nq });
      continue;
    }
    invented.push(q.text);
    out += `${explanation.slice(pos, q.start)}[пересказ модели, дословно в транскрипте нет: ${q.text.replace(/[«»]/g, '"')}]`;
    pos = q.end;
  }
  return { text: invented.length ? out + explanation.slice(pos) : explanation, cited, invented };
}

/**
 * Validate the model output against the checklist and the transcript.
 * Invalid parts never become scores: they are turned into "not_evaluated" with a review flag.
 * @returns {{results:Array, findings:Array, summary:string, transcriptIssues:Array, errors:string[], warnings:string[], invalidShare:number}}
 */
export function validateAiOutput(raw, checklist, conv, criteria) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.criteria)) {
    throw new AiOutputError('Ответ AI не соответствует схеме: нет массива criteria');
  }
  const validIds = new Set(conv.messages.map((m) => m.id));
  const msgById = new Map(conv.messages.map((m) => [m.id, m]));
  const byId = new Map();
  for (const item of raw.criteria) {
    const cid = String(item?.criterion_id || '').trim().toLowerCase();
    if (!cid) { errors.push('Элемент criteria без criterion_id'); continue; }
    if (byId.has(cid)) { warnings.push(`Критерий ${cid} возвращён дважды — использован первый`); continue; }
    byId.set(cid, item);
  }
  const expected = new Set(criteria.map((c) => c.id));
  for (const cid of byId.keys()) if (!expected.has(cid)) warnings.push(`AI вернул неизвестный критерий «${cid}» — проигнорирован`);

  let invalid = 0;
  const results = criteria.map((c) => {
    const item = byId.get(c.id.toLowerCase());
    const base = { criterion_id: c.id, engine: 'ai' };
    if (!item) {
      invalid += 1;
      errors.push(`Нет результата для критерия ${c.code} «${c.name}»`);
      return { ...base, status: 'not_evaluated', answer: null, situation: 'unclear', explanation: 'AI не вернул результат по этому критерию.', evidence: [], evidence_type: 'none', checked_range: null, confidence: 0, na_reason: '', recommendation: '', critical_flag: false, needs_human_review: true, flag_subtypes: [] };
    }
    let status = String(item.status || '').toLowerCase();
    let needsReview = Boolean(item.needs_human_review);
    let explanation = String(item.explanation || '').trim();
    if (!STATUS.includes(status)) {
      invalid += 1;
      errors.push(`${c.code}: недопустимый status «${item.status}»`);
      status = 'not_evaluated';
      needsReview = true;
    }
    let answer = null;
    if (status === 'scored') {
      answer = normalizeAnswer(c, item.answer);
      if (answer === null) {
        invalid += 1;
        errors.push(`${c.code}: ответ «${item.answer}» не входит в допустимые значения`);
        status = 'not_evaluated';
        needsReview = true;
        explanation += ' [Ответ AI не прошёл проверку шкалы — требуется решение проверяющего.]';
      }
    }
    if (status === 'na' && !c.na_allowed) {
      warnings.push(`${c.code}: AI поставил N/A, но для критерия он не разрешён`);
      status = 'not_evaluated';
      needsReview = true;
      explanation += ' [N/A не разрешён для этого критерия — требуется решение проверяющего.]';
    }
    const evidenceIds = [];
    for (const id of Array.isArray(item.evidence_ids) ? item.evidence_ids : []) {
      const n = normId(id, validIds);
      if (n) { if (!evidenceIds.includes(n)) evidenceIds.push(n); } else warnings.push(`${c.code}: ссылка на несуществующую реплику «${id}» удалена`);
    }
    const quotes = [];
    for (const q of Array.isArray(item.quotes) ? item.quotes : []) {
      const n = normId(q?.message_id, validIds);
      if (!n) continue;
      const msg = msgById.get(n);
      const ok = squash(msg.text).includes(squash(q.quote)) || squash(msg.original).includes(squash(q.quote));
      if (ok && String(q.quote || '').trim()) quotes.push({ message_id: n, quote: String(q.quote).trim() });
      else warnings.push(`${c.code}: цитата не найдена в реплике ${n} — заменена текстом реплики`);
      if (!evidenceIds.includes(n)) evidenceIds.push(n);
    }
    const eq = checkExplanationQuotes(explanation, conv);
    if (eq.invented.length) {
      warnings.push(`${c.code}: в обосновании цитата, которой нет в транскрипте («${eq.invented[0].slice(0, 60)}») — помечена как пересказ`);
      explanation = eq.text;
      needsReview = true;
    }
    for (const q of eq.cited) {
      // a verified quote cites its message: keep evidence consistent with the rationale
      if (!evidenceIds.some((id) => normQuote(msgById.get(id).text).includes(q.nq))) evidenceIds.push(q.id);
    }
    if (status === 'scored' && !evidenceIds.length) {
      warnings.push(`${c.code}: нет ссылок на реплики — вывод помечен для проверки`);
      needsReview = true;
    }
    const conf = clamp01(Number(item.confidence));
    if (conf === null) warnings.push(`${c.code}: некорректная уверенность — принято 0.5`);
    let flagSubtypes = [];
    if (c.scoring_role === 'flag' && answer === 'yes') {
      const allowed = new Set((c.flag_subtypes || []).map((s) => s.id));
      flagSubtypes = (Array.isArray(item.flag_subtypes) ? item.flag_subtypes : [])
        .map((s) => String(s).trim()).filter((s) => !allowed.size || allowed.has(s))
        .map((id) => ({ id, evidence: evidenceIds }));
    }
    const evType = EVIDENCE_TYPE.includes(item.evidence_type) ? item.evidence_type : evidenceIds.length ? 'supporting_messages' : 'none';
    let range = null;
    if (evType === 'checked_range' && evidenceIds.length) {
      const idx = evidenceIds.map((id) => msgById.get(id).index).sort((a, b) => a - b);
      range = { from: `m${idx[0]}`, to: `m${idx[idx.length - 1]}` };
    }
    return {
      ...base,
      status,
      answer,
      situation: SITUATION.includes(item.situation) ? item.situation : 'unclear',
      explanation,
      evidence: evidenceIds.map((id) => ({ message_id: id, role: 'supporting', quote: quotes.find((q) => q.message_id === id)?.quote || null })),
      evidence_type: evType,
      checked_range: range,
      confidence: conf ?? 0.5,
      na_reason: status === 'na' ? String(item.na_reason || '').trim() : '',
      recommendation: String(item.recommendation || '').trim(),
      critical_flag: Boolean(item.critical_flag),
      needs_human_review: needsReview,
      flag_subtypes: flagSubtypes,
    };
  });

  const ruleIds = new Set((checklist.risk_rules || []).map((r) => r.id));
  const findings = [];
  for (const f of Array.isArray(raw.critical_findings) ? raw.critical_findings : []) {
    const rid = String(f?.rule_id || '').trim();
    if (!ruleIds.has(rid)) { if (rid) warnings.push(`Неизвестный сигнал риска «${rid}» — проигнорирован`); continue; }
    const ids = (Array.isArray(f.evidence_ids) ? f.evidence_ids : []).map((id) => normId(id, validIds)).filter(Boolean);
    findings.push({
      rule_id: rid,
      detected: Boolean(f.detected),
      severity: ['critical', 'high', 'medium', 'low'].includes(f.severity) ? f.severity : 'high',
      explanation: String(f.explanation || '').trim(),
      evidence: ids,
      confidence: clamp01(Number(f.confidence)) ?? 0.5,
      possible_legitimate_context: Boolean(f.possible_legitimate_context),
    });
  }
  const transcriptIssues = (Array.isArray(raw.transcript_issues) ? raw.transcript_issues : [])
    .map((t) => ({ message_id: normId(t?.message_id, validIds), issue: String(t?.issue || '').trim() }))
    .filter((t) => t.message_id && t.issue);

  return {
    results,
    findings,
    summary: String(raw.overall_summary || '').trim(),
    transcriptIssues,
    errors,
    warnings,
    invalidShare: criteria.length ? invalid / criteria.length : 0,
  };
}
