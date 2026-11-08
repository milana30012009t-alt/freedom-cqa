// Deterministic scoring engine.
// The AI (or an offline detector) only proposes answers with evidence; ALL arithmetic —
// weights, N/A redistribution, sections, rounding and the gross-error policy — happens here,
// driven entirely by the checklist configuration.

import { answerScore, answerLabel } from './checklist-schema.js';

/**
 * Round a number with a given mode. Binary floating noise is removed first
 * (e.g. 1.005*100 = 100.49999999999999 is treated as 100.5).
 */
export function roundValue(x, decimals = 2, mode = 'half_up') {
  if (!Number.isFinite(x) || mode === 'none') return x;
  const factor = 10 ** decimals;
  const scaled = Number((x * factor).toPrecision(15));
  let r;
  switch (mode) {
    case 'floor':
      r = Math.floor(scaled);
      break;
    case 'ceil':
      r = Math.ceil(scaled);
      break;
    case 'half_even': {
      const fl = Math.floor(scaled);
      const diff = scaled - fl;
      if (Math.abs(diff - 0.5) < 1e-9) r = fl % 2 === 0 ? fl : fl + 1;
      else r = Math.round(scaled);
      break;
    }
    case 'half_up':
    default:
      r = scaled >= 0 ? Math.floor(scaled + 0.5 + 1e-9) : -Math.floor(-scaled + 0.5 + 1e-9);
  }
  return Number((r / factor).toFixed(decimals));
}

function fmt(x, d = 2) {
  if (!Number.isFinite(x)) return '—';
  return String(Number(x.toFixed(d)));
}

/**
 * Merge evaluator results with reviewer overrides.
 * @param {Array} results [{criterion_id, status, answer, ...}]
 * @param {Object} overrides {criterion_id: {status, answer, ...}}
 */
export function applyOverrides(results, overrides = {}) {
  return results.map((r) => {
    const o = overrides && overrides[r.criterion_id];
    if (!o) return { ...r, source: r.source || 'evaluator' };
    return { ...r, status: o.status, answer: o.answer, source: 'override', override: o };
  });
}

/**
 * Compute the score.
 * @param {object} checklist normalised checklist (see checklist-schema.js)
 * @param {Array} results [{criterion_id, status:'scored'|'na'|'not_evaluated', answer}]
 * @param {{overrides?:object}} options
 */
