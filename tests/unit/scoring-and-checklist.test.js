import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChecklist, normalizeAnswer, answerForSituation, allowedAnswers } from '../../shared/checklist-schema.js';
import { computeScore, roundValue, diffScores } from '../../shared/scoring-engine.js';
import { readJson, OFFICIAL_CHECKLIST } from '../helpers.js';

const official = () => validateChecklist(readJson(OFFICIAL_CHECKLIST)).checklist;
const R = (criterion_id, status, answer = null) => ({ criterion_id, status, answer });

test('official checklist (PDF) validates: 8 criteria, weights 10/15/20/20/15/15/5 + flag, scales 0–20 and 0–10', () => {
  const v = validateChecklist(readJson(OFFICIAL_CHECKLIST));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const cl = v.checklist;
  assert.equal(cl.criteria.length, 8);
  assert.deepEqual(cl.criteria.map((c) => c.weight), [10, 15, 20, 20, 15, 15, 5, 0]);
  assert.deepEqual(allowedAnswers(cl.criteria[3]).map((a) => a.value), [20, 15, 10, 5, 0]);
  assert.deepEqual(allowedAnswers(cl.criteria[5]).map((a) => a.value), [10, 7, 4, 0]);
  assert.equal(cl.criteria[7].scoring_role, 'flag');
  assert.deepEqual(cl.criteria.map((c) => c.na_allowed), [false, true, true, true, false, false, true, false]);
  assert.equal(cl.scoring.rounding.decimals, 2);
  assert.equal(cl.parameters.first_response_threshold_sec, 180);
});

test('weighted scoring: Да = full weight, Нет = 0, scale proportional (top step = full weight)', () => {
  const cl = official();
  const s = computeScore(cl, [
    R('contact', 'scored', 'yes'), R('need_discovery', 'scored', 'no'), R('identification', 'scored', 'yes'), R('consultation', 'scored', 15),
    R('empathy', 'scored', 'yes'), R('dialog_management', 'scored', 7), R('closing', 'scored', 'yes'), R('gross_errors', 'scored', 'no'),
  ]);
  // 10 + 0 + 20 + 20*0.75 + 15 + 15*0.7 + 5 = 75.5
  assert.equal(s.total, 75.5);
  assert.equal(s.computable, true);
  assert.equal(s.gross_error, false);
});

test('N/A: weights are redistributed proportionally among applicable criteria (max stays 100)', () => {
  const cl = official();
  const s = computeScore(cl, [
    R('contact', 'scored', 'yes'), R('need_discovery', 'na'), R('identification', 'na'), R('consultation', 'scored', 10),
    R('empathy', 'scored', 'yes'), R('dialog_management', 'scored', 10), R('closing', 'na'), R('gross_errors', 'scored', 'no'),
  ]);
  // applicable weights 10+20+15+15 = 60 → (10 + 20*0.5 + 15 + 15) / 60 * 100 = 83.333… → 83.33
  assert.equal(s.total, 83.33);
  const eff = Object.fromEntries(s.criteria.map((c) => [c.criterion_id, c.effective_weight]));
  assert.ok(Math.abs(eff.contact - 16.666667) < 1e-5);
  assert.equal(eff.need_discovery, 0);
  assert.ok(Math.abs(s.criteria.reduce((x, c) => x + c.effective_weight, 0) - 100) < 1e-6);
});

test('N/A within-section policy and "count as full" policy (configurable, non-official)', () => {
  const base = official();
  const results = [R('contact', 'scored', 'yes'), R('need_discovery', 'na'), R('identification', 'scored', 'no'), R('consultation', 'scored', 20),
    R('empathy', 'scored', 'yes'), R('dialog_management', 'scored', 10), R('closing', 'scored', 'yes'), R('gross_errors', 'scored', 'no')];
  const within = computeScore({ ...base, scoring: { ...base.scoring, na_policy: 'redistribute_within_section' } }, results);
  // opening section keeps its 25 points on "contact"; total = 100 - 20 (identification) = 80
  assert.equal(within.total, 80);
  const full = computeScore({ ...base, scoring: { ...base.scoring, na_policy: 'count_as_full' } }, results);
  assert.equal(full.total, 80);
  const prop = computeScore(base, results);
  assert.equal(prop.total, 76.47); // 65/85
});

