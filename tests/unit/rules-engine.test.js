// Offline evaluation engine on the special scenarios of the specification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDatasetPayload } from '../../server/data/dataset-validator.js';
import { buildConversation } from '../../server/data/transcript-model.js';
import { validateChecklist } from '../../shared/checklist-schema.js';
import { evaluateWithRules } from '../../server/evaluation/rules/rules-engine.js';
import { computeScore } from '../../shared/scoring-engine.js';
import { MINI, OFFICIAL_CHECKLIST, readJson, devFile } from '../helpers.js';

const checklist = validateChecklist(readJson(OFFICIAL_CHECKLIST)).checklist;

function evalConv(conv) {
  const { results, risks } = evaluateWithRules(conv, checklist);
  const by = Object.fromEntries(results.map((r) => [r.criterion_id, r]));
  return { by, risks, results, score: computeScore(checklist, results) };
}

const mini = Object.fromEntries(parseDatasetPayload(readJson(MINI)).records.map((r) => [r.conversation_id, buildConversation(r, 'TEST')]));

test('every enabled criterion gets a result; evidence ids always point to real messages', () => {
  for (const conv of Object.values(mini)) {
    const { results } = evalConv(conv);
    assert.equal(results.length, checklist.criteria.length);
    const ids = new Set(conv.messages.map((m) => m.id));
    for (const r of results) {
      for (const e of r.evidence) assert.ok(ids.has(e.message_id), `${conv.conversation_id}/${r.criterion_id}: ${e.message_id}`);
      if (r.checked_range) assert.ok(ids.has(r.checked_range.from) && ids.has(r.checked_range.to));
      assert.ok(r.explanation.length > 10);
    }
  }
});

test('RU good chat: greeting, consultation and closing are met; no gross errors', () => {
  const { by, score } = evalConv(mini['t-ru-001']);
  assert.equal(by.contact.answer, 'yes');
  assert.equal(by.consultation.answer, 20);
  assert.equal(by.closing.answer, 'yes');
  assert.equal(by.gross_errors.answer, 'no');
  assert.equal(by.identification.status, 'na');
  assert.equal(score.total, 100);
});

test('KZ chat: greeting recognised in Kazakh', () => {
  const { by } = evalConv(mini['t-kz-001']);
  assert.equal(by.contact.answer, 'yes');
  assert.match(by.contact.explanation, /казахском/);
});

test('EN chat: insult and paid private advice → gross error with both subtypes, empathy "no"', () => {
  const { by, score } = evalConv(mini['t-en-001']);
  assert.equal(by.gross_errors.answer, 'yes');
  assert.deepEqual(by.gross_errors.flag_subtypes.map((s) => s.id).sort(), ['bypass_service', 'insult']);
  assert.equal(by.empathy.answer, 'no');
  assert.equal(by.closing.answer, 'no'); // agent closed the chat without goodbye
  assert.equal(score.gross_error, true);
});

test('disclosure before identification → identification "no" + confidential disclosure', () => {
  const { by } = evalConv(mini['t-ru-002']);
  assert.equal(by.identification.answer, 'no');
  assert.ok(by.gross_errors.flag_subtypes.some((s) => s.id === 'confidential_disclosure'));
  assert.equal(by.closing.status, 'na'); // client left the chat
});

test('call: OTP request is a risk signal for review (not a gross error); ID confirmed before disclosure; hold talk ignored', () => {
  const { by, risks } = evalConv(mini['t-call-001']);
  const otp = risks.find((r) => r.rule_id === 'otp_request');
  assert.ok(otp, 'OTP signal expected');
  assert.equal(otp.possible_legitimate_context, true);
  assert.equal(otp.severity, 'high');
  assert.equal(by.gross_errors.answer, 'no');
  assert.equal(by.identification.answer, 'yes');
  assert.ok(by.dialog_management.confidence < 0.6, 'calls are flagged with lower confidence');
});

const dev = devFile();
const devConvs = dev ? Object.fromEntries(parseDatasetPayload(readFileSync(dev, 'utf8')).records.map((r) => [r.conversation_id, buildConversation(r, 'DEV')])) : {};
const skip = dev ? false : 'DEV-набор не найден';

