// Evaluation pipeline:
//   transcript + active checklist → (AI model | offline detectors) → validation → evidence
//   verification → risk signals → deterministic scoring → stored with a checklist snapshot.
// Reviewer decisions are stored as overrides next to the untouched original result.
import { DETECTORS } from '../../shared/detector-catalog.js';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DirCollection } from '../storage/json-store.js';
import { evaluateWithRules, RULES_ENGINE_VERSION } from './rules/rules-engine.js';
import { buildPrompt, buildFocus } from './prompt.js';
import { AI_OUTPUT_SCHEMA, AiOutputError, validateAiOutput } from './output-schema.js';
import { enrichEvidence, enrichRange } from './evidence.js';
import { createProvider } from './providers/index.js';
import { costUsd } from './cost.js';
import { computeScore, diffScores } from '../../shared/scoring-engine.js';
import { answerLabel, answerSchemaKey, normalizeAnswer, situationForAnswer } from '../../shared/checklist-schema.js';
import { ENGINE_LABELS } from '../../shared/constants.js';
import { logger } from '../lib/logger.js';

export class EvaluationError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.name = 'EvaluationError';
    this.status = status;
    this.details = details;
  }
}

const newId = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;

/** What a reviewer's decision depends on: wording, allowed answers, N/A rules and violation types. */
function criterionFingerprint(c) {
  return JSON.stringify([answerSchemaKey(c), c.name, c.description, Boolean(c.na_allowed), c.na_condition || '', (c.flag_subtypes || []).map((x) => x.id)]);
}

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export class EvaluationService {
  constructor({ cfg, datasets, checklists, providerOverride = null, fetchImpl } = {}) {
    this.cfg = cfg;
    this.datasets = datasets;
    this.checklists = checklists;
    this.providerOverride = providerOverride;
    this.fetchImpl = fetchImpl;
    this.store = new DirCollection(join(cfg.dataDir, 'store', 'evaluations'));
    this.byConversation = new Map();
    for (const e of this.store.all()) this.index(e);
  }

  index(e) {
    const list = this.byConversation.get(e.conversation_uid) || [];
    if (!list.includes(e.id)) list.push(e.id);
    list.sort((a, b) => (this.store.get(a)?.created_at || '').localeCompare(this.store.get(b)?.created_at || ''));
    this.byConversation.set(e.conversation_uid, list);
  }

  setProviderOverride(p) {
    this.providerOverride = p;
  }

  provider() {
    return createProvider(this.cfg, { fetchImpl: this.fetchImpl, override: this.providerOverride });
  }

  engineInfo() {
    const p = this.provider();
    return {
      default_engine: p ? p.info.id : 'rules',
      ai_available: Boolean(p),
      ai: p ? p.info : null,
      rules_version: RULES_ENGINE_VERSION,
      fallback_to_rules: this.cfg.ai.fallbackToRules,
      pricing: this.cfg.ai.pricing,
      low_confidence: this.cfg.ai.lowConfidence,
      concurrency: this.cfg.ai.concurrency,
    };
  }

  get(id) {
    return this.store.get(id);
  }

  listFor(uid) {
    return (this.byConversation.get(uid) || []).map((id) => this.store.get(id)).filter(Boolean);
  }

  latestFor(uid) {
    const list = this.byConversation.get(uid) || [];
    return list.length ? this.store.get(list[list.length - 1]) : null;
  }

  all() {
    return this.store.all();
  }

  async clearAll() {
    await this.store.clear();
    this.byConversation.clear();
  }

  // ---------------------------------------------------------------- evaluation
  async evaluate(uid, { engine = 'auto', checklistVersion = null, actor = { role: 'system', name: 'Система' } } = {}) {
    const conv = this.datasets.get(uid);
    if (!conv) throw new EvaluationError('Диалог не найден', 404);
    const version = checklistVersion ? this.checklists.get(checklistVersion) : this.checklists.getActive();
    if (!version) throw new EvaluationError('Чек-лист не найден', 404);
    const checklist = version.checklist;
    const started = Date.now();
    const rules = evaluateWithRules(conv, checklist);

    const provider = engine === 'rules' ? null : this.provider();
    if (engine === 'ai' && !provider) {
      throw new EvaluationError('AI-модель не подключена: задайте ANTHROPIC_API_KEY (или OPENAI_MODEL) в .env и перезапустите сервер', 400);
    }
    let results;
    let aiFindings = [];
    let summary = '';
    let transcriptIssues = [];
    let warnings = [];
    let engineUsed = 'rules';
    let model = null;
    let promptVersion = null;
    let fallback = null;
    const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };

    if (provider) {
      try {
        const ai = await this.runAi(conv, checklist, provider, rules);
        results = ai.results;
        aiFindings = ai.findings;
        summary = ai.summary;
        transcriptIssues = ai.transcriptIssues;
        warnings = ai.warnings;
        Object.assign(usage, ai.usage);
        usage.cost_usd = Number(costUsd(usage, this.cfg.ai.pricing).toFixed(6));
        engineUsed = provider.info.id;
        model = provider.info.model;
        promptVersion = ai.promptVersion;
      } catch (e) {
        logger.warn(`AI-оценка ${uid} не удалась: ${e.message}`);
        if (!this.cfg.ai.fallbackToRules) throw new EvaluationError(`Ошибка AI-оценки: ${e.message}`, 502, { errors: e.errors });
        fallback = { reason: e.message, errors: e.errors || [] };
      }
    }
    if (!results) {
      results = rules.results.map((r) => {
        const c = checklist.criteria.find((x) => x.id === r.criterion_id);
        if (c?.evaluation_mode === 'llm') {
          return { ...r, status: 'not_evaluated', answer: null, situation: 'unclear', needs_human_review: true, evidence: [], evidence_type: 'none', checked_range: null, confidence: 0,
            explanation: 'Критерий настроен на оценку только AI-моделью; модель недоступна — требуется AI или решение проверяющего.' };
        }
        return r;
      });
    }

    // Enrich evidence with timestamps and quotes from the transcript.
    results = results.map((r) => ({
      ...r,
      evidence: enrichEvidence(conv, r.evidence),
      checked_range: enrichRange(conv, r.checked_range),
      answer_label: r.status === 'scored' ? answerLabel(checklist.criteria.find((c) => c.id === r.criterion_id), r.answer) : r.status === 'na' ? 'N/A' : '—',
    }));

    const findings = this.buildFindings(conv, checklist, results, aiFindings, rules, engineUsed);
    const scoreOriginal = computeScore(checklist, results);

    // Carry over reviewer decisions from the previous evaluation when the criterion is unchanged.
    // A checklist-wide parameter used by the criterion (e.g. the first-reaction threshold for 06) changes
    // what the right answer is, so decisions made under another value are not carried and must be re-checked.
    const prev = this.latestFor(uid);
    const overrides = {};
    const carried = [];
    const notCarried = [];
    if (prev && prev.overrides && Object.keys(prev.overrides).length) {
      const sameTranscript = prev.transcript_hash === conv.transcript_hash;
      for (const [cid, ov] of Object.entries(prev.overrides)) {
        const a = prev.checklist.criteria.find((c) => c.id === cid);
        const b = checklist.criteria.find((c) => c.id === cid && c.enabled);
        const usedParams = DETECTORS[b?.detector?.type]?.uses_checklist_parameters || [];
        const sameParams = usedParams.every((k) => stableJson(prev.checklist.parameters?.[k]) === stableJson(checklist.parameters?.[k]));
        if (sameTranscript && sameParams && a && b && criterionFingerprint(a) === criterionFingerprint(b)) {
          overrides[cid] = { ...ov, carried_from: prev.id };
          carried.push(cid);
        } else {
          notCarried.push({ cid, reason: !sameTranscript ? 'изменился транскрипт' : !b ? 'критерий удалён или выключен' : !sameParams ? `изменился параметр чек-листа, который использует критерий (${usedParams.join(', ')})` : 'изменилась формулировка, шкала или условия N/A критерия' });
        }
      }
    }

    const now = new Date().toISOString();
    const evaluation = {
      id: newId('EV'),
      conversation_uid: conv.uid,
      conversation_id: conv.conversation_id,
      group: conv.group,
      language: conv.language,
      channel_type: conv.channel_type,
      created_at: now,
      created_by: actor,
      transcript_hash: conv.transcript_hash,
      checklist_version: version.version,
      checklist_name: checklist.name,
      checklist_official: checklist.official,
      checklist,
      engine: {
        requested: engine,
        used: engineUsed,
        label: engineUsed === 'rules' ? ENGINE_LABELS.rules : provider?.info.label || engineUsed,
        model,
        rules_version: RULES_ENGINE_VERSION,
        prompt_version: promptVersion,
        fallback,
      },
      duration_ms: Date.now() - started,
      usage,
      results,
      critical_findings: findings,
      critical_reviews: {},
      summary,
      transcript_issues: transcriptIssues,
      warnings,
      quality: conv.quality,
      score_original: scoreOriginal,
      overrides,
      carried_overrides: carried,
      not_carried_overrides: notCarried.map((x) => x.cid),
      score_final: computeScore(checklist, results, { overrides }),
      review: { verified: null },
      history: [{ at: now, actor, action: 'evaluated', note: `${engineUsed === 'rules' ? ENGINE_LABELS.rules : provider?.info.label}; чек-лист v${version.version}${fallback ? `; AI недоступен — использованы офлайн-правила (${fallback.reason})` : ''}` }],
      supersedes: prev ? prev.id : null,
    };
    if (carried.length) evaluation.history.push({ at: now, actor: { role: 'system', name: 'Система' }, action: 'overrides_carried', note: `Перенесены решения проверяющего из ${prev.id}: ${carried.join(', ')}` });
    if (notCarried.length) {
      evaluation.history.push({
        at: now, actor: { role: 'system', name: 'Система' }, action: 'overrides_not_carried',
        note: `Не перенесены решения проверяющего из ${prev.id} (нужна повторная проверка): ${notCarried.map((x) => `${x.cid} — ${x.reason}`).join('; ')}`,
      });
    }
    evaluation.review = this.computeReview(evaluation);
    await this.store.put(evaluation);
    this.index(evaluation);
    return evaluation;
  }

  async runAi(conv, checklist, provider, rules) {
    const enabled = checklist.criteria.filter((c) => c.enabled);
    const aiCriteria = enabled.filter((c) => c.evaluation_mode !== 'rules');
    const preScreening = [
      ...rules.risks.map((r) => ({ signal: r.rule_id, evidence_ids: r.evidence, note: r.explanation })),
      ...rules.results.filter((r) => r.flag_subtypes?.length).flatMap((r) => r.flag_subtypes.map((s) => ({ signal: `${r.criterion_id}:${s.id}`, evidence_ids: s.evidence }))),
    ];
    const prompt = buildPrompt(conv, checklist, aiCriteria, { preScreening });
    if (this.cfg.ai.perCriterion) return this.runAiPerCriterion({ conv, checklist, provider, rules, enabled, aiCriteria, prompt });
    const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    let repairNote = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let resp;
      try {
        usage.calls += 1;
        resp = await provider.evaluate({ ...prompt, schema: AI_OUTPUT_SCHEMA, repairNote });
      } catch (e) {
        if (e instanceof AiOutputError && attempt < 2) {
          lastError = e;
          repairNote = `Предыдущий ответ отклонён: ${e.message}. Верни корректный JSON строго по схеме.`;
          continue;
        }
        throw e;
      }
      for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) usage[k] += resp.usage?.[k] || 0;
      let v;
      try {
        v = validateAiOutput(resp.output, checklist, conv, aiCriteria);
      } catch (e) {
        lastError = e;
        repairNote = `Предыдущий ответ отклонён: ${e.message}. Верни корректный JSON строго по схеме.`;
        continue;
      }
      if (v.invalidShare > 0.5 && attempt < 2) {
        lastError = new AiOutputError('Больше половины критериев не прошли проверку', v.errors);
        repairNote = `Ошибки проверки ответа: ${v.errors.slice(0, 8).join('; ')}. Исправь и верни полный JSON.`;
        continue;
      }
      if (v.invalidShare > 0.5) throw new AiOutputError('AI дважды вернул ответ, не прошедший проверку', v.errors);
      const rulesById = new Map(rules.results.map((r) => [r.criterion_id, r]));
      const aiById = new Map(v.results.map((r) => [r.criterion_id, r]));
      const results = enabled.map((c) => (c.evaluation_mode === 'rules' ? rulesById.get(c.id) : aiById.get(c.id)));
      return { results, findings: v.findings, summary: v.summary, transcriptIssues: v.transcriptIssues, warnings: [...v.errors, ...v.warnings], usage, promptVersion: prompt.version };
    }
    throw lastError || new AiOutputError('AI вернул невалидный ответ');
  }

  async runAiPerCriterion({ conv, checklist, provider, rules, enabled, aiCriteria, prompt }) {
    const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    const aiById = new Map();
    const warnings = [];
    const transcriptIssues = [];
    let findings = [];
    let summary = '';
    const base = prompt.conversationBlock.replace(/Оцени оператора по всем критериям[^\n]*$/, '');
    for (const c of aiCriteria) {
      const focused = { ...prompt, conversationBlock: base + buildFocus(c) };
      let v = null;
      let repairNote = null;
      let lastError = null;
      for (let attempt = 1; attempt <= 2 && !v; attempt += 1) {
        try {
          usage.calls += 1;
          const resp = await provider.evaluate({ ...focused, schema: AI_OUTPUT_SCHEMA, repairNote });
          for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) usage[k] += resp.usage?.[k] || 0;
          let raw = resp.output;
          if (raw && Array.isArray(raw.criteria) && raw.criteria.length) {
            const hit = raw.criteria.find((x) => String(x?.criterion_id || '').toLowerCase() === c.id.toLowerCase()) || raw.criteria[0];
            raw = { ...raw, criteria: [{ ...hit, criterion_id: c.id }] };
          }
          const one = validateAiOutput(raw, checklist, conv, [c]);
          if (one.results[0].status === 'not_evaluated' && one.errors.length && attempt < 2) {
            lastError = new AiOutputError(one.errors[0], one.errors);
            repairNote = `Ошибки проверки ответа: ${one.errors.slice(0, 4).join('; ')}. Исправь и верни JSON с одним элементом criteria.`;
            continue;
          }
          v = one;
        } catch (e) {
          if (!(e instanceof AiOutputError)) throw e;
          lastError = e;
          repairNote = `Предыдущий ответ отклонён: ${e.message}. Верни корректный JSON строго по схеме, criteria из одного элемента.`;
        }
      }
      if (!v) {
        v = validateAiOutput({ criteria: [] }, checklist, conv, [c]);
        v.errors.push(`${c.code}: ${lastError?.message || 'AI не вернул результат'}`);
      }
      aiById.set(c.id, v.results[0]);
      warnings.push(...v.errors, ...v.warnings);
      if (c.scoring_role === 'flag') findings = v.findings;
      if (!summary && v.summary) summary = v.summary;
      transcriptIssues.push(...v.transcriptIssues);
    }
    const rulesById = new Map(rules.results.map((r) => [r.criterion_id, r]));
    const results = enabled.map((c) => (c.evaluation_mode === 'rules' ? rulesById.get(c.id) : aiById.get(c.id)));
    return { results, findings, summary, transcriptIssues, warnings, usage, promptVersion: `${prompt.version}+per-criterion` };
  }

  buildFindings(conv, checklist, results, aiFindings, rules, engineUsed) {
    const findings = [];
    const ids = (arr) => arr.map((id) => ({ message_id: id }));
    for (const c of checklist.criteria.filter((x) => x.enabled && x.scoring_role === 'flag')) {
      const r = results.find((x) => x.criterion_id === c.id);
      if (!r || r.status !== 'scored' || r.answer !== 'yes') continue;
      const subtypes = r.flag_subtypes?.length ? r.flag_subtypes : [{ id: 'unspecified', evidence: r.evidence.map((e) => e.message_id) }];
      for (const st of subtypes) {
        const def = (c.flag_subtypes || []).find((s) => s.id === st.id);
        findings.push({
          id: `${c.id}:${st.id}`,
          kind: 'gross_error',
          criterion_id: c.id,
          subtype: st.id,
          name: def?.name || c.name,
          severity: 'critical',
          explanation: r.explanation,
          evidence: enrichEvidence(conv, ids(st.evidence?.length ? st.evidence : r.evidence.map((e) => e.message_id))),
          needs_human_review: true,
          source: r.engine === 'ai' ? 'ai' : 'rules',
        });
      }
    }
    if (engineUsed !== 'rules') {
      // Never silently drop a deterministic gross-error signal the AI did not confirm.
      for (const rr of rules.results.filter((r) => r.flag_subtypes?.length)) {
        for (const st of rr.flag_subtypes) {
          const id = `${rr.criterion_id}:${st.id}`;
          if (findings.some((f) => f.id === id)) continue;
          const c = checklist.criteria.find((x) => x.id === rr.criterion_id);
          findings.push({
            id,
            kind: 'gross_error',
            criterion_id: rr.criterion_id,
            subtype: st.id,
            name: (c?.flag_subtypes || []).find((s) => s.id === st.id)?.name || c?.name || st.id,
            severity: 'high',
            explanation: `Офлайн-правила нашли признак, но AI его не подтвердил — нужна ручная проверка. ${rr.explanation}`,
            evidence: enrichEvidence(conv, ids(st.evidence)),
            needs_human_review: true,
            source: 'rules',
            ai_disagrees: true,
          });
        }
      }
    }
    for (const rule of (checklist.risk_rules || []).filter((r) => r.enabled)) {
      const rr = rules.risks.find((x) => x.rule_id === rule.id);
      const ar = aiFindings.find((x) => x.rule_id === rule.id && x.detected);
      if (!rr && !ar) continue;
      const evidenceIds = [...new Set([...(ar?.evidence || []), ...(rr?.evidence || [])])];
      findings.push({
        id: `risk:${rule.id}`,
        kind: 'risk_signal',
        rule_id: rule.id,
        name: rule.name,
        severity: ar?.severity || rr?.severity || rule.severity,
        explanation: ar ? ar.explanation || rr?.explanation || '' : `${rr.explanation}${engineUsed !== 'rules' ? ' (AI этот сигнал не подтвердил — проверьте вручную.)' : ''}`,
        evidence: enrichEvidence(conv, ids(evidenceIds)),
        possible_legitimate_context: Boolean(ar ? ar.possible_legitimate_context : rr?.possible_legitimate_context),
        needs_human_review: true,
        source: ar && rr ? 'ai+rules' : ar ? 'ai' : 'rules',
      });
    }
    return findings;
  }

  computeReview(e) {
    const reasons = [];
    const active = e.critical_findings.filter((f) => e.critical_reviews?.[f.id]?.decision !== 'false_positive');
    const unresolved = active.filter((f) => !e.critical_reviews?.[f.id]);
    const results = e.results.map((r) => (e.overrides[r.criterion_id] ? { ...r, status: e.overrides[r.criterion_id].status, needs_human_review: false, confidence: 1 } : r));
    const pending = results.filter((r) => r.status === 'not_evaluated');
    const low = results.filter((r) => r.status !== 'not_evaluated' && r.confidence < this.cfg.ai.lowConfidence);
    const flagged = results.filter((r) => r.needs_human_review);
    if (active.some((f) => f.severity === 'critical')) reasons.push('Грубая ошибка');
    if (active.some((f) => f.severity !== 'critical')) reasons.push('Сигнал риска ИБ/комплаенса');
    if (pending.length) reasons.push(`Не оценено автоматически: ${pending.length}`);
    if (low.length) reasons.push(`Низкая уверенность: ${low.length}`);
    if (flagged.length) reasons.push(`Отмечено для проверки: ${flagged.length}`);
    if (e.engine.fallback) reasons.push('AI недоступен — оценка офлайн-правилами');
    const dropped = (e.not_carried_overrides || []).filter((cid) => !e.overrides[cid]);
    if (dropped.length) reasons.push(`Прежние решения проверяющего не перенесены: ${dropped.length}`);
    let priority = 'low';
    if (active.some((f) => f.severity === 'critical')) priority = 'critical';
    else if (active.length || pending.length) priority = 'high';
    else if (low.length || flagged.length || dropped.length) priority = 'medium';
    const verified = e.review?.verified || null;
    return {
      priority,
      reasons,
      needs_human_review: !verified && (priority !== 'low' || unresolved.length > 0),
      unresolved_findings: unresolved.length,
      verified,
    };
  }

  // ---------------------------------------------------------------- reviewer actions
  async applyOverride(evaluationId, criterionId, { status, answer, reason, appealId = null }, actor) {
    const e = this.get(evaluationId);
    if (!e) throw new EvaluationError('Оценка не найдена', 404);
    const c = e.checklist.criteria.find((x) => x.id === criterionId);
    if (!c) throw new EvaluationError('Критерий не найден в снимке чек-листа', 404);
    if (!['scored', 'na'].includes(status)) throw new EvaluationError('Статус решения: scored или na');
    if (status === 'na' && !c.na_allowed) throw new EvaluationError('Для этого критерия N/A не допускается');
    const norm = status === 'scored' ? normalizeAnswer(c, answer) : null;
    if (status === 'scored' && norm === null) throw new EvaluationError('Недопустимое значение для шкалы критерия');
    if (!String(reason || '').trim()) throw new EvaluationError('Укажите причину изменения');
    const before = e.overrides[criterionId] || e.results.find((r) => r.criterion_id === criterionId);
    const totalBefore = e.score_final.total;
    const now = new Date().toISOString();
    e.overrides = {
      ...e.overrides,
      [criterionId]: { status, answer: norm, answer_label: status === 'na' ? 'N/A' : answerLabel(c, norm), situation: situationForAnswer(c, norm, status), reason: String(reason).trim(), appeal_id: appealId, by: actor, at: now },
    };
    e.score_final = computeScore(e.checklist, e.results, { overrides: e.overrides });
    e.history.push({
      at: now, actor, action: 'override', criterion_id: criterionId, appeal_id: appealId, reason: String(reason).trim(),
      from: { status: before?.status, answer: before?.answer ?? null }, to: { status, answer: norm },
      total_before: totalBefore, total_after: e.score_final.total,
    });
    e.review = this.computeReview(e);
    await this.store.put(e);
    return e;
  }

  async reviewFinding(evaluationId, findingId, decision, note, actor) {
    const e = this.get(evaluationId);
    if (!e) throw new EvaluationError('Оценка не найдена', 404);
    const f = e.critical_findings.find((x) => x.id === findingId);
    if (!f) throw new EvaluationError('Сигнал не найден', 404);
    if (!['confirmed', 'false_positive'].includes(decision)) throw new EvaluationError('Решение: confirmed или false_positive');
    const now = new Date().toISOString();
    e.critical_reviews = { ...e.critical_reviews, [findingId]: { decision, note: String(note || '').trim(), at: now, by: actor } };
    e.history.push({ at: now, actor, action: decision === 'confirmed' ? 'finding_confirmed' : 'finding_rejected', finding_id: findingId, note: String(note || '').trim() });
    e.review = this.computeReview(e);
    await this.store.put(e);
    return e;
  }

  async verify(evaluationId, note, actor) {
    const e = this.get(evaluationId);
    if (!e) throw new EvaluationError('Оценка не найдена', 404);
    const now = new Date().toISOString();
    e.review = { ...e.review, verified: { at: now, by: actor, note: String(note || '').trim() } };
    e.history.push({ at: now, actor, action: 'verified', note: String(note || '').trim() });
    e.review = this.computeReview(e);
    await this.store.put(e);
    return e;
  }

  compare(idA, idB) {
    const a = this.get(idA);
    const b = this.get(idB);
    if (!a || !b) throw new EvaluationError('Оценка не найдена', 404);
    const score = diffScores(a.score_final, b.score_final);
    const resA = new Map(a.results.map((r) => [r.criterion_id, r]));
    const resB = new Map(b.results.map((r) => [r.criterion_id, r]));
    score.changes = score.changes.map((ch) => ({
      ...ch,
      explanation_before: resA.get(ch.criterion_id)?.explanation || null,
      explanation_after: resB.get(ch.criterion_id)?.explanation || null,
    }));
    return {
      before: this.summary(a),
      after: this.summary(b),
      checklist_changed: a.checklist_version !== b.checklist_version,
      score,
    };
  }

  summary(e) {
    if (!e) return null;
    const conv = this.datasets.get(e.conversation_uid);
    return {
      id: e.id,
      created_at: e.created_at,
      engine: e.engine.used,
      engine_label: e.engine.label,
      fallback: Boolean(e.engine.fallback),
      model: e.engine.model,
      checklist_version: e.checklist_version,
      checklist_official: e.checklist_official,
      total: e.score_final.total,
      total_original: e.score_original.total,
      complete: e.score_final.complete,
      gross_error: e.score_final.gross_error,
      critical_count: e.critical_findings.filter((f) => f.severity === 'critical' && e.critical_reviews?.[f.id]?.decision !== 'false_positive').length,
      risk_count: e.critical_findings.filter((f) => f.severity !== 'critical' && e.critical_reviews?.[f.id]?.decision !== 'false_positive').length,
      priority: e.review.priority,
      needs_human_review: e.review.needs_human_review,
      verified: Boolean(e.review.verified),
      overrides: Object.keys(e.overrides || {}).length,
      stale: conv ? conv.transcript_hash !== e.transcript_hash : false,
      cost_usd: e.usage?.cost_usd || 0,
    };
  }
}
