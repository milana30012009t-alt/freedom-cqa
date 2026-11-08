// Checklist model: validation, normalisation and answer helpers.
// The checklist is pure configuration: no criterion, weight, scale or N/A rule is hardcoded
// anywhere else in the system.

import { DETECTORS } from './detector-catalog.js';

export const ANSWER_TYPES = Object.freeze(['binary', 'scale', 'options']);
export const ANSWER_TYPE_LABELS = Object.freeze({
  binary: 'Да / Нет',
  scale: 'Числовая шкала',
  options: 'Варианты ответа',
});
export const SCORING_ROLES = Object.freeze(['weighted', 'flag']);
export const NA_POLICIES = Object.freeze({
  redistribute_proportional: 'Пропорционально между всеми применимыми критериями',
  redistribute_within_section: 'Сначала внутри своей секции',
  count_as_full: 'Считать N/A как полный балл',
});
export const ROUNDING_MODES = Object.freeze({
  half_up: 'Математическое (0,5 → вверх)',
  half_even: 'Банковское (к чётному)',
  floor: 'Вниз',
  ceil: 'Вверх',
  none: 'Без округления',
});
export const CRITICAL_POLICIES = Object.freeze({
  flag_only: 'Только отметка, балл не меняется',
  zero_total: 'Обнулять итог при грубой ошибке',
  cap_total: 'Ограничивать итог (потолок)',
});
export const EVALUATION_MODES = Object.freeze({
  auto: 'AI, если подключён; иначе офлайн-детектор',
  llm: 'Только AI (без AI — не оценивается)',
  rules: 'Всегда офлайн-детектор',
});

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const YES_WORDS = new Set(['yes', 'да', 'иә', 'true', '1', 'y']);
const NO_WORDS = new Set(['no', 'нет', 'жоқ', 'false', '0', 'n']);

function str(v, max = 4000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : v === undefined || v === null ? '' : String(v).trim().slice(0, max);
}

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Validate and normalise a checklist definition.
 * @returns {{ok:boolean, errors:Array<{path:string,message:string}>, warnings:Array<{path:string,message:string}>, checklist:object|null}}
 */
