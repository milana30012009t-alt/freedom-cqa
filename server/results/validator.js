// Strict validator for Results JSON 1.0. Deliberately independent from the exporter and the scoring engine:
// its own criteria table, its own exact (integer) recomputation of final_score, its own UTF-8 check.
// Shared only: the deterministic encoding repair (to compare quotes with the repaired transcript text) and the
// «…» extraction (shared/quotes.js), so the AI layer and this validator agree on what counts as a quote.
import { normalizeText } from '../../shared/text-quality.js';
import { normQuote, quotesToCheck } from '../../shared/quotes.js';

const SPEC = {
  contact: { kind: 'bool', nullable: false, weight: 10 },
  discovery: { kind: 'bool', nullable: true, weight: 15 },
  identification: { kind: 'bool', nullable: true, weight: 20 },
  consultation: { kind: 'scale', values: [0, 5, 10, 15, 20], max: 20, nullable: true, weight: 20 },
  empathy: { kind: 'bool', nullable: false, weight: 15 },
  dialogue: { kind: 'scale', values: [0, 4, 7, 10], max: 10, nullable: false, weight: 15 },
  closure: { kind: 'bool', nullable: true, weight: 5 },
  critical: { kind: 'bool', nullable: false, weight: 0 },
};
const ORDER = Object.keys(SPEC);
const TOP_KEYS = ['schema_version', 'team_name', 'model', 'results'];
const RECORD_KEYS = ['conversation_id', 'status', 'criteria', 'score', 'error'];
const CRITERION_KEYS = ['criterion_id', 'value', 'rationale', 'evidence_turns'];
const SCORE_KEYS = ['final_score', 'critical_flag'];
const MODES = ['local', 'external_api', 'hybrid'];
const PLACEHOLDER_TEAM = /^(?:название команды|team(?: ?name)?|team_name|my team|наша команда|не задано.*|tbd|todo|changeme|<.*>|\.\.\.|-+)$/iu;
const PLACEHOLDER_MODEL = /^(?:фактически использованная модель|model|модель|unknown|неизвестно|tbd|todo|<.*>|\.\.\.|-+)$/iu;
const NO_LLM = /no-?llm|offline rules|офлайн-правил|rule-based|без ai|preview/iu;

const type = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const sameKeys = (obj, keys) => {
  const k = Object.keys(obj);
  return { missing: keys.filter((x) => !k.includes(x)), extra: k.filter((x) => !keys.includes(x)) };
};

/**
 * Exact final score in hundredths, half-up: 100·Σ(w·share)/Σw with share = a/20 (a integer), so
 * cents = round(10000·Σ(w·a) / (20·Σw)) computed with integers (BigInt), no floating point.
 */
export function exactFinalScore(criteria) {
  let num = 0n;
  let den = 0n;
  for (const c of criteria) {
    const spec = SPEC[c.criterion_id];
    if (!spec || spec.weight === 0 || c.value === null) continue;
    const a = spec.kind === 'bool' ? (c.value ? 20 : 0) : (c.value * 20) / spec.max; // integer for official values
    num += BigInt(spec.weight) * BigInt(a);
    den += BigInt(spec.weight);
  }
  if (den === 0n) return null;
  const N = 10000n * num;
  const D = 20n * den;
  const cents = (2n * N + D) / (2n * D); // floor(N/D + 1/2) for N ≥ 0
  return Number(cents) / 100;
}

/**
 * @param {Buffer|string} input file bytes (Buffer) or text
 * @param {object} opts
 * @param {number|null} opts.expectCount required number of records (65 for DEV, 10 for PROD)
 * @param {{records:Array<{conversation_id:string, transcript:Array}>}|null} opts.source the organisers' data
 * @param {'submission'|'preview'} opts.mode preview relaxes only the team/model checks
 */
