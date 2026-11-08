// End-to-end API test: real HTTP server + mock organisers' API (retries, error group,
// control group switch), evaluation, appeal flow with roles, checklist change + re-evaluation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../../server/app.js';
import { MINI, tmpCfg } from '../helpers.js';

let app;
let base;
let upstream;
let tmp;
const upstreamLog = [];

function controlPayload() {
  const p = JSON.parse(readFileSync(MINI, 'utf8'));
  p.data.dataset_group_id = 'CONTROL';
  p.data.records = p.data.records.slice(0, 2).map((r) => ({ ...r, conversation_id: `c-${r.conversation_id}` }));
  p.data.total_records = 2;
  return p;
}

before(async () => {
  let failedOnce = false;
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const group = u.searchParams.get('group_id');
    upstreamLog.push({ group, sig: u.searchParams.get('sig') });
    if (group === 'TEST' && !failedOnce) {
      failedOnce = true;
      res.writeHead(503);
      res.end('busy');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (group === 'BAD') res.end(JSON.stringify({ error: 'Unknown group_id', isSuccess: false, data: null }));
    else if (group === 'CONTROL') res.end(JSON.stringify(controlPayload()));
    else res.end(readFileSync(MINI));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  tmp = tmpCfg({ DATASET_API_URL: `http://127.0.0.1:${upstream.address().port}/trigger?api-version=1&sig=TOPSECRET`, DATASET_GROUP_ID: 'TEST', DATASET_RETRIES: '2' });
  app = createApp(tmp.cfg);
  await app.init();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.close();
  upstream.close();
  tmp.cleanup();
});

const call = async (method, path, body, role = 'specialist') => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-cqa-role': role, 'x-cqa-user': encodeURIComponent('Тест') },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
};

test('static UI is served with security headers; path traversal is blocked', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Freedom CQA/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await call('GET', '/shared/scoring-engine.js')).status, 200);
  assert.equal((await call('GET', '/%2e%2e/server/config.js')).status, 404);
});