test('rounding: two decimals half-up by default; other modes available', () => {
  assert.equal(roundValue(1.005, 2), 1.01);
  assert.equal(roundValue(83.3333, 2), 83.33);
  assert.equal(roundValue(92.665, 2), 92.67);
  assert.equal(roundValue(2.5, 0, 'half_even'), 2);
  assert.equal(roundValue(3.5, 0, 'half_even'), 4);
  assert.equal(roundValue(7.99, 0, 'floor'), 7);
  assert.equal(roundValue(7.01, 0, 'ceil'), 8);
});

test('no applicable weighted criteria → total is not computed', () => {
  const cl = official();
  const s = computeScore(cl, cl.criteria.map((c) => (c.scoring_role === 'flag' ? R(c.id, 'scored', 'no') : R(c.id, c.na_allowed ? 'na' : 'not_evaluated'))));
  assert.equal(s.total, null);
  assert.equal(s.computable, false);
});

test('gross error flag is marked separately and does not change the total (flag_only); zero/cap policies work', () => {
  const cl = official();
  const results = cl.criteria.map((c) => (c.scoring_role === 'flag' ? R(c.id, 'scored', 'yes') : R(c.id, 'scored', c.answer_type === 'scale' ? c.scale.max : 'yes')));
  const s = computeScore(cl, results);
  assert.equal(s.total, 100);
  assert.equal(s.gross_error, true);
  assert.deepEqual(s.gross_error_criteria, ['gross_errors']);
  assert.equal(computeScore({ ...cl, scoring: { ...cl.scoring, critical_policy: 'zero_total' } }, results).total, 0);
  assert.equal(computeScore({ ...cl, scoring: { ...cl.scoring, critical_policy: 'cap_total', critical_cap: 40 } }, results).total, 40);
});

test('invalid answers and forbidden N/A never become silent zeros', () => {
  const cl = official();
  const s = computeScore(cl, [R('contact', 'na'), R('consultation', 'scored', 12)]);
  const byId = Object.fromEntries(s.criteria.map((c) => [c.criterion_id, c]));
  assert.equal(byId.contact.status, 'not_evaluated');
  assert.equal(byId.consultation.status, 'not_evaluated');
  assert.equal(s.complete, false);
});

test('reviewer override recalculates the total; diff shows the change', () => {
  const cl = official();
  const results = [R('contact', 'scored', 'no'), R('need_discovery', 'na'), R('identification', 'na'), R('consultation', 'scored', 20),
    R('empathy', 'scored', 'yes'), R('dialog_management', 'scored', 10), R('closing', 'scored', 'yes'), R('gross_errors', 'scored', 'no')];
  const before = computeScore(cl, results);
  const after = computeScore(cl, results, { overrides: { contact: { status: 'scored', answer: 'yes' } } });
  assert.equal(before.total, 84.62); // 55/65
  assert.equal(after.total, 100);
  const d = diffScores(before, after);
  assert.equal(d.delta, 15.38);
  assert.equal(d.changes.find((c) => c.criterion_id === 'contact').kind, 'changed');
});

test('answer normalisation for RU/EN/boolean inputs and scale steps', () => {
  const cl = official();
  const [contact, , , consultation] = cl.criteria;
  assert.equal(normalizeAnswer(contact, 'Да'), 'yes');
  assert.equal(normalizeAnswer(contact, false), 'no');
  assert.equal(normalizeAnswer(consultation, '15'), 15);
  assert.equal(normalizeAnswer(consultation, 12), null);
  assert.equal(answerForSituation(consultation, 'partial', 0.5), 10);
  assert.equal(answerForSituation(contact, 'met'), 'yes');
});

test('checklist validation reports structural errors', () => {
  const bad = validateChecklist({
    sections: [{ id: 's1', name: 'S' }],
    criteria: [
      { id: 'a', name: 'A', answer_type: 'scale', scale: { min: 5, max: 5 }, weight: 10, section_id: 's1' },
      { id: 'a', name: 'B', answer_type: 'options', options: [{ value: 'x', label: 'X', score: 2 }], weight: -1, section_id: 'nope' },
      { id: 'Bad Id', name: '', answer_type: 'weird' },
    ],
  });
  assert.equal(bad.ok, false);
  const paths = bad.errors.map((e) => e.path).join(' ');
  for (const p of ['criteria[0].scale', 'criteria[1].id', 'criteria[1].weight', 'criteria[1].section_id', 'criteria[1].options', 'criteria[2].id', 'criteria[2].name', 'criteria[2].answer_type']) {
    assert.ok(paths.includes(p), `expected error at ${p}`);
  }
});