export function validateResults(input, { expectCount = null, source = null, mode = 'submission' } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  const warn = (path, msg) => warnings.push(`${path}: ${msg}`);
  const stats = { records: 0, ok: 0, error: 0, criteria: 0, evidence_turns: 0, quotes_checked: 0 };

  // --- bytes → UTF-8 text → JSON
  let text;
  if (Buffer.isBuffer(input)) {
    if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) err('file', 'BOM в начале файла (нужен UTF-8 без BOM)');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      err('file', 'файл не является корректным UTF-8');
      return { ok: false, errors, warnings, stats };
    }
  } else text = String(input);
  let doc;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    err('file', `некорректный JSON: ${e.message}`);
    return { ok: false, errors, warnings, stats };
  }
  if (type(doc) !== 'object') {
    err('$', 'верхний уровень должен быть объектом');
    return { ok: false, errors, warnings, stats };
  }

  // --- top level
  const top = sameKeys(doc, TOP_KEYS);
  top.missing.forEach((k) => err('$', `нет поля «${k}»`));
  top.extra.forEach((k) => err('$', `лишнее поле «${k}»`));
  if (doc.schema_version !== '1.0') err('$.schema_version', `должно быть строкой "1.0", получено ${JSON.stringify(doc.schema_version)}`);
  if (type(doc.team_name) !== 'string' || !doc.team_name.trim()) err('$.team_name', 'название команды не заполнено');
  else if (PLACEHOLDER_TEAM.test(doc.team_name.trim())) (mode === 'submission' ? err : warn)('$.team_name', `похоже на заглушку: «${doc.team_name}»`);
  if (type(doc.model) !== 'object') err('$.model', 'должно быть объектом {mode, name}');
  else {
    const mk = sameKeys(doc.model, ['mode', 'name']);
    mk.missing.forEach((k) => err('$.model', `нет поля «${k}»`));
    mk.extra.forEach((k) => err('$.model', `лишнее поле «${k}»`));
    if (!MODES.includes(doc.model.mode)) err('$.model.mode', `допустимо local / external_api / hybrid, получено ${JSON.stringify(doc.model.mode)}`);
    if (type(doc.model.name) !== 'string' || !doc.model.name.trim()) err('$.model.name', 'не заполнено');
    else if (PLACEHOLDER_MODEL.test(doc.model.name.trim())) err('$.model.name', `заглушка вместо фактической модели: «${doc.model.name}»`);
    else if (NO_LLM.test(doc.model.name)) (mode === 'submission' ? err : warn)('$.model.name', `оценки получены не языковой моделью: «${doc.model.name}» — такой файл нельзя сдавать как результат модели`);
  }
  if (type(doc.results) !== 'array') {
    err('$.results', 'должно быть массивом');
    return { ok: errors.length === 0, errors, warnings, stats };
  }

  // --- records
  stats.records = doc.results.length;
  if (expectCount !== null && doc.results.length !== expectCount) err('$.results', `ожидается ровно ${expectCount} записей, в файле ${doc.results.length}`);
  const sourceById = new Map((source?.records || []).map((r) => [String(r.conversation_id), r]));
  const seen = new Set();
  doc.results.forEach((rec, i) => {
    const p = `$.results[${i}]`;
    if (type(rec) !== 'object') { err(p, 'запись должна быть объектом'); return; }
    const rk = sameKeys(rec, RECORD_KEYS);
    rk.missing.forEach((k) => err(p, `нет поля «${k}»`));
    rk.extra.forEach((k) => err(p, `лишнее поле «${k}»`));
    const id = rec.conversation_id;
    if (type(id) !== 'string' || !id) err(`${p}.conversation_id`, 'должно быть непустой строкой');
    else {
      if (seen.has(id)) err(`${p}.conversation_id`, `дубликат «${id}»`);
      seen.add(id);
      if (source && !sourceById.has(id)) err(`${p}.conversation_id`, `«${id}» нет в исходном наборе организаторов`);
    }
    const src = sourceById.get(id);
    const transcript = Array.isArray(src?.transcript) ? src.transcript : null;
    const texts = transcript ? transcript.map((m) => normQuote(normalizeText(String(m?.text ?? ''), {}).text)) : null;

    if (rec.status === 'error') {
      stats.error += 1;
      if (type(rec.criteria) !== 'array' || rec.criteria.length !== 0) err(`${p}.criteria`, 'у записи с ошибкой должно быть []');
      if (rec.score !== null) err(`${p}.score`, 'у записи с ошибкой должно быть null');
      if (type(rec.error) !== 'string' || !rec.error.trim()) err(`${p}.error`, 'нужна причина ошибки');
      return;
    }
    if (rec.status !== 'ok') { err(`${p}.status`, `допустимо "ok" или "error", получено ${JSON.stringify(rec.status)}`); return; }
    stats.ok += 1;
    if (rec.error !== null) err(`${p}.error`, 'у успешной записи должно быть null');
    if (type(rec.criteria) !== 'array') { err(`${p}.criteria`, 'должно быть массивом'); return; }
    if (rec.criteria.length !== 8) err(`${p}.criteria`, `ровно 8 критериев, получено ${rec.criteria.length}`);
    const ids = new Set();
    rec.criteria.forEach((c, j) => {
      const cp = `${p}.criteria[${j}]`;
      if (type(c) !== 'object') { err(cp, 'должно быть объектом'); return; }
      stats.criteria += 1;
      const ck = sameKeys(c, CRITERION_KEYS);
      ck.missing.forEach((k) => err(cp, `нет поля «${k}»`));
      ck.extra.forEach((k) => err(cp, `лишнее поле «${k}»`));
      const spec = SPEC[c.criterion_id];
      if (!spec) { err(`${cp}.criterion_id`, `неизвестный критерий ${JSON.stringify(c.criterion_id)}`); return; }
      if (ids.has(c.criterion_id)) err(`${cp}.criterion_id`, `«${c.criterion_id}» повторяется`);
      ids.add(c.criterion_id);
      // value
      if (c.value === null) { if (!spec.nullable) err(`${cp}.value`, `null недопустим для ${c.criterion_id}`); }
      else if (spec.kind === 'bool') { if (typeof c.value !== 'boolean') err(`${cp}.value`, `для ${c.criterion_id} нужен true/false${spec.nullable ? '/null' : ''}, получено ${JSON.stringify(c.value)}`); }
      else if (typeof c.value !== 'number' || !spec.values.includes(c.value)) err(`${cp}.value`, `для ${c.criterion_id} допустимо ${spec.values.join('/')}${spec.nullable ? '/null' : ''}, получено ${JSON.stringify(c.value)}`);
      // rationale
      if (type(c.rationale) !== 'string' || !c.rationale.trim()) err(`${cp}.rationale`, 'пустое обоснование');
      // evidence_turns: 1-based indices over ALL transcript messages (client, bot, operator, system)
      if (type(c.evidence_turns) !== 'array') { err(`${cp}.evidence_turns`, 'должно быть массивом'); return; }
      const turns = c.evidence_turns;
      stats.evidence_turns += turns.length;
      if (!turns.length) (c.value === null ? warn : err)(`${cp}.evidence_turns`, 'нет доказательных реплик');
      if (new Set(turns).size !== turns.length) err(`${cp}.evidence_turns`, 'повторяющиеся номера');
      turns.forEach((t) => {
        if (!Number.isInteger(t) || t < 1) err(`${cp}.evidence_turns`, `номер реплики должен быть целым ≥ 1, получено ${JSON.stringify(t)}`);
        else if (transcript && t > transcript.length) err(`${cp}.evidence_turns`, `реплики №${t} нет: в транскрипте ${transcript.length} сообщений`);
      });
      if (turns.some((t, k) => k > 0 && t < turns[k - 1])) warn(`${cp}.evidence_turns`, 'номера не по возрастанию');
      // quotes in the rationale must exist in the transcript (no invented quotes)
      if (texts && type(c.rationale) === 'string') {
        // «…» followed by a message time, or ≥ 12 characters, claims to be verbatim (nesting-aware extraction)
        for (const { text: q } of quotesToCheck(c.rationale)) {
          const nq = normQuote(q);
          if (nq.length < 4) continue;
          stats.quotes_checked += 1;
          const hit = texts.findIndex((t) => t.includes(nq));
          if (hit < 0) err(`${cp}.rationale`, `цитаты нет в транскрипте: «${q.slice(0, 60)}»`);
          else if (!turns.includes(hit + 1) && !texts.some((t, k) => turns.includes(k + 1) && t.includes(nq))) warn(`${cp}.evidence_turns`, `процитированная реплика №${hit + 1} не указана в evidence_turns`);
        }
      }
    });
    ORDER.filter((k) => !ids.has(k)).forEach((k) => err(`${p}.criteria`, `нет критерия «${k}»`));
    // score
    if (type(rec.score) !== 'object') { err(`${p}.score`, 'должно быть объектом {final_score, critical_flag}'); return; }
    const sk = sameKeys(rec.score, SCORE_KEYS);
    sk.missing.forEach((k) => err(`${p}.score`, `нет поля «${k}»`));
    sk.extra.forEach((k) => err(`${p}.score`, `лишнее поле «${k}»`));
    const crit = rec.criteria.find((c) => c?.criterion_id === 'critical');
    if (typeof rec.score.critical_flag !== 'boolean') err(`${p}.score.critical_flag`, 'должно быть true/false');
    else if (crit && rec.score.critical_flag !== crit.value) err(`${p}.score.critical_flag`, `${rec.score.critical_flag} не совпадает с critical.value = ${crit.value}`);
    const valuesOk = rec.criteria.every((c) => c && SPEC[c.criterion_id] && (c.value === null || (SPEC[c.criterion_id].kind === 'bool' ? typeof c.value === 'boolean' : SPEC[c.criterion_id].values.includes(c.value))));
    if (typeof rec.score.final_score !== 'number' || !Number.isFinite(rec.score.final_score)) err(`${p}.score.final_score`, 'должно быть числом');
    else {
      if (rec.score.final_score < 0 || rec.score.final_score > 100) err(`${p}.score.final_score`, 'вне диапазона 0–100');
      const cents = rec.score.final_score * 100;
      if (Math.abs(cents - Math.round(cents)) > 1e-6) err(`${p}.score.final_score`, 'больше двух знаков после запятой');
      if (valuesOk && rec.criteria.length === 8) {
        const expected = exactFinalScore(rec.criteria);
        if (expected === null) err(`${p}.score.final_score`, 'нет применимых критериев с весом — итог не рассчитывается');
        else if (Math.abs(expected - rec.score.final_score) > 1e-9) err(`${p}.score.final_score`, `${rec.score.final_score} ≠ независимый пересчёт ${expected}`);
      }
    }
  });
  if (source) {
    const missing = [...sourceById.keys()].filter((id) => !seen.has(id));
    if (missing.length) err('$.results', `нет записей для исходных диалогов: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` и ещё ${missing.length - 10}` : ''}`);
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}
