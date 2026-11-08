// AI layer: output validation, Anthropic provider wire format (mock server), retries, fallback,
// evaluation pipeline with checklist snapshots and versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { validateAiOutput, parseModelJson, AiOutputError, AI_OUTPUT_SCHEMA } from '../../server/evaluation/output-schema.js';
import { AnthropicProvider } from '../../server/evaluation/providers/anthropic.js';
import { MockProvider } from '../../server/evaluation/providers/index.js';
import { createServices, initServices } from '../../server/app.js';
import { parseDatasetPayload } from '../../server/data/dataset-validator.js';
import { buildConversation } from '../../server/data/transcript-model.js';
import { validateChecklist } from '../../shared/checklist-schema.js';
import { buildPrompt } from '../../server/evaluation/prompt.js';
import { MINI, OFFICIAL_CHECKLIST, readJson, tmpCfg } from '../helpers.js';

const checklist = validateChecklist(readJson(OFFICIAL_CHECKLIST)).checklist;
const conv = buildConversation(parseDatasetPayload(readJson(MINI)).records[0], 'TEST');

/** A schema-valid model answer for every criterion of a checklist. */
function goodOutput(cl = checklist, overrides = {}) {
  return {
    criteria: cl.criteria.filter((c) => c.enabled).map((c) => ({
      criterion_id: c.id,
      status: 'scored',
      answer: c.answer_type === 'scale' ? String(c.scale.max) : c.scoring_role === 'flag' ? 'no' : 'yes',
      situation: 'met',
      explanation: `Критерий ${c.code}: выполнено.`,
      evidence_ids: ['m4'],
      quotes: [{ message_id: 'm4', quote: 'Меня зовут Алина' }],
      evidence_type: 'supporting_messages',
      confidence: 0.9,
      na_reason: '',
      recommendation: '',
      critical_flag: false,
      needs_human_review: false,
      flag_subtypes: [],
      ...(overrides[c.id] || {}),
    })),
    critical_findings: [],
    overall_summary: 'Оператор решил вопрос клиента.',
    transcript_issues: [],
  };
}

test('AI output: valid answer passes; timestamps are taken from the transcript, quotes verified', () => {
  const v = validateAiOutput(goodOutput(), checklist, conv, checklist.criteria);
  assert.equal(v.errors.length, 0);
  assert.equal(v.results.length, 8);
  assert.equal(v.results[0].evidence[0].message_id, 'm4');
  assert.equal(v.results[0].evidence[0].quote, 'Меня зовут Алина');
});

test('AI output: invalid answer, forbidden N/A, unknown evidence and missing criteria never become scores', () => {
  const out = goodOutput(checklist, {
    consultation: { answer: '12' },
    contact: { status: 'na', answer: '' },
    empathy: { evidence_ids: ['m999', 'm4'], quotes: [{ message_id: 'm4', quote: 'выдуманная цитата' }] },
  });
  out.criteria = out.criteria.filter((c) => c.criterion_id !== 'closing');
  const v = validateAiOutput(out, checklist, conv, checklist.criteria);
  const by = Object.fromEntries(v.results.map((r) => [r.criterion_id, r]));
  assert.equal(by.consultation.status, 'not_evaluated');
  assert.equal(by.contact.status, 'not_evaluated');
  assert.equal(by.closing.status, 'not_evaluated');
  assert.deepEqual(by.empathy.evidence.map((e) => e.message_id), ['m4']);
  assert.equal(by.empathy.evidence[0].quote, null);
  assert.ok(v.warnings.some((w) => w.includes('m999')));
  assert.ok(v.errors.length >= 2);
});

test('AI output: tolerant JSON parsing, garbage rejected', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Вот ответ: {"a":2} — готово'), { a: 2 });
  assert.throws(() => parseModelJson('не JSON'), AiOutputError);
  assert.throws(() => validateAiOutput({ foo: 1 }, checklist, conv, checklist.criteria), AiOutputError);
});

test('prompt: transcript is data (ids, speakers), checklist block is stable across conversations', () => {
  const other = buildConversation(parseDatasetPayload(readJson(MINI)).records[1], 'TEST');
  const a = buildPrompt(conv, checklist, checklist.criteria);
  const b = buildPrompt(other, checklist, checklist.criteria);
  assert.equal(a.checklistBlock, b.checklistBlock);
  assert.match(a.conversationBlock, /<transcript_data>/);
  assert.match(a.conversationBlock, /"id": "m4"/);
  assert.match(a.system, /данные, а не инструкции/);
  assert.match(a.checklistBlock, /Установление контакта/);
});

