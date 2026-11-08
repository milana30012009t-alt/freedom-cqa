// Offline evaluation engine: runs the detector attached to each enabled criterion.
// Criteria without a detector are reported as "not evaluated" (they need the AI or a reviewer)
// instead of receiving an invented score.
import { buildContext } from './context.js';
import { DETECTOR_FUNCTIONS } from './detectors.js';
import { detectRiskSignals } from './risk.js';
import { answerForSituation, normalizeAnswer, situationForAnswer } from '../../../shared/checklist-schema.js';

export const RULES_ENGINE_VERSION = 'rules-2026.11.3'; // 11.2: 07 strictly per PDF, 06 repeated questions, 02 info requests, 03 unconfirmed ID → N/A; 11.3: every quoted message is in the evidence (06), 03 N/A cites the client's request

export function runCriterionDetector(ctx, criterion) {
  const base = { criterion_id: criterion.id, engine: 'rules', detector: criterion.detector?.type || null };
  if (!criterion.detector || !DETECTOR_FUNCTIONS[criterion.detector.type]) {
    return {
      ...base,
      status: 'not_evaluated',
      answer: null,
      situation: 'unclear',
      explanation: 'Для критерия не настроен офлайн-детектор — нужна оценка AI-модели или решение проверяющего. Балл не выставляется автоматически.',
      evidence: [],
      evidence_type: 'none',
      checked_range: null,
      confidence: 0,
      na_reason: '',
      recommendation: '',
      critical_flag: false,
      needs_human_review: true,
      flag_subtypes: [],
    };
  }
  let raw;
  try {
    raw = DETECTOR_FUNCTIONS[criterion.detector.type](ctx, criterion, criterion.detector.params || {});
  } catch (e) {
    raw = { status: 'not_evaluated', explanation: `Ошибка детектора: ${e.message}`, evidence: [], evidence_type: 'none', confidence: 0, needs_human_review: true };
  }
  let status = raw.status;
  let explanation = raw.explanation || '';
  let needsReview = Boolean(raw.needs_human_review);
  if (status === 'na' && !criterion.na_allowed) {
    status = 'not_evaluated';
    explanation += ' Для этого критерия N/A не допускается — решение за проверяющим.';
    needsReview = true;
  }
  let answer = null;
  if (status === 'scored') {
    answer = raw.answer !== undefined ? normalizeAnswer(criterion, raw.answer) : answerForSituation(criterion, raw.situation, raw.share);
    if (answer === null) {
      status = 'not_evaluated';
      needsReview = true;
      explanation += ' Не удалось сопоставить вывод детектора со шкалой критерия.';
    }
  }
  return {
    ...base,
    status,
    answer,
    situation: situationForAnswer(criterion, answer, status),
    explanation: explanation.trim(),
    evidence: (raw.evidence || []).filter(Boolean),
    evidence_type: raw.evidence_type || 'supporting_messages',
    checked_range: raw.range || null,
    confidence: Number.isFinite(raw.confidence) ? raw.confidence : 0.5,
    na_reason: status === 'na' ? raw.na_reason || '' : '',
    recommendation: raw.recommendation || '',
    critical_flag: Boolean(raw.critical_flag),
    needs_human_review: needsReview,
    flag_subtypes: raw.flag_subtypes || [],
  };
}

/**
 * @returns {{results:Array, risks:Array, summary:string}}
 */
export function evaluateWithRules(conv, checklist, { criteriaIds } = {}) {
  const ctx = buildContext(conv, checklist);
  const results = [];
  for (const c of checklist.criteria) {
    if (!c.enabled) continue;
    if (criteriaIds && !criteriaIds.has(c.id)) continue;
    results.push(runCriterionDetector(ctx, c));
  }
  const risks = detectRiskSignals(ctx, checklist);
  return { results, risks, summary: '' };
}
