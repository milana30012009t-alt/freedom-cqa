import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createServices, initServices } from '../../server/app.js';
import { MINI, tmpCfg } from '../helpers.js';

const specialist = { role: 'specialist', name: 'Айгерим' };
const reviewer = { role: 'reviewer', name: 'Ербол' };

async function setup(fetchImpl) {
  const t = tmpCfg();
  const s = createServices(t.cfg, { audioFetchImpl: fetchImpl });
  await initServices(s);
  await s.datasets.importPayload('TEST', readFileSync(MINI, 'utf8'), 'file');
  return { s, ...t };
}

test('appeal lifecycle: create → take → change → close; total recalculated, original kept, history complete', async () => {
  const { s, cleanup } = await setup();
  const e = await s.evaluations.evaluate('TEST:t-ru-002', { engine: 'rules' });
  const before = e.score_final.total;
  assert.equal(e.results.find((r) => r.criterion_id === 'empathy').answer, 'no');
  const a = await s.appeals.create({ evaluation_id: e.id, criterion_id: 'empathy', comment: 'Оператор был вежлив, недовольство клиента касалось процедуры' }, specialist);
  assert.equal(a.status, 'new');
  assert.equal(a.original.total, before);
  await assert.rejects(s.appeals.create({ evaluation_id: e.id, criterion_id: 'empathy', comment: 'ещё раз' }, specialist), /уже есть открытая/);
  await assert.rejects(s.appeals.decide(a.id, { decision: 'confirm', reason: 'x' }, specialist), /только проверяющему/);
  const taken = await s.appeals.take(a.id, reviewer);
  assert.equal(taken.status, 'pending');
  const decided = await s.appeals.decide(a.id, { decision: 'change', status: 'scored', answer: 'yes', reason: 'Тон вежливый, грубости нет' }, reviewer);
  assert.equal(decided.status, 'changed');
  assert.equal(decided.decision.total_before, before);
  const ev = s.evaluations.get(e.id);
  assert.equal(ev.overrides.empathy.answer, 'yes');
  assert.equal(ev.score_original.total, before, 'original score preserved');
  assert.notEqual(ev.score_final.total, before);
  assert.equal(decided.decision.total_after, ev.score_final.total);
  assert.ok(ev.history.some((h) => h.action === 'override' && h.appeal_id === a.id));
  const closed = await s.appeals.close(a.id, 'ok', specialist);
  assert.equal(closed.status, 'closed');
  assert.deepEqual(closed.history.map((h) => h.action), ['created', 'taken', 'changed', 'closed']);
  assert.equal(typeof s.appeals.delete, 'undefined', 'no delete operation exists');
  cleanup();
});

test('appeal confirm keeps the score; invalid change values are rejected', async () => {
  const { s, cleanup } = await setup();
  const e = await s.evaluations.evaluate('TEST:t-ru-001', { engine: 'rules' });
  const a = await s.appeals.create({ evaluation_id: e.id, criterion_id: 'contact', comment: 'Проверьте приветствие, пожалуйста' }, specialist);
  await assert.rejects(s.appeals.decide(a.id, { decision: 'change', status: 'na', reason: 'x' }, reviewer), /N\/A не допускается/);
  await assert.rejects(s.appeals.decide(a.id, { decision: 'change', status: 'scored', answer: 'maybe', reason: 'x' }, reviewer), /Недопустимое значение/);
  const d = await s.appeals.decide(a.id, { decision: 'confirm', reason: 'Приветствие и имя есть' }, reviewer);
  assert.equal(d.status, 'confirmed');
  assert.equal(d.decision.total_after, d.decision.total_before);
  cleanup();
});

test('critical finding review and evaluation verification are recorded', async () => {
  const { s, cleanup } = await setup();
  const e = await s.evaluations.evaluate('TEST:t-en-001', { engine: 'rules' });
  const f = e.critical_findings[0];
  const r1 = await s.evaluations.reviewFinding(e.id, f.id, 'confirmed', 'Подтверждаю', reviewer);
  assert.equal(r1.critical_reviews[f.id].decision, 'confirmed');
  const r2 = await s.evaluations.verify(e.id, 'Проверено', reviewer);
  assert.ok(r2.review.verified);
  assert.equal(r2.review.needs_human_review, false);
  cleanup();
});