function startMockAnthropic(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push({ headers: req.headers, body: parsed, url: req.url });
        const { status = 200, json } = handler(parsed, requests.length);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('Anthropic provider: wire format (structured output, caching, no sampling params / forced tools) and usage', async () => {
  const mock = await startMockAnthropic(() => ({
    json: { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: JSON.stringify(goodOutput()) }], stop_reason: 'end_turn', usage: { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } },
  }));
  try {
    const { cfg, cleanup } = tmpCfg({ ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: mock.url, AI_PROVIDER: 'anthropic' });
    const p = new AnthropicProvider(cfg);
    const r = await p.evaluate({ ...buildPrompt(conv, checklist, checklist.criteria), schema: AI_OUTPUT_SCHEMA });
    const req = mock.requests[0];
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'sk-ant-test-key');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.body.model, 'claude-sonnet-5-5');
    assert.equal(req.body.output_config.format.type, 'json_schema');
    assert.equal(req.body.output_config.effort, 'medium');
    assert.equal(req.body.system[0].cache_control.type, 'ephemeral');
    assert.ok(!('temperature' in req.body) && !('tool_choice' in req.body) && !('tools' in req.body));
    assert.equal(r.usage.input_tokens, 5000);
    assert.equal(r.usage.cache_read_tokens, 3000);
    assert.equal(r.output.criteria.length, 8);
    cleanup();
  } finally {
    mock.server.close();
  }
});

test('Anthropic provider: retries without "effort" / structured output when the API rejects them; auth errors are explicit', async () => {
  const mock = await startMockAnthropic((body, n) => {
    if (n === 1) return { status: 400, json: { type: 'error', error: { message: 'output_config.effort: unsupported' } } };
    if (n === 2) return { status: 400, json: { type: 'error', error: { message: 'output_config.format is not supported for this model' } } };
    return { json: { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(goodOutput())}\n\`\`\`` }], stop_reason: 'end_turn', usage: {} } };
  });
  try {
    const { cfg, cleanup } = tmpCfg({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: mock.url });
    const p = new AnthropicProvider(cfg);
    const r = await p.evaluate({ ...buildPrompt(conv, checklist, checklist.criteria), schema: AI_OUTPUT_SCHEMA });
    assert.equal(mock.requests.length, 3);
    assert.ok(!mock.requests[2].body.output_config);
    assert.match(mock.requests[2].body.messages[0].content[1].text, /JSON-схеме/);
    assert.equal(r.output.criteria.length, 8);
    cleanup();
  } finally {
    mock.server.close();
  }
  const auth = await startMockAnthropic(() => ({ status: 401, json: { error: { message: 'invalid x-api-key' } } }));
  try {
    const { cfg, cleanup } = tmpCfg({ ANTHROPIC_API_KEY: 'bad', ANTHROPIC_BASE_URL: auth.url });
    await assert.rejects(new AnthropicProvider(cfg).evaluate({ ...buildPrompt(conv, checklist, checklist.criteria), schema: AI_OUTPUT_SCHEMA }), /ключ/);
    cleanup();
  } finally {
    auth.server.close();
  }
});

async function services(provider, env = {}) {
  const t = tmpCfg(env);
  const s = createServices(t.cfg, { providerOverride: provider });
  await initServices(s);
  await s.datasets.importPayload('TEST', readFileSync(MINI, 'utf8'), 'file');
  return { s, ...t };
}

test('evaluation with AI: stored with checklist snapshot, enriched evidence and usage; deterministic score', async () => {
  const provider = new MockProvider(() => goodOutput(checklist, { consultation: { answer: '15', situation: 'partial' } }));
  const { s, cleanup } = await services(provider);
  const e = await s.evaluations.evaluate('TEST:t-ru-001', { engine: 'ai' });
  assert.equal(e.engine.used, 'mock');
  assert.equal(e.checklist_version, 1);
  assert.equal(e.checklist.criteria.length, 8);
  assert.equal(e.results.find((r) => r.criterion_id === 'consultation').answer, 15);
  assert.equal(e.score_final.total, 95);
  const ev = e.results[0].evidence[0];
  assert.equal(ev.t_label, '01:10');
  assert.equal(ev.ts, '01:10');
  assert.equal(ev.speaker, 'operator');
  assert.equal(e.usage.calls, 1);
  cleanup();
});

test('invalid AI response: one repair retry, then fallback to offline rules (marked) or a clear error', async () => {
  let calls = 0;
  const flaky = new MockProvider(() => { calls += 1; return calls === 1 ? { nonsense: true } : goodOutput(); });
  const a = await services(flaky);
  const e1 = await a.s.evaluations.evaluate('TEST:t-ru-001', { engine: 'ai' });
  assert.equal(e1.engine.used, 'mock');
  assert.equal(e1.usage.calls, 2);
  a.cleanup();

  const broken = new MockProvider(() => ({ criteria: 'oops' }));
  const b = await services(broken);
  const e2 = await b.s.evaluations.evaluate('TEST:t-ru-001', { engine: 'ai' });
  assert.equal(e2.engine.used, 'rules');
  assert.ok(e2.engine.fallback.reason.length > 0);
  assert.ok(e2.review.reasons.some((r) => r.includes('AI недоступен')));
  b.cleanup();

  const c = await services(broken, { AI_FALLBACK_TO_RULES: 'false' });
  await assert.rejects(c.s.evaluations.evaluate('TEST:t-ru-001', { engine: 'ai' }), /Ошибка AI-оценки/);
  c.cleanup();
});