export function computeScore(checklist, results, options = {}) {
  const { scoring } = checklist;
  const maxScore = scoring.max_score || 100;
  const merged = applyOverrides(results || [], options.overrides || {});
  const byId = new Map(merged.map((r) => [r.criterion_id, r]));
  const enabled = checklist.criteria.filter((c) => c.enabled);

  const rows = enabled.map((c) => {
    const r = byId.get(c.id) || { criterion_id: c.id, status: 'not_evaluated', answer: null, source: 'missing' };
    let status = r.status;
    let normalized = null;
    if (status === 'scored') {
      normalized = answerScore(c, r.answer);
      if (normalized === null) status = 'not_evaluated'; // invalid answer never silently becomes 0
    }
    if (status === 'na' && !c.na_allowed) status = 'not_evaluated';
    return {
      criterion_id: c.id,
      code: c.code,
      name: c.name,
      section_id: c.section_id,
      role: c.scoring_role,
      answer_type: c.answer_type,
      status,
      answer: status === 'scored' ? r.answer : null,
      answer_label: status === 'scored' ? answerLabel(c, r.answer) : status === 'na' ? 'N/A' : '—',
      normalized,
      nominal_weight: c.scoring_role === 'weighted' ? c.weight : 0,
      effective_weight: 0,
      points: 0,
      max_points: 0,
      source: r.source,
    };
  });

  const weighted = rows.filter((r) => r.role === 'weighted' && r.nominal_weight > 0);
  const naPolicy = scoring.na_policy;

  // Treat N/A as full only when the policy says so (not the official rule).
  if (naPolicy === 'count_as_full') {
    for (const r of weighted) if (r.status === 'na') { r.normalized = 1; r.counted_as_full = true; }
  }
  const isApplicable = (r) => r.status === 'scored' || (naPolicy === 'count_as_full' && r.status === 'na');
  const applicable = weighted.filter(isApplicable);

  // Effective weights (in nominal units first, then scaled to max score).
  const eff = new Map();
  if (naPolicy === 'redistribute_within_section') {
    const sectionIds = [...new Set(weighted.map((r) => r.section_id || '__none__'))];
    const sectionWeight = {};
    const sectionApplicableWeight = {};
    for (const sid of sectionIds) {
      const inSec = weighted.filter((r) => (r.section_id || '__none__') === sid);
      sectionWeight[sid] = inSec.reduce((s, r) => s + r.nominal_weight, 0);
      sectionApplicableWeight[sid] = inSec.filter(isApplicable).reduce((s, r) => s + r.nominal_weight, 0);
    }
    const liveSections = sectionIds.filter((sid) => sectionApplicableWeight[sid] > 0);
    const deadWeight = sectionIds.filter((sid) => sectionApplicableWeight[sid] === 0).reduce((s, sid) => s + sectionWeight[sid], 0);
    const liveTotal = liveSections.reduce((s, sid) => s + sectionWeight[sid], 0);
    for (const r of applicable) {
      const sid = r.section_id || '__none__';
      const secShare = sectionWeight[sid] + (liveTotal > 0 ? deadWeight * (sectionWeight[sid] / liveTotal) : 0);
      eff.set(r.criterion_id, secShare * (r.nominal_weight / sectionApplicableWeight[sid]));
    }
  } else {
    for (const r of applicable) eff.set(r.criterion_id, r.nominal_weight);
  }
  const effSum = [...eff.values()].reduce((s, w) => s + w, 0);
  for (const r of applicable) {
    r.effective_weight = effSum > 0 ? (eff.get(r.criterion_id) / effSum) * maxScore : 0;
    r.max_points = r.effective_weight;
    r.points = r.effective_weight * (r.normalized ?? 0);
  }

  const computable = effSum > 0;
  const totalRaw = computable ? applicable.reduce((s, r) => s + r.points, 0) : null;
  const { decimals, mode } = scoring.rounding;
  let total = computable ? roundValue(totalRaw, decimals, mode) : null;

  // Gross errors: flag criteria answered "yes".
  const flagRows = rows.filter((r) => r.role === 'flag');
  const flagged = flagRows.filter((r) => r.status === 'scored' && r.answer === 'yes');
  const unknownFlags = flagRows.filter((r) => r.status !== 'scored');
  const grossError = flagRows.length === 0 ? null : flagged.length > 0 ? true : unknownFlags.length ? null : false;

  let criticalApplied = null;
  if (computable && grossError === true) {
    if (scoring.critical_policy === 'zero_total') {
      criticalApplied = { policy: 'zero_total', before: total };
      total = 0;
    } else if (scoring.critical_policy === 'cap_total' && total > scoring.critical_cap) {
      criticalApplied = { policy: 'cap_total', before: total, cap: scoring.critical_cap };
      total = roundValue(scoring.critical_cap, decimals, mode);
    }
  }

  // Sections
  const sections = (checklist.sections || []).map((s) => {
    const inSec = rows.filter((r) => r.section_id === s.id);
    const w = inSec.filter((r) => r.role === 'weighted');
    const app = w.filter((r) => r.effective_weight > 0);
    const pts = app.reduce((sum, r) => sum + r.points, 0);
    const maxPts = app.reduce((sum, r) => sum + r.max_points, 0);
    return {
      section_id: s.id,
      name: s.name,
      criteria_ids: inSec.map((r) => r.criterion_id),
      nominal_weight: w.reduce((sum, r) => sum + r.nominal_weight, 0),
      effective_weight: maxPts,
      points: pts,
      max_points: maxPts,
      score_pct: maxPts > 0 ? roundValue((pts / maxPts) * 100, 2, 'half_up') : null,
      applicable_count: app.length,
      na_count: w.filter((r) => r.status === 'na').length,
      pending_count: w.filter((r) => r.status === 'not_evaluated').length,
      has_flags: inSec.some((r) => r.role === 'flag'),
    };
  });

  const totalNominal = weighted.reduce((s, r) => s + r.nominal_weight, 0);
  const naWeight = weighted.filter((r) => r.status === 'na' && naPolicy !== 'count_as_full').reduce((s, r) => s + r.nominal_weight, 0);
  const pendingWeight = weighted.filter((r) => r.status === 'not_evaluated').reduce((s, r) => s + r.nominal_weight, 0);

  // Human-readable formula (shown in the UI under "Как рассчитан балл").
  let formula;
  if (!computable) {
    formula = 'Нет применимых критериев с весом — итог не рассчитывается.';
  } else {
    const num = applicable.map((r) => `${fmt(r.nominal_weight)}×${fmt(r.normalized, 4)}`).join(' + ');
    const den = applicable.map((r) => fmt(r.nominal_weight)).join(' + ');
    formula = naPolicy === 'redistribute_within_section'
      ? `Итог = Σ(эффективный вес × доля) = ${fmt(totalRaw, 4)} → ${fmt(total, decimals)}`
      : `Итог = (${num}) / (${den}) × ${maxScore} = ${fmt(totalRaw, 4)} → ${fmt(total, decimals)}`;
  }

  return {
    total,
    total_raw: totalRaw,
    max_score: maxScore,
    computable,
    complete: pendingWeight === 0,
    coverage: {
      total_weight: totalNominal,
      applicable_weight: applicable.reduce((s, r) => s + r.nominal_weight, 0),
      na_weight: naWeight,
      pending_weight: pendingWeight,
      criteria_total: rows.length,
      criteria_evaluated: rows.filter((r) => r.status !== 'not_evaluated').length,
    },
    criteria: rows.map((r) => ({
      ...r,
      effective_weight: Number(r.effective_weight.toFixed(6)),
      points: Number(r.points.toFixed(6)),
      max_points: Number(r.max_points.toFixed(6)),
    })),
    sections,
    gross_error: grossError,
    gross_error_criteria: flagged.map((r) => r.criterion_id),
    critical_applied: criticalApplied,
    policy: { na_policy: naPolicy, rounding: { decimals, mode }, critical_policy: scoring.critical_policy },
    formula,
    pass: computable && Number.isFinite(scoring.pass_threshold) ? total >= scoring.pass_threshold : null,
  };
}