test('dataset API: GET by group_id with retry after a transient 503; signed URL never returned', async () => {
  const r = await call('POST', '/api/datasets/fetch', { group_id: 'TEST', activate: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.result.record_count, 5);
  assert.deepEqual(upstreamLog.slice(0, 2).map((x) => x.group), ['TEST', 'TEST']);
  assert.ok(!r.text.includes('TOPSECRET'));
  const sys = await call('GET', '/api/system');
  assert.ok(!sys.text.includes('TOPSECRET'));
  assert.match(sys.json.dataset.api_url_display, /параметры скрыты/);
});

test('dataset API errors and corrupted uploads are reported, existing data untouched', async () => {
  const bad = await call('POST', '/api/datasets/fetch', { group_id: 'BAD' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Unknown group_id/);
  const broken = await call('POST', '/api/datasets/import', { group_id: 'X', content: '{"isSuccess": true, "data": {"records": [' });
  assert.equal(broken.status, 400);
  assert.match(broken.json.error, /Некорректный JSON/);
  const empty = await call('POST', '/api/datasets/import', { group_id: 'X', content: '' });
  assert.equal(empty.status, 400);
  const list = await call('GET', '/api/conversations');
  assert.equal(list.json.total, 5);
});

test('conversation list filters; card has no audio URL; evaluation via API', async () => {
  assert.equal((await call('GET', '/api/conversations?language=KZ')).json.total, 1);
  assert.equal((await call('GET', '/api/conversations?channel=call')).json.total, 1);
  const card = await call('GET', `/api/conversations/${encodeURIComponent('TEST:t-call-001')}`);
  assert.equal(card.status, 200);
  assert.ok(!card.text.includes('SECRET_SIGNATURE'));
  assert.equal(card.json.audio.available, true);
  const ev = await call('POST', `/api/conversations/${encodeURIComponent('TEST:t-ru-001')}/evaluate`, { engine: 'rules' });
  assert.equal(ev.status, 201);
  assert.equal(ev.json.evaluation.score_final.total, 100);
  assert.equal(ev.json.evaluation.checklist_version, 1);
});

test('batch evaluation job, appeal with roles, reviewer decision recalculates the total', async () => {
  const job = await call('POST', '/api/evaluations/batch', { scope: 'unevaluated', engine: 'rules' });
  assert.equal(job.status, 202);
  let j;
  for (let i = 0; i < 50; i += 1) {
    j = (await call('GET', `/api/jobs/${job.json.id}`)).json;
    if (j.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(j.status, 'done');
  assert.equal(j.done, 4);
  const uid = encodeURIComponent('TEST:t-ru-002');
  const card = (await call('GET', `/api/conversations/${uid}`)).json;
  const before = card.evaluation.score_final.total;
  const ap = await call('POST', '/api/appeals', { evaluation_id: card.evaluation.id, criterion_id: 'empathy', comment: 'Оператор был вежлив' });
  assert.equal(ap.status, 201);
  assert.equal(ap.json.status, 'new');
  const denied = await call('POST', `/api/appeals/${ap.json.id}/decide`, { decision: 'change', answer: 'yes', reason: 'x' }, 'specialist');
  assert.equal(denied.status, 403);
  const ok = await call('POST', `/api/appeals/${ap.json.id}/decide`, { decision: 'change', status: 'scored', answer: 'yes', reason: 'Вежливо' }, 'reviewer');
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'changed');
  const after = (await call('GET', `/api/conversations/${uid}`)).json;
  assert.notEqual(after.evaluation.score_final.total, before);
  assert.equal(after.evaluation.score_original.total, before);
  assert.equal(after.row.status, 'needs_review');
  const detail = await call('GET', `/api/appeals/${ap.json.id}`);
  assert.ok(detail.json.fragment.length > 0, 'reviewer sees the dialog fragment');
});

test('checklist edit through the API → new active version → outdated dialogs re-evaluated with it', async () => {
  const active = (await call('GET', '/api/checklists/active')).json;
  const def = structuredClone(active.checklist);
  def.criteria.find((c) => c.id === 'closing').weight = 25;
  const created = await call('POST', '/api/checklists', { checklist: def, change_note: 'Вес завершения 25', activate: true, parent_version: active.version });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.version, 2);
  const invalid = await call('POST', '/api/checklists', { checklist: { criteria: [{ id: 'x' }] } });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.json.details.errors.length > 0);
  const job = await call('POST', '/api/evaluations/batch', { scope: 'outdated', engine: 'rules' });
  assert.equal(job.json.total, 5);
  for (let i = 0; i < 50; i += 1) {
    if ((await call('GET', `/api/jobs/${job.json.id}`)).json.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const card = (await call('GET', `/api/conversations/${encodeURIComponent('TEST:t-ru-002')}`)).json;
  assert.equal(card.evaluation.checklist_version, 2);
  // v1 evaluation (with the reviewer override applied in place) + v2 re-evaluation
  assert.equal(card.evaluations.length, 2);
  // the reviewer's decision on an unchanged criterion is carried into the new evaluation
  assert.equal(card.evaluation.overrides.empathy.answer, 'yes');
  assert.deepEqual(card.evaluation.carried_overrides, ['empathy']);
  const cmp = await call('GET', `/api/evaluations/${card.evaluations[1].id}/compare/${card.evaluations[0].id}`);
  assert.ok(cmp.json.checklist_changed);
  const diff = await call('GET', '/api/checklists/diff?from=1&to=2');
  assert.equal(diff.json.changed[0].id, 'closing');
});

test('control set: switch group_id, load new dialogs, evaluate them with the current checklist', async () => {
  const r = await call('POST', '/api/datasets/fetch', { group_id: 'CONTROL', activate: true });
  assert.equal(r.status, 200);
  const list = await call('GET', '/api/conversations');
  assert.equal(list.json.group, 'CONTROL');
  assert.equal(list.json.total, 2);
  const job = await call('POST', '/api/evaluations/batch', { scope: 'unevaluated', engine: 'rules' });
  assert.equal(job.json.total, 2);
  for (let i = 0; i < 50; i += 1) {
    if ((await call('GET', `/api/jobs/${job.json.id}`)).json.status !== 'running') break;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  const card = (await call('GET', `/api/conversations/${encodeURIComponent('CONTROL:c-t-ru-001')}`)).json;
  assert.equal(card.evaluation.checklist_version, 2);
  const back = await call('POST', '/api/datasets/active', { group_id: 'TEST' });
  assert.equal(back.json.active_group, 'TEST');
});

test('analytics and cost estimate are computed from data', async () => {
  const a = (await call('GET', '/api/analytics/summary?group=TEST')).json;
  assert.equal(a.totals.conversations, 5);
  assert.equal(a.totals.evaluated, 5);
  assert.ok(a.criteria.length >= 8);
  assert.ok(a.findings.some((f) => f.name.includes('обход')));
  const est = (await call('GET', '/api/estimate?group=TEST')).json;
  assert.equal(est.conversations, 5);
  assert.ok(est.total_usd > 0 && est.per_evaluation_usd > 0);
});

test('control task: replace a criterion → new version → new dialogs; without AI the new criterion is NOT scored', async () => {
  const active = (await call('GET', '/api/checklists/active')).json;
  const def = structuredClone(active.checklist);
  const i = def.criteria.findIndex((c) => c.id === 'empathy');
  def.criteria[i] = { ...def.criteria[i], id: 'service_rating', name: 'Предложение оценить обслуживание', description: 'Да — оператор предложил клиенту оценить качество обслуживания.', detector: null };
  def.official = false;
  const v = await call('POST', '/api/checklists', { checklist: def, change_note: 'Контроль: замена критерия 05', activate: true, parent_version: active.version }, 'reviewer');
  assert.equal(v.status, 201, v.text);
  assert.equal((await call('POST', '/api/datasets/fetch', { group_id: 'CONTROL', activate: true })).status, 200);
  const job = await call('POST', '/api/evaluations/batch', { scope: 'outdated', engine: 'auto' });
  for (let k = 0; k < 50; k += 1) { if ((await call('GET', `/api/jobs/${job.json.id}`)).json.status !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  const card = (await call('GET', `/api/conversations/${encodeURIComponent('CONTROL:c-t-ru-001')}`)).json;
  assert.equal(card.evaluation.checklist_version, v.json.version);
  assert.equal(card.evaluation.engine.used, 'rules');
  const r = card.evaluation.results.find((x) => x.criterion_id === 'service_rating');
  assert.equal(r.status, 'not_evaluated', 'no detector and no AI → no invented score');
  assert.equal(card.evaluation.score_final.complete, false, 'total is marked preliminary');
  assert.equal(card.evaluation.review.priority, 'high');
  // a deterministic phrase rule (not AI) makes it evaluable; the result says which rule produced it
  def.criteria[i].detector = { type: 'keyword_presence', params: { phrases: 'оцените\nrate our service', position: 'last' } };
  const v2 = await call('POST', '/api/checklists', { checklist: def, change_note: 'Правило фраз для нового критерия', activate: true, parent_version: v.json.version }, 'reviewer');
  const job2 = await call('POST', '/api/evaluations/batch', { scope: 'outdated', engine: 'auto' });
  for (let k = 0; k < 50; k += 1) { if ((await call('GET', `/api/jobs/${job2.json.id}`)).json.status !== 'running') break; await new Promise((r2) => setTimeout(r2, 50)); }
  const card2 = (await call('GET', `/api/conversations/${encodeURIComponent('CONTROL:c-t-ru-001')}`)).json;
  assert.equal(card2.evaluation.checklist_version, v2.json.version);
  const r2 = card2.evaluation.results.find((x) => x.criterion_id === 'service_rating');
  assert.equal(r2.status, 'scored');
  assert.equal(r2.engine, 'rules');
  assert.equal(r2.detector, 'keyword_presence');
  assert.equal(card.evaluations.length >= 1, true);
  await call('POST', '/api/datasets/active', { group_id: 'TEST' });
});