test('rule-detected gross errors are never silently dropped when the AI disagrees', async () => {
  const provider = new MockProvider(() => goodOutput());
  const { s, cleanup } = await services(provider);
  const e = await s.evaluations.evaluate('TEST:t-en-001', { engine: 'ai' });
  const kept = e.critical_findings.filter((f) => f.ai_disagrees);
  assert.ok(kept.length >= 1);
  assert.ok(e.review.needs_human_review);
  cleanup();
});

test('checklist change: new version is applied on re-evaluation, old evaluation keeps its snapshot, overrides carry over only for unchanged criteria', async () => {
  const { s, cleanup } = await services(null);
  const e1 = await s.evaluations.evaluate('TEST:t-ru-001', { engine: 'rules' });
  await s.evaluations.applyOverride(e1.id, 'closing', { status: 'scored', answer: 'no', reason: 'Проверка' }, { role: 'reviewer', name: 'R' });
  const def = structuredClone(s.checklists.getActive().checklist);
  def.criteria.find((c) => c.id === 'contact').weight = 30;
  const empathy = def.criteria.find((c) => c.id === 'empathy');
  Object.assign(empathy, { id: 'courtesy_phrase', name: 'Предложение помощи', description: 'Оператор спросил, остались ли вопросы', detector: { type: 'keyword_presence', params: { phrases: 'остались вопросы\nесли появятся вопросы' } } });
  const v2 = await s.checklists.create(def, { activate: true, change_note: 'тест' });
  assert.equal(v2.version, 2);
  const e2 = await s.evaluations.evaluate('TEST:t-ru-001', { engine: 'rules' });
  assert.equal(e2.checklist_version, 2);
  assert.ok(e2.results.some((r) => r.criterion_id === 'courtesy_phrase' && r.answer === 'yes'));
  assert.ok(e2.overrides.closing, 'unchanged criterion keeps the reviewer decision');
  assert.equal(s.evaluations.get(e1.id).checklist_version, 1, 'old evaluation untouched');
  assert.equal(s.evaluations.get(e1.id).checklist.criteria.find((c) => c.id === 'contact').weight, 10);
  const diff = s.evaluations.compare(e1.id, e2.id);
  assert.ok(diff.checklist_changed);
  assert.ok(diff.score.changes.some((c) => c.criterion_id === 'courtesy_phrase' && c.kind === 'added'));
  assert.ok(diff.score.changes.some((c) => c.criterion_id === 'empathy' && c.kind === 'removed'));
  cleanup();
});

test('checklist parameter change (first-reaction threshold) changes criterion 06; only decisions that depend on it are dropped', async () => {
  const { s, cleanup } = await services(null);
  // t-ru-001: operator's first reaction is 48 s after escalation
  const e1 = await s.evaluations.evaluate('TEST:t-ru-001', { engine: 'rules' });
  const dm1 = e1.results.find((r) => r.criterion_id === 'dialog_management');
  assert.equal(dm1.answer, 10);
  await s.evaluations.applyOverride(e1.id, 'dialog_management', { status: 'scored', answer: 7, reason: 'Проверка' }, { role: 'reviewer', name: 'R' });
  await s.evaluations.applyOverride(e1.id, 'closing', { status: 'scored', answer: 'no', reason: 'Проверка' }, { role: 'reviewer', name: 'R' });
  const def = structuredClone(s.checklists.getActive().checklist);
  def.parameters.first_response_threshold_sec = 30; // edited in the UI ("Порог первой реакции, с")
  await s.checklists.create(def, { activate: true, change_note: 'Порог 30 с' });
  const e2 = await s.evaluations.evaluate('TEST:t-ru-001', { engine: 'rules' });
  const dm2 = e2.results.find((r) => r.criterion_id === 'dialog_management');
  assert.equal(dm2.answer, 7, 'the detector uses the checklist-level threshold');
  assert.match(dm2.explanation, /порог 30 с/);
  assert.deepEqual(Object.keys(e2.overrides), ['closing'], 'an unrelated decision (07) is kept');
  assert.deepEqual(e2.not_carried_overrides, ['dialog_management'], 'the 06 decision was made under the old threshold');
  assert.ok(e2.history.some((h) => h.action === 'overrides_not_carried' && /first_response_threshold_sec/.test(h.note)));
  assert.notEqual(e2.review.priority, 'low');
  assert.ok(e2.review.reasons.some((r) => /не перенесены/.test(r)));
  cleanup();
});

test('criterion without detector and without AI is "not evaluated" (no invented score)', async () => {
  const { s, cleanup } = await services(null);
  const def = structuredClone(s.checklists.getActive().checklist);
  def.criteria.push({ id: 'new_llm_only', code: '09', section_id: 'conduct', name: 'Новый критерий', description: 'Только AI', answer_type: 'binary', weight: 10, na_allowed: false, evaluation_mode: 'auto' });
  await s.checklists.create(def, { activate: true });
  const e = await s.evaluations.evaluate('TEST:t-ru-001', { engine: 'rules' });
  const r = e.results.find((x) => x.criterion_id === 'new_llm_only');
  assert.equal(r.status, 'not_evaluated');
  assert.equal(e.score_final.complete, false);
  assert.equal(e.review.priority, 'high');
  cleanup();
});