test('checklist versions: official seed v1, new version immutable snapshot, activation, diff, validation errors', async () => {
  const { s, cleanup } = await setup();
  const v1 = s.checklists.getActive();
  assert.equal(v1.version, 1);
  assert.equal(v1.checklist.official, true);
  const def = structuredClone(v1.checklist);
  def.criteria[0].name = 'Приветствие (изменено)';
  def.criteria[0].weight = 12;
  const v2 = await s.checklists.create(def, { activate: false, change_note: 'тест' });
  assert.equal(s.checklists.getActive().version, 1);
  await s.checklists.activate(v2.version);
  assert.equal(s.checklists.getActive().version, 2);
  assert.equal(s.checklists.get(1).checklist.criteria[0].weight, 10);
  const d = s.checklists.diff(1, 2);
  assert.deepEqual(d.changed[0].fields.map((f) => f.field).sort(), ['name', 'weight']);
  await assert.rejects(s.checklists.create({ criteria: [] }, {}), /не прошёл проверку/);
  cleanup();
});

function startUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function wav(bytes = 2000) {
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVE', 8, 'latin1');
  return b;
}

function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, enc, cb) { chunks.push(c); cb(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  const done = new Promise((r) => res.on('finish', () => r(Buffer.concat(chunks))));
  return { res, done };
}

test('audio proxy: downloads once, serves with Range; signed URL never exposed; JSON $content envelope supported', async () => {
  let hits = 0;
  const up = await startUpstream((req, res) => {
    hits += 1;
    if (req.url.startsWith('/json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ '$content-type': 'audio/wav', $content: wav(500).toString('base64') }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(wav(2000));
  });
  try {
    const { s, cleanup } = await setup();
    const rec = s.datasets.groups.get('TEST').records.find((r) => r.conversation_id === 't-call-001');
    rec.audio_url = `${up.url}/rec?sig=SECRET`;
    const entry = await s.audio.ensure('TEST:t-call-001');
    assert.equal(entry.content_type, 'audio/wav');
    await s.audio.ensure('TEST:t-call-001');
    assert.equal(hits, 1, 'cached after the first download');
    const { res, done } = fakeRes();
    await s.audio.serve({ headers: { range: 'bytes=0-99' } }, res, 'TEST:t-call-001');
    const body = await done;
    assert.equal(res.status, 206);
    assert.equal(body.length, 100);
    assert.match(res.headers['Content-Range'], /^bytes 0-99\/2044$/);
    const status = s.audio.status('TEST:t-call-001');
    assert.ok(!JSON.stringify(status).includes('SECRET'));
    const conv = s.datasets.get('TEST:t-call-001');
    assert.ok(!JSON.stringify(conv).includes('SECRET'), 'conversation sent to the browser has no signed URL');
    rec.audio_url = `${up.url}/json?sig=X`;
    s.audio.index = {};
    const e2 = await s.audio.ensure('TEST:t-call-001');
    assert.equal(e2.size, 544);
    cleanup();
  } finally {
    up.server.close();
  }
});

test('audio proxy: unavailable link (403) and missing audio produce clear errors; transcript stays usable', async () => {
  const up = await startUpstream((req, res) => { res.writeHead(403); res.end('AuthorizationFailed'); });
  try {
    const { s, cleanup } = await setup();
    s.datasets.groups.get('TEST').records.find((r) => r.conversation_id === 't-call-001').audio_url = `${up.url}/rec?sig=expired`;
    await assert.rejects(s.audio.ensure('TEST:t-call-001'), (e) => e.status === 502 && /403/.test(e.message));
    assert.match(s.audio.status('TEST:t-call-001').last_error.message, /истечь/);
    await assert.rejects(s.audio.ensure('TEST:t-ru-001'), (e) => e.status === 404);
    const ev = await s.evaluations.evaluate('TEST:t-call-001', { engine: 'rules' });
    assert.ok(Number.isFinite(ev.score_final.total));
    cleanup();
  } finally {
    up.server.close();
  }
});