/** Compare two score breakdowns (used to show "what changed" after re-evaluation or appeal). */
export function diffScores(before, after) {
  const byIdBefore = new Map((before?.criteria || []).map((c) => [c.criterion_id, c]));
  const byIdAfter = new Map((after?.criteria || []).map((c) => [c.criterion_id, c]));
  const ids = [...new Set([...byIdBefore.keys(), ...byIdAfter.keys()])];
  const changes = ids.map((id) => {
    const a = byIdBefore.get(id);
    const b = byIdAfter.get(id);
    if (!a) return { criterion_id: id, kind: 'added', after: b };
    if (!b) return { criterion_id: id, kind: 'removed', before: a };
    const changed = a.status !== b.status || String(a.answer) !== String(b.answer)
      || Math.abs((a.points || 0) - (b.points || 0)) > 1e-6 || a.nominal_weight !== b.nominal_weight || a.name !== b.name;
    return { criterion_id: id, kind: changed ? 'changed' : 'same', before: a, after: b };
  });
  return {
    total_before: before?.total ?? null,
    total_after: after?.total ?? null,
    delta: Number.isFinite(before?.total) && Number.isFinite(after?.total) ? roundValue(after.total - before.total, 2) : null,
    gross_before: before?.gross_error ?? null,
    gross_after: after?.gross_error ?? null,
    changes,
  };
}