export function validateChecklist(input) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ path: '', message: 'Чек-лист должен быть JSON-объектом' }], warnings, checklist: null };
  }

  const scoringIn = input.scoring && typeof input.scoring === 'object' ? input.scoring : {};
  const roundingIn = scoringIn.rounding && typeof scoringIn.rounding === 'object' ? scoringIn.rounding : {};
  const scoring = {
    max_score: Number.isFinite(num(scoringIn.max_score)) && num(scoringIn.max_score) > 0 ? num(scoringIn.max_score) : 100,
    na_policy: NA_POLICIES[scoringIn.na_policy] ? scoringIn.na_policy : 'redistribute_proportional',
    rounding: {
      mode: ROUNDING_MODES[roundingIn.mode] ? roundingIn.mode : 'half_up',
      decimals: Number.isInteger(num(roundingIn.decimals)) && num(roundingIn.decimals) >= 0 && num(roundingIn.decimals) <= 4
        ? num(roundingIn.decimals) : 2,
    },
    critical_policy: CRITICAL_POLICIES[scoringIn.critical_policy] ? scoringIn.critical_policy : 'flag_only',
    critical_cap: Number.isFinite(num(scoringIn.critical_cap)) ? num(scoringIn.critical_cap) : 0,
    pass_threshold: Number.isFinite(num(scoringIn.pass_threshold)) ? num(scoringIn.pass_threshold) : null,
  };
  if (scoringIn.na_policy && !NA_POLICIES[scoringIn.na_policy]) err('scoring.na_policy', `Неизвестное правило N/A: ${scoringIn.na_policy}`);
  if (roundingIn.mode && !ROUNDING_MODES[roundingIn.mode]) err('scoring.rounding.mode', `Неизвестный режим округления: ${roundingIn.mode}`);

  const paramsIn = input.parameters && typeof input.parameters === 'object' ? input.parameters : {};
  const parameters = {};
  for (const [k, v] of Object.entries(paramsIn)) {
    if (/^[a-z0-9_]{1,60}$/.test(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) parameters[k] = v;
  }

  // Sections
  const sections = [];
  const sectionIds = new Set();
  (Array.isArray(input.sections) ? input.sections : []).forEach((s, i) => {
    const id = str(s?.id, 40);
    if (!ID_RE.test(id)) { err(`sections[${i}].id`, 'ID секции: латиница, цифры, «_» или «-», до 40 символов'); return; }
    if (sectionIds.has(id)) { err(`sections[${i}].id`, `Повторяющийся ID секции «${id}»`); return; }
    sectionIds.add(id);
    const name = str(s?.name, 200);
    if (!name) err(`sections[${i}].name`, 'Укажите название секции');
    sections.push({ id, name });
  });

  // Criteria
  const criteria = [];
  const criterionIds = new Set();
  const rawCriteria = Array.isArray(input.criteria) ? input.criteria : [];
  if (!rawCriteria.length) err('criteria', 'Добавьте хотя бы один критерий');

  rawCriteria.forEach((c, i) => {
    const p = `criteria[${i}]`;
    if (!c || typeof c !== 'object') { err(p, 'Критерий должен быть объектом'); return; }
    const id = str(c.id, 40);
    if (!ID_RE.test(id)) err(`${p}.id`, 'ID критерия: латиница, цифры, «_» или «-», до 40 символов');
    else if (criterionIds.has(id)) err(`${p}.id`, `Повторяющийся ID критерия «${id}»`);
    criterionIds.add(id);

    const name = str(c.name, 200);
    if (!name) err(`${p}.name`, 'Укажите название критерия');

    const answerType = ANSWER_TYPES.includes(c.answer_type) ? c.answer_type : null;
    if (!answerType) err(`${p}.answer_type`, `Тип ответа должен быть одним из: ${ANSWER_TYPES.join(', ')}`);

    const role = SCORING_ROLES.includes(c.scoring_role) ? c.scoring_role : 'weighted';
    let weight = num(c.weight);
    if (role === 'flag') weight = 0;
    else if (!Number.isFinite(weight) || weight < 0) { err(`${p}.weight`, 'Вес — неотрицательное число'); weight = 0; }
    else if (weight === 0) warn(`${p}.weight`, `Критерий «${name || id}» имеет вес 0 и не влияет на итог`);

    const sectionId = str(c.section_id, 40);
    if (sections.length && sectionId && !sectionIds.has(sectionId)) err(`${p}.section_id`, `Секция «${sectionId}» не найдена`);
    if (sections.length && !sectionId) warn(`${p}.section_id`, `Критерий «${name || id}» не привязан к секции`);

    const out = {
      id,
      code: str(c.code, 10) || String(i + 1).padStart(2, '0'),
      section_id: sectionId || null,
      name,
      description: str(c.description, 4000),
      guidance: str(c.guidance, 6000),
      answer_type: answerType,
      scoring_role: role,
      weight,
      na_allowed: Boolean(c.na_allowed),
      na_condition: str(c.na_condition, 2000),
      enabled: c.enabled !== false,
      evaluation_mode: EVALUATION_MODES[c.evaluation_mode] ? c.evaluation_mode : 'auto',
      detector: null,
    };

    if (answerType === 'binary') {
      const b = c.binary && typeof c.binary === 'object' ? c.binary : {};
      out.binary = { yes_label: str(b.yes_label, 60) || 'Да', no_label: str(b.no_label, 60) || 'Нет' };
    } else if (answerType === 'scale') {
      const s = c.scale && typeof c.scale === 'object' ? c.scale : {};
      const min = num(s.min);
      const max = num(s.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        err(`${p}.scale`, 'Для шкалы задайте min < max');
      }
      const steps = [];
      const seen = new Set();
      (Array.isArray(s.steps) ? s.steps : []).forEach((st, j) => {
        const v = num(st?.value);
        if (!Number.isFinite(v)) { err(`${p}.scale.steps[${j}]`, 'Значение ступени — число'); return; }
        if (Number.isFinite(min) && Number.isFinite(max) && (v < min || v > max)) err(`${p}.scale.steps[${j}]`, `Ступень ${v} вне диапазона ${min}–${max}`);
        if (seen.has(v)) { err(`${p}.scale.steps[${j}]`, `Повторяющаяся ступень ${v}`); return; }
        seen.add(v);
        steps.push({ value: v, label: str(st?.label, 500) });
      });
      steps.sort((a, b) => b.value - a.value);
      let step = num(s.step);
      if (!steps.length && (!Number.isFinite(step) || step <= 0)) step = 1;
      if (steps.length && Number.isFinite(max) && !seen.has(max)) {
        warn(`${p}.scale.steps`, 'Верхняя ступень шкалы должна совпадать с max (она даёт полный вес критерия)');
      }
      out.scale = { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 1, step: steps.length ? null : step, steps };
    } else if (answerType === 'options') {
      const opts = [];
      const seen = new Set();
      (Array.isArray(c.options) ? c.options : []).forEach((o, j) => {
        const value = str(o?.value, 60);
        const score = num(o?.score);
        if (!value) { err(`${p}.options[${j}].value`, 'Укажите значение варианта'); return; }
        if (seen.has(value)) { err(`${p}.options[${j}].value`, `Повторяющийся вариант «${value}»`); return; }
        if (!Number.isFinite(score) || score < 0 || score > 1) err(`${p}.options[${j}].score`, 'Доля балла варианта — число от 0 до 1');
        seen.add(value);
        opts.push({ value, label: str(o?.label, 200) || value, score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0 });
      });
      if (opts.length < 2) err(`${p}.options`, 'Нужно минимум два варианта ответа');
      if (opts.length && !opts.some((o) => o.score === 1)) warn(`${p}.options`, 'Ни один вариант не даёт полный балл (1.0)');
      out.options = opts;
    }

    if (role === 'flag') {
      if (answerType !== 'binary') err(`${p}.answer_type`, 'Критерий-флаг (без баллов) должен иметь тип «Да / Нет»');
      out.flag_subtypes = (Array.isArray(c.flag_subtypes) ? c.flag_subtypes : [])
        .map((f) => ({ id: str(f?.id, 40), name: str(f?.name, 200), description: str(f?.description, 1000) }))
        .filter((f) => ID_RE.test(f.id) && f.name);
    }

    if (c.detector && typeof c.detector === 'object' && c.detector.type) {
      const type = str(c.detector.type, 60);
      if (!DETECTORS[type]) err(`${p}.detector.type`, `Неизвестный детектор «${type}»`);
      else {
        const allowed = DETECTORS[type].answer_types;
        if (answerType && !allowed.includes(answerType)) warn(`${p}.detector`, `Детектор «${DETECTORS[type].name}» обычно используется с типами: ${allowed.join(', ')}`);
        const params = {};
        const defaults = DETECTORS[type].params || {};
        const pin = c.detector.params && typeof c.detector.params === 'object' ? c.detector.params : {};
        for (const [k, dv] of Object.entries(defaults)) {
          const v = pin[k];
          if (typeof dv === 'number') params[k] = Number.isFinite(num(v)) ? num(v) : dv;
          else params[k] = v === undefined ? dv : str(v, 4000);
        }
        out.detector = { type, params };
      }
    }
    if (!out.detector && out.evaluation_mode === 'rules') {
      err(`${p}.evaluation_mode`, 'Режим «Всегда офлайн-детектор» требует выбрать детектор');
    }
    criteria.push(out);
  });

  const weighted = criteria.filter((c) => c.enabled && c.scoring_role === 'weighted');
  const totalWeight = weighted.reduce((s, c) => s + (c.weight || 0), 0);
  if (!weighted.length) err('criteria', 'Нужен хотя бы один включённый критерий с весом');
  else if (totalWeight <= 0) err('criteria', 'Сумма весов включённых критериев должна быть больше 0');
  else if (Math.abs(totalWeight - scoring.max_score) > 1e-9) {
    warn('criteria', `Сумма весов = ${round2(totalWeight)}, а максимум = ${scoring.max_score}. Итог будет пропорционально приведён к ${scoring.max_score}.`);
  }

  // Additional risk signals (outside the scored checklist). Purely informational: they route
  // conversations to manual review but never change the score by themselves.
  const riskRules = [];
  const riskIds = new Set();
  (Array.isArray(input.risk_rules) ? input.risk_rules : []).forEach((r, i) => {
    const id = str(r?.id, 40);
    if (!ID_RE.test(id) || riskIds.has(id)) { err(`risk_rules[${i}].id`, 'Некорректный или повторяющийся ID сигнала риска'); return; }
    riskIds.add(id);
    riskRules.push({
      id,
      name: str(r?.name, 200) || id,
      description: str(r?.description, 1000),
      severity: ['critical', 'high', 'medium', 'low'].includes(r?.severity) ? r.severity : 'high',
      enabled: r?.enabled !== false,
      flag_subtype: str(r?.flag_subtype, 40) || null,
    });
  });

  const checklist = {
    schema_version: 1,
    id: ID_RE.test(str(input.id, 40)) ? str(input.id, 40) : 'checklist',
    name: str(input.name, 200) || 'Чек-лист',
    description: str(input.description, 2000),
    official: Boolean(input.official),
    source: str(input.source, 500),
    instructions: str(input.instructions, 12000),
    notes: str(input.notes, 2000),
    scoring,
    parameters,
    sections,
    criteria,
    risk_rules: riskRules,
  };
  return { ok: errors.length === 0, errors, warnings, checklist: errors.length ? null : checklist };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/** All answers allowed for a criterion with their normalised share (0..1). */
export function allowedAnswers(criterion) {
  if (!criterion) return [];
  if (criterion.answer_type === 'binary') {
    const b = criterion.binary || {};
    return [
      { value: 'yes', label: b.yes_label || 'Да', score: 1 },
      { value: 'no', label: b.no_label || 'Нет', score: 0 },
    ];
  }
  if (criterion.answer_type === 'scale') {
    const { min = 0, max = 1, steps = [], step } = criterion.scale || {};
    const span = max - min || 1;
    if (steps && steps.length) {
      return [...steps].sort((a, b) => b.value - a.value)
        .map((s) => ({ value: s.value, label: s.label ? `${s.value} — ${s.label}` : String(s.value), short: String(s.value), score: (s.value - min) / span }));
    }
    const out = [];
    const st = step && step > 0 ? step : 1;
    for (let v = max; v >= min - 1e-9; v -= st) {
      const vv = Number(v.toFixed(6));
      out.push({ value: vv, label: String(vv), short: String(vv), score: (vv - min) / span });
    }
    return out;
  }
  if (criterion.answer_type === 'options') {
    return (criterion.options || []).map((o) => ({ value: o.value, label: o.label, score: o.score }));
  }
  return [];
}

/** Convert a raw answer (from AI, UI or import) to the canonical value, or null when invalid. */
export function normalizeAnswer(criterion, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (criterion.answer_type === 'binary') {
    if (typeof raw === 'boolean') return raw ? 'yes' : 'no';
    const s = String(raw).trim().toLowerCase();
    if (YES_WORDS.has(s)) return 'yes';
    if (NO_WORDS.has(s)) return 'no';
    const b = criterion.binary || {};
    if (b.yes_label && s === b.yes_label.toLowerCase()) return 'yes';
    if (b.no_label && s === b.no_label.toLowerCase()) return 'no';
    return null;
  }
  if (criterion.answer_type === 'scale') {
    const n = num(typeof raw === 'string' ? raw.replace(/[^\d.,-]/g, '') : raw);
    if (!Number.isFinite(n)) return null;
    const allowed = allowedAnswers(criterion);
    const hit = allowed.find((a) => Math.abs(a.value - n) < 1e-9);
    return hit ? hit.value : null;
  }
  if (criterion.answer_type === 'options') {
    const s = String(raw).trim().toLowerCase();
    const hit = (criterion.options || []).find((o) => o.value.toLowerCase() === s || o.label.toLowerCase() === s);
    return hit ? hit.value : null;
  }
  return null;
}

/** Normalised share 0..1 for a canonical answer, or null. */
export function answerScore(criterion, value) {
  const hit = allowedAnswers(criterion).find((a) => a.value === value || String(a.value) === String(value));
  return hit ? hit.score : null;
}

export function answerLabel(criterion, value) {
  if (value === null || value === undefined) return '—';
  const hit = allowedAnswers(criterion).find((a) => a.value === value || String(a.value) === String(value));
  if (!hit) return String(value);
  return criterion.answer_type === 'scale' ? `${hit.short} из ${criterion.scale.max}` : hit.label;
}

/** A/B/C situation for a given answer (flag criteria: "yes" means a violation was found). */
export function situationForAnswer(criterion, value, status = 'scored') {
  if (status === 'na') return 'na';
  if (status !== 'scored' || value === null || value === undefined) return 'unclear';
  if (criterion.scoring_role === 'flag') return value === 'yes' ? 'not_met' : 'met';
  const s = answerScore(criterion, value);
  if (s === null) return 'unclear';
  if (s >= 0.999) return 'met';
  if (s <= 0.001) return 'not_met';
  return 'partial';
}

/**
 * Pick the answer that corresponds to a situation (used by deterministic detectors that
 * reason in terms of met / partial / not_met). `share` (0..1) refines the choice on scales.
 */
export function answerForSituation(criterion, situation, share) {
  const allowed = allowedAnswers(criterion);
  if (!allowed.length) return null;
  const best = allowed.reduce((a, b) => (b.score > a.score ? b : a));
  const worst = allowed.reduce((a, b) => (b.score < a.score ? b : a));
  if (situation === 'met') return best.value;
  if (situation === 'not_met') return worst.value;
  if (criterion.answer_type === 'binary') return 'no';
  const target = Number.isFinite(share) ? share : 0.5;
  return allowed.reduce((a, b) => (Math.abs(b.score - target) < Math.abs(a.score - target) ? b : a)).value;
}

/** Describe the allowed answers in plain text (for prompts and UI hints). */
export function describeAnswers(criterion) {
  if (criterion.answer_type === 'binary') {
    return criterion.scoring_role === 'flag'
      ? `"yes" (${criterion.binary.yes_label}: нарушение выявлено) или "no" (${criterion.binary.no_label}: не выявлено)`
      : `"yes" (${criterion.binary.yes_label}) или "no" (${criterion.binary.no_label})`;
  }
  if (criterion.answer_type === 'scale') {
    return `одно из значений: ${allowedAnswers(criterion).map((a) => a.value).join(', ')}`;
  }
  return `одно из значений: ${allowedAnswers(criterion).map((a) => `"${a.value}"`).join(', ')}`;
}

/** Stable short fingerprint of what matters for answers (used to carry over reviewer decisions). */
export function answerSchemaKey(criterion) {
  const role = criterion.scoring_role;
  const answers = allowedAnswers(criterion).map((a) => `${a.value}:${a.score}`).join('|');
  return `${criterion.answer_type}/${role}/${criterion.na_allowed ? 'na' : 'nona'}/${answers}`;
}