test('DEV p1-ru-022: personal card + profit promise → gross error (bypass) and risk signal', { skip }, () => {
  const { by, risks } = evalConv(devConvs['p1-ru-022']);
  assert.equal(by.gross_errors.answer, 'yes');
  assert.ok(by.gross_errors.flag_subtypes.some((s) => s.id === 'bypass_service'));
  assert.ok(risks.some((r) => r.rule_id === 'profit_promise'));
  const ev = by.gross_errors.evidence.map((e) => e.message_id);
  assert.ok(ev.includes('m9') && ev.includes('m11'), `evidence ${ev}`);
});

test('DEV p1-ru-023, p1-en-013, p1-kz-013: paid private consultation + personal number → bypass flagged', { skip }, () => {
  for (const id of ['p1-ru-023', 'p1-en-013', 'p1-kz-013']) {
    const { by } = evalConv(devConvs[id]);
    assert.equal(by.gross_errors.answer, 'yes', id);
    assert.ok(by.gross_errors.flag_subtypes.some((s) => s.id === 'bypass_service'), id);
    assert.ok(by.gross_errors.evidence.some((e) => e.message_id === 'm11'), id);
  }
});

test('DEV p4-ru-003, p4-ru-004: six-digit SMS code requests → risk signal for manual review', { skip }, () => {
  for (const id of ['p4-ru-003', 'p4-ru-004']) {
    const { risks, by } = evalConv(devConvs[id]);
    const otp = risks.find((r) => r.rule_id === 'otp_request');
    assert.ok(otp, id);
    assert.ok(otp.needs_human_review);
    assert.equal(by.identification.answer, 'yes', `${id}: identification itself is not a violation`);
  }
});

test('DEV p1-ru-029: rude operator → insult flagged with the exact message', { skip }, () => {
  const { by } = evalConv(devConvs['p1-ru-029']);
  assert.ok(by.gross_errors.flag_subtypes.some((s) => s.id === 'insult'));
  assert.equal(by.empathy.answer, 'no');
  assert.ok(by.empathy.evidence.some((e) => e.message_id === 'm9'));
});

test('DEV p1-ru-009 / p1-kz-015 / p1-en-014: account data disclosed without identification', { skip }, () => {
  for (const id of ['p1-ru-009', 'p1-kz-015', 'p1-en-014']) {
    const { by } = evalConv(devConvs[id]);
    assert.equal(by.identification.answer, 'no', id);
    assert.ok(by.gross_errors.flag_subtypes.some((s) => s.id === 'confidential_disclosure'), id);
  }
});

test('DEV negative controls: refusing investment advice (p4-ru-001) and asking for ID (p1-ru-002) are not violations', { skip }, () => {
  const a = evalConv(devConvs['p4-ru-001']);
  assert.equal(a.by.gross_errors.answer, 'no');
  assert.equal(a.risks.length, 0);
  // asking for an identity check is not a violation; identity was never confirmed and nothing was disclosed,
  // so per the PDF ("Да — проверка личности подтверждена…", "N/A — запрос не требовал идентификации") it is N/A
  const b = evalConv(devConvs['p1-ru-002']);
  assert.equal(b.by.identification.status, 'na');
  assert.equal(b.by.gross_errors.answer, 'no');
  const c = evalConv(devConvs['p1-ru-006']);
  assert.equal(c.by.identification.answer, 'yes');
});

test('DEV N/A cases: chat ended before a request (p1-ru-025), connection lost before closing (p1-ru-012)', { skip }, () => {
  const a = evalConv(devConvs['p1-ru-025']);
  assert.equal(a.by.consultation.status, 'na');
  assert.equal(a.by.closing.status, 'na');
  assert.ok(a.score.computable);
  const b = evalConv(devConvs['p1-ru-012']);
  assert.equal(b.by.closing.status, 'na');
});

test('DEV missed actions show the checked range or evidence (p1-ru-003 unanswered commission question)', { skip }, () => {
  const { by } = evalConv(devConvs['p1-ru-003']);
  assert.equal(by.consultation.answer, 10);
  assert.ok(by.consultation.evidence.some((e) => e.message_id === 'm13'));
});

test('DEV all 65 dialogs evaluate without errors; evidence ids valid; RU/KZ/EN covered', { skip }, () => {
  const langs = new Set();
  for (const conv of Object.values(devConvs)) {
    const { results, score } = evalConv(conv);
    langs.add(conv.language);
    const ids = new Set(conv.messages.map((m) => m.id));
    for (const r of results) for (const e of r.evidence) assert.ok(ids.has(e.message_id));
    assert.ok(score.total === null || (score.total >= 0 && score.total <= 100));
  }
  assert.deepEqual([...langs].sort(), ['EN', 'KZ', 'RU']);
});
