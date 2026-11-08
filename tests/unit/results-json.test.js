// Results JSON 1.0: export pipeline (with a scripted model, never a real one), strict validator on
// deliberately broken files, independent score recomputation, evidence_turns mapping, JSON Schema consistency.
// Every test writes only to temporary directories — never to results/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MockProvider } from '../../server/evaluation/providers/index.js';
import { exportResults, ExportError, readSourceRecords, resultsPath } from '../../server/results/exporter.js';
import { validateResults, exactFinalScore } from '../../server/results/validator.js';
import { OFFICIAL_CRITERIA, endpointMode, turnOf, toOfficialCriterion } from '../../server/results/official-format.js';
import { checkExplanationQuotes } from '../../server/evaluation/output-schema.js';
import { extractQuotes, quotesToCheck } from '../../shared/quotes.js';
import { computeScore } from '../../shared/scoring-engine.js';
import { validateChecklist } from '../../shared/checklist-schema.js';
import { parseDatasetPayload } from '../../server/data/dataset-validator.js';
import { buildConversation } from '../../server/data/transcript-model.js';
import { MINI, OFFICIAL_CHECKLIST, ROOT, devFile, readJson, tmpCfg } from '../helpers.js';

const SERVED = 'qwen2.5:7b-instruct-q4_K_M';
const ENDPOINT = 'http://127.0.0.1:11434/v1';

/** Provider stand-in that reports the model id like a real OpenAI-compatible server does. */
class ServedMock extends MockProvider {
  async evaluate(prompt) {
    return { ...(await super.evaluate(prompt)), model: SERVED };
  }
}

/**
 * Scripted model that reads the prompt (checklist block + <transcript_data>) and answers every criterion with
 * real message ids and verbatim quotes — the shape a real model must return. Not a stand-in for model quality.
 */
function scriptedModel({ failIds = [], naDiscoveryIds = [], inventIds = [] } = {}) {
  return (prompt) => {
    const cl = JSON.parse(prompt.checklistBlock.slice(prompt.checklistBlock.indexOf('{')));
    const block = prompt.conversationBlock;
    const data = JSON.parse(block.slice(block.indexOf('<transcript_data>') + '<transcript_data>'.length, block.indexOf('</transcript_data>')));
    const id = data.conversation.conversation_id;
    if (failIds.includes(id)) return new Error('ECONNRESET: соединение с моделью разорвано (тест)');
    const op = data.transcript.find((m) => m.speaker === 'operator');
    const client = data.transcript.find((m) => m.speaker === 'client');
    const quote = op.text.split(/[.!?]/)[0].trim();
    return {
      criteria: cl.checklist.criteria.map((c) => {
        const base = {
          criterion_id: c.criterion_id, status: 'scored', situation: 'met',
          explanation: `Проверена реплика оператора «${quote}» (${op.time}).`,
          evidence_ids: [op.id], quotes: [{ message_id: op.id, quote }], evidence_type: 'supporting_messages',
          confidence: 0.8, na_reason: '', recommendation: '', critical_flag: false, needs_human_review: false, flag_subtypes: [],
        };
        if (c.code === '02' && naDiscoveryIds.includes(id)) return { ...base, status: 'na', answer: '', situation: 'na', na_reason: 'Клиент сразу полностью изложил вопрос' };
        if (c.code === '04') return { ...base, answer: '15', situation: 'partial' };
        if (c.code === '06') return { ...base, answer: '7', situation: 'partial' };
        // evidence names only the client's message, the explanation quotes the operator → evidence must follow the quote
        if (c.code === '05') return { ...base, answer: 'yes', evidence_ids: [client.id], quotes: [] };
        if (c.code === '07' && inventIds.includes(id)) return { ...base, answer: 'yes', explanation: `${base.explanation} Оператор сказал «мы обязательно вернём вам деньги завтра».` };
        return { ...base, answer: c.scoring_role === 'flag' ? 'no' : 'yes' };
      }),
      critical_findings: [],
      overall_summary: 'Тестовый ответ.',
      transcript_issues: [],
    };
  };
}

const served = (opts) => new ServedMock(scriptedModel(opts), { id: 'openai', model: SERVED, label: `Локальная модель · ${SERVED}`, endpoint: ENDPOINT });

function sandbox(extraEnv) {
  const t = tmpCfg(extraEnv);
  const outDir = mkdtempSync(join(tmpdir(), 'cqa-results-'));
  return { ...t, outDir, done: () => { t.cleanup(); rmSync(outDir, { recursive: true, force: true }); } };
}

/** 10 control-like records cloned from the mini fixture under new ids (test data only, written to a temp dir). */
function controlPayload(n = 10, group = 'CTRL-TEST') {
  const mini = readJson(MINI).data.records;
  const records = Array.from({ length: n }, (_, i) => ({ ...structuredClone(mini[i % mini.length]), conversation_id: `ctl-${String(i + 1).padStart(2, '0')}` }));
  return { error: '', isSuccess: true, data: { dataset_group_id: group, total_records: n, records } };
}

function apiFetch(payload, seen) {
  return async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
}

let miniCache = null;
/** A valid submission-mode file for the 5 mini dialogs (exported once, reused read-only). */
async function miniExport() {
  if (miniCache) return miniCache;
  const sb = sandbox();
  const r = await exportResults({
    cfg: sb.cfg, set: 'dev', group: 'TEST', file: MINI, teamName: 'Тестовая команда', allowCount: true,
    out: join(sb.outDir, 'results.json'), providerOverride: served({ naDiscoveryIds: ['t-ru-002'], inventIds: ['t-en-001'] }),
  });
  const bytes = readFileSync(r.path);
  const source = readSourceRecords(sb.cfg, 'TEST');
  miniCache = { r, bytes, doc: JSON.parse(bytes.toString('utf8')), source };
  sb.done();
  return miniCache;
}

// ------------------------------------------------------------------------------------------- export

test('export: scripted local model → valid file, exact top-level shape, model taken from the served id', async () => {
  const { r, doc } = await miniExport();
  assert.equal(r.report.ok, true, r.report.errors.join('\n'));
  assert.deepEqual(Object.keys(doc), ['schema_version', 'team_name', 'model', 'results']);
  assert.equal(doc.schema_version, '1.0');
  assert.deepEqual(doc.model, { mode: 'local', name: SERVED });
  assert.equal(doc.results.length, 5);
  for (const rec of doc.results) {
    assert.deepEqual(Object.keys(rec), ['conversation_id', 'status', 'criteria', 'score', 'error']);
    assert.equal(rec.status, 'ok');
    assert.equal(rec.error, null);
    assert.deepEqual(rec.criteria.map((c) => c.criterion_id), OFFICIAL_CRITERIA.map((c) => c.id));
    for (const c of rec.criteria) assert.deepEqual(Object.keys(c), ['criterion_id', 'value', 'rationale', 'evidence_turns']);
    assert.deepEqual(Object.keys(rec.score), ['final_score', 'critical_flag']);
    assert.equal(rec.score.critical_flag, rec.criteria.find((c) => c.criterion_id === 'critical').value);
  }
  // 15/20 and 7/10: (10+15+20+15+15+10.5+5)/100 → 90.5; discovery N/A → weight redistributed: 75.5/85 → 88.82
  const by = Object.fromEntries(doc.results.map((x) => [x.conversation_id, x]));
  assert.equal(by['t-ru-001'].score.final_score, 90.5);
  assert.equal(by['t-ru-002'].criteria.find((c) => c.criterion_id === 'discovery').value, null);
  assert.equal(by['t-ru-002'].score.final_score, 88.82);
  assert.match(by['t-ru-002'].criteria.find((c) => c.criterion_id === 'discovery').rationale, /^N\/A: Клиент сразу/);
});

test('export: evidence_turns are 1-based over ALL messages (client, bot, system, operator) and match the quote', async () => {
  const { doc, source } = await miniExport();
  const src = Object.fromEntries(source.records.map((x) => [x.conversation_id, x.transcript]));
  // t-ru-001: client, bot, client, system, then the first operator message → turn 5, not "operator message 1"
  const contact = doc.results.find((x) => x.conversation_id === 't-ru-001').criteria.find((c) => c.criterion_id === 'contact');
  assert.deepEqual(contact.evidence_turns, [5]);
  assert.equal(src['t-ru-001'][4].speaker, 'operator');
  assert.ok(src['t-ru-001'][4].text.startsWith('Здравствуйте! Меня зовут Алина'));
  for (const rec of doc.results) {
    const tr = src[rec.conversation_id];
    for (const c of rec.criteria) {
      for (const t of c.evidence_turns) assert.ok(t >= 1 && t <= tr.length, `${rec.conversation_id}/${c.criterion_id}: ${t}`);
      // empathy: the model cited only the client's message but quoted the operator → operator turn added
      if (c.criterion_id === 'empathy') {
        const opTurn = tr.findIndex((m) => m.speaker === 'operator') + 1;
        assert.ok(c.evidence_turns.includes(opTurn), `${rec.conversation_id}: turn ${opTurn} of the quoted operator message`);
      }
    }
  }
  assert.equal(turnOf('m0'), 1);
  assert.equal(turnOf('m19'), 20);
});

test('export: a quote the model invented is never written as a quote (marked as paraphrase, file stays valid)', async () => {
  const { doc } = await miniExport();
  const closure = doc.results.find((x) => x.conversation_id === 't-en-001').criteria.find((c) => c.criterion_id === 'closure');
  assert.doesNotMatch(closure.rationale, /«мы обязательно вернём/);
  assert.match(closure.rationale, /\[пересказ модели, дословно в транскрипте нет: мы обязательно вернём вам деньги завтра\]/);
});

test('export: no model connected → refused with code 2, no results file written', async () => {
  const sb = sandbox();
  try {
    const out = join(sb.outDir, 'results.json');
    await assert.rejects(
      exportResults({ cfg: sb.cfg, set: 'dev', group: 'TEST', file: MINI, teamName: 'Команда', allowCount: true, out }),
      (e) => e instanceof ExportError && e.code === 2 && /Модель не подключена/.test(e.message),
    );
    assert.equal(existsSync(out), false);
    await assert.rejects(exportResults({ cfg: sb.cfg, set: 'dev', group: 'TEST', file: MINI, teamName: '', allowCount: true, out, providerOverride: served() }), /название команды/i);
  } finally { sb.done(); }
});

test('export: the model answered no dialog (e.g. wrong key) → code 5, the previous file is left untouched', async () => {
  const sb = sandbox();
  try {
    const out = join(sb.outDir, 'results.json');
    writeFileSync(out, 'ПРЕЖНИЙ ФАЙЛ');
    const ids = readJson(MINI).data.records.map((r) => r.conversation_id);
    await assert.rejects(
      exportResults({ cfg: sb.cfg, set: 'dev', group: 'TEST', file: MINI, teamName: 'Команда', allowCount: true, out, providerOverride: served({ failIds: ids }) }),
      (e) => e instanceof ExportError && e.code === 5 && /Ни один диалог не оценён моделью: .*ECONNRESET/.test(e.message),
    );
    assert.equal(readFileSync(out, 'utf8'), 'ПРЕЖНИЙ ФАЙЛ');
  } finally { sb.done(); }
});

test('export: DEV must have exactly 65 dialogs — the 5-dialog fixture is refused with code 3', async () => {
  const sb = sandbox();
  try {
    await assert.rejects(
      exportResults({ cfg: sb.cfg, set: 'dev', group: 'TEST', file: MINI, teamName: 'Команда', out: join(sb.outDir, 'r.json'), providerOverride: served() }),
      (e) => e instanceof ExportError && e.code === 3 && /ровно 65/.test(e.message),
    );
  } finally { sb.done(); }
});

test('export PROD: group_id fetched from the API, exactly 10 records, a failed dialog becomes an error record (not 0, not N/A)', async () => {
  const sb = sandbox({ DATASET_API_URL: 'https://organisers.example/api/dataset?token=secret' });
  try {
    const seen = [];
    const r = await exportResults({
      cfg: sb.cfg, set: 'prod', group: 'CTRL-TEST', teamName: 'Команда', out: join(sb.outDir, 'results.json'),
      providerOverride: served({ failIds: ['ctl-07'] }), datasetFetchImpl: apiFetch(controlPayload(10), seen),
    });
    assert.equal(seen.length, 1);
    assert.equal(new URL(seen[0]).searchParams.get('group_id'), 'CTRL-TEST');
    assert.equal(r.report.ok, true, r.report.errors.join('\n'));
    assert.equal(r.doc.results.length, 10);
    assert.deepEqual(r.doc.results.map((x) => x.conversation_id), Array.from({ length: 10 }, (_, i) => `ctl-${String(i + 1).padStart(2, '0')}`));
    const failed = r.doc.results.find((x) => x.conversation_id === 'ctl-07');
    assert.deepEqual({ ...failed, error: typeof failed.error }, { conversation_id: 'ctl-07', status: 'error', criteria: [], score: null, error: 'string' });
    assert.match(failed.error, /ECONNRESET/);
    assert.equal(r.report.stats.ok, 9);
    assert.equal(r.report.stats.error, 1);
    assert.deepEqual(r.doc.model, { mode: 'local', name: SERVED });
    const manifest = readJson(join(sb.cfg.dataDir, 'results-manifest.json'));
    assert.equal(manifest.prod.group, 'CTRL-TEST');
    assert.equal(manifest.prod.valid, true);
    assert.doesNotMatch(JSON.stringify(manifest), /secret/);
  } finally { sb.done(); }
});

test('export PROD: wrong number of control dialogs (9) → stop with code 3; no group_id → refused', async () => {
  const sb = sandbox({ DATASET_API_URL: 'https://organisers.example/api/dataset' });
  try {
    const out = join(sb.outDir, 'results.json');
    await assert.rejects(
      exportResults({ cfg: sb.cfg, set: 'prod', group: 'CTRL-TEST', teamName: 'Команда', out, providerOverride: served(), datasetFetchImpl: apiFetch(controlPayload(9), []) }),
      (e) => e instanceof ExportError && e.code === 3 && /ровно 10/.test(e.message),
    );
    assert.equal(existsSync(out), false);
    await assert.rejects(exportResults({ cfg: sb.cfg, set: 'prod', teamName: 'Команда', out, providerOverride: served() }), /group_id/);
  } finally { sb.done(); }
});

test('export: offline rules go to results/preview with a NO-LLM model name that the submission check rejects', async () => {
  assert.equal(resultsPath('/p', 'dev', 'rules'), join('/p', 'results', 'preview', 'dev.rules-preview.json'));
  assert.equal(resultsPath('/p', 'prod', 'ai'), join('/p', 'results', 'prod', 'results.json'));
  const sb = sandbox();
  try {
    const r = await exportResults({ cfg: sb.cfg, set: 'dev', group: 'TEST', file: MINI, engine: 'rules', allowCount: true, out: join(sb.outDir, 'p.json') });
    assert.match(r.doc.model.name, /NO-LLM offline rules/);
    assert.equal(r.report.ok, true, r.report.errors.join('\n'));
    const source = readSourceRecords(sb.cfg, 'TEST');
    const strict = validateResults(readFileSync(r.path), { source, mode: 'submission' });
    assert.equal(strict.ok, false);
    assert.ok(strict.errors.some((e) => /не языковой моделью/.test(e)));
    assert.ok(strict.errors.some((e) => /team_name/.test(e)));
  } finally { sb.done(); }
});

test('model mode comes from the endpoint the evaluations actually used', () => {
  assert.equal(endpointMode('http://localhost:11434/v1'), 'local');
  assert.equal(endpointMode('http://192.168.1.20:8000/v1'), 'local');
  assert.equal(endpointMode('https://api.anthropic.com'), 'external_api');
  assert.equal(endpointMode(null), null);
});

// ------------------------------------------------------------------------------------------- validator on broken files

const crit = (doc, i, id) => doc.results[i].criteria.find((c) => c.criterion_id === id);
const MUTATIONS = [
  ['schema_version as a number', (d) => { d.schema_version = 1.0; }, /schema_version/],
  ['schema_version 1.1', (d) => { d.schema_version = '1.1'; }, /schema_version/],
  ['empty team_name', (d) => { d.team_name = '  '; }, /team_name: название команды не заполнено/],
  ['placeholder team_name', (d) => { d.team_name = 'Название команды'; }, /team_name: похоже на заглушку/],
  ['unknown model.mode', (d) => { d.model.mode = 'cloud'; }, /model\.mode/],
  ['placeholder model.name', (d) => { d.model.name = 'фактически использованная модель'; }, /model\.name: заглушка/],
  ['offline rules declared as the model', (d) => { d.model.name = 'offline rules v11'; }, /не языковой моделью/],
  ['missing model', (d) => { delete d.model; }, /нет поля «model»/],
  ['extra top-level field', (d) => { d.generated_at = '2026-11-07'; }, /лишнее поле «generated_at»/],
  ['extra model field', (d) => { d.model.provider = 'ollama'; }, /\$\.model: лишнее поле «provider»/],
  ['extra record field', (d) => { d.results[0].channel = 'chat'; }, /results\[0\]: лишнее поле «channel»/],
  ['extra criterion field', (d) => { crit(d, 0, 'contact').confidence = 0.9; }, /лишнее поле «confidence»/],
  ['extra score field', (d) => { d.results[0].score.max = 100; }, /score: лишнее поле «max»/],
  ['results is not an array', (d) => { d.results = {}; }, /results: должно быть массивом/],
  ['wrong record count', (d) => { d.results.pop(); }, /ожидается ровно 5 записей/],
  ['duplicate conversation_id', (d) => { d.results[1] = structuredClone(d.results[0]); }, /дубликат «t-ru-001»/],
  ['conversation_id not in the source', (d) => { d.results[0].conversation_id = 'invented-001'; }, /нет в исходном наборе/],
  ['source dialog missing from results', (d) => { d.results[0].conversation_id = 'invented-001'; }, /нет записей для исходных диалогов: t-ru-001/],
  ['7 criteria', (d) => { d.results[0].criteria.pop(); }, /ровно 8 критериев/],
  ['missing criterion', (d) => { d.results[0].criteria = d.results[0].criteria.filter((c) => c.criterion_id !== 'empathy'); }, /нет критерия «empathy»/],
  ['duplicate criterion', (d) => { d.results[0].criteria[6] = structuredClone(d.results[0].criteria[0]); }, /«contact» повторяется/],
  ['unknown criterion', (d) => { d.results[0].criteria[0].criterion_id = 'politeness'; }, /неизвестный критерий "politeness"/],
  ['boolean given as a string', (d) => { crit(d, 0, 'contact').value = 'true'; }, /для contact нужен true\/false/],
  ['null for a criterion without N/A', (d) => { crit(d, 0, 'contact').value = null; }, /null недопустим для contact/],
  ['consultation off the scale', (d) => { crit(d, 0, 'consultation').value = 12; }, /для consultation допустимо 0\/5\/10\/15\/20\/null/],
  ['dialogue off the scale', (d) => { crit(d, 0, 'dialogue').value = 5; }, /для dialogue допустимо 0\/4\/7\/10/],
  ['scale given as a string', (d) => { crit(d, 0, 'dialogue').value = '7'; }, /для dialogue допустимо/],
  ['critical null', (d) => { crit(d, 0, 'critical').value = null; }, /null недопустим для critical/],
  ['empty rationale', (d) => { crit(d, 0, 'empathy').rationale = ' '; }, /пустое обоснование/],
  ['evidence turn 0', (d) => { crit(d, 0, 'contact').evidence_turns = [0]; }, /целым ≥ 1, получено 0/],
  ['evidence turn beyond the transcript', (d) => { crit(d, 0, 'contact').evidence_turns = [999]; }, /реплики №999 нет: в транскрипте 7 сообщений/],
  ['fractional evidence turn', (d) => { crit(d, 0, 'contact').evidence_turns = [1.5]; }, /получено 1\.5/],
  ['duplicate evidence turns', (d) => { crit(d, 0, 'contact').evidence_turns = [5, 5]; }, /повторяющиеся номера/],
  ['no evidence for a scored value', (d) => { crit(d, 0, 'contact').evidence_turns = []; }, /нет доказательных реплик/],
  ['evidence_turns not an array', (d) => { crit(d, 0, 'contact').evidence_turns = '5'; }, /evidence_turns: должно быть массивом/],
  ['invented quote', (d) => { crit(d, 0, 'contact').rationale = 'Оператор написал «Мы вернём вам деньги завтра утром» (01:10).'; }, /цитаты нет в транскрипте/],
  ['final_score off by one', (d) => { d.results[0].score.final_score += 1; }, /≠ независимый пересчёт 90\.5/],
  ['three decimals', (d) => { d.results[0].score.final_score = 90.505; }, /больше двух знаков/],
  ['final_score as a string', (d) => { d.results[0].score.final_score = '90.5'; }, /final_score: должно быть числом/],
  ['final_score above 100', (d) => { d.results[0].score.final_score = 100.5; }, /вне диапазона/],
  ['critical_flag differs from critical.value', (d) => { d.results[0].score.critical_flag = true; }, /не совпадает с critical\.value = false/],
  ['ok record without score', (d) => { d.results[0].score = null; }, /score: должно быть объектом/],
  ['ok record with an error message', (d) => { d.results[0].error = 'timeout'; }, /у успешной записи должно быть null/],
  ['unknown status', (d) => { d.results[0].status = 'failed'; }, /допустимо "ok" или "error"/],
  ['error record keeps criteria', (d) => { d.results[0].status = 'error'; d.results[0].error = 'timeout'; d.results[0].score = null; }, /у записи с ошибкой должно быть \[\]/],
  ['error turned into 0 points', (d) => { Object.assign(d.results[0], { status: 'error', criteria: [], score: { final_score: 0, critical_flag: false }, error: 'timeout' }); }, /score: у записи с ошибкой должно быть null/],
  ['error record without a reason', (d) => { Object.assign(d.results[0], { status: 'error', criteria: [], score: null, error: '' }); }, /нужна причина ошибки/],
];

test(`validator: the valid file passes, each of ${MUTATIONS.length} deliberately broken variants fails with a precise message`, async () => {
  const { bytes, doc, source } = await miniExport();
  const base = validateResults(bytes, { expectCount: 5, source });
  assert.equal(base.ok, true, base.errors.join('\n'));
  for (const [name, mutate, expected] of MUTATIONS) {
    const d = structuredClone(doc);
    mutate(d);
    const v = validateResults(Buffer.from(JSON.stringify(d), 'utf8'), { expectCount: 5, source });
    assert.equal(v.ok, false, `«${name}» должен быть отклонён`);
    assert.ok(v.errors.some((e) => expected.test(e)), `«${name}»: нет ожидаемой ошибки ${expected}\n${v.errors.join('\n')}`);
  }
});

test('validator: byte level — BOM, invalid UTF-8, truncated JSON, non-object top level', async () => {
  const { bytes, source } = await miniExport();
  const bom = validateResults(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), { expectCount: 5, source });
  assert.ok(bom.errors.some((e) => /BOM/.test(e)));
  const broken = Buffer.from(bytes);
  broken[broken.indexOf(Buffer.from('Здравствуйте'))] = 0xff;
  assert.ok(validateResults(broken, { source }).errors.some((e) => /не является корректным UTF-8/.test(e)));
  assert.ok(validateResults(bytes.subarray(0, bytes.length - 40), { source }).errors.some((e) => /некорректный JSON/.test(e)));
  assert.ok(validateResults(Buffer.from('[]'), {}).errors.some((e) => /верхний уровень/.test(e)));
});

test('validator: error records are accepted only in the exact form {id, "error", [], null, reason}', async () => {
  const { doc, source } = await miniExport();
  const d = structuredClone(doc);
  d.results[2] = { conversation_id: d.results[2].conversation_id, status: 'error', criteria: [], score: null, error: 'Модель не ответила за 120 с' };
  const v = validateResults(Buffer.from(JSON.stringify(d)), { expectCount: 5, source });
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.equal(v.stats.error, 1);
});

// ------------------------------------------------------------------------------------------- score

test('final_score: independent integer recomputation equals the scoring engine on 5000 random combinations', () => {
  const checklist = validateChecklist(readJson(OFFICIAL_CHECKLIST)).checklist;
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let checked = 0;
  for (let k = 0; k < 5000; k += 1) {
    const entries = OFFICIAL_CRITERIA.map((oc) => {
      const opts = oc.kind === 'scale' ? [...oc.values] : [true, false];
      if (oc.nullable) opts.push(null);
      return { criterion_id: oc.id, value: opts[rnd(opts.length)] };
    });
    const results = OFFICIAL_CRITERIA.map((oc, i) => {
      const c = checklist.criteria.find((x) => x.code === oc.code);
      const v = entries[i].value;
      return { criterion_id: c.id, status: v === null ? 'na' : 'scored', answer: v === null ? null : oc.kind === 'scale' ? String(v) : v ? 'yes' : 'no' };
    });
    const engine = computeScore(checklist, results);
    const exact = exactFinalScore(entries);
    if (exact === null) { assert.equal(engine.total, null); continue; }
    assert.equal(engine.total, exact, JSON.stringify(entries));
    checked += 1;
  }
  assert.ok(checked > 4000);
  // critical never zeroes the score: all met + critical = true → still 100
  const all = OFFICIAL_CRITERIA.map((oc) => ({ criterion_id: oc.id, value: oc.kind === 'scale' ? Math.max(...oc.values) : oc.id !== 'critical' }));
  assert.equal(exactFinalScore(all), 100);
  assert.equal(exactFinalScore(all.map((c) => (c.criterion_id === 'critical' ? { ...c, value: true } : c))), 100);
});

test('mapping: N/A only where the format allows null; not evaluated is an error, never null or 0', () => {
  const contact = OFFICIAL_CRITERIA.find((c) => c.id === 'contact');
  const discovery = OFFICIAL_CRITERIA.find((c) => c.id === 'discovery');
  assert.match(toOfficialCriterion(contact, { status: 'na', explanation: 'x', evidence: [] }).error, /N\/A недопустим/);
  assert.equal(toOfficialCriterion(discovery, { status: 'na', na_reason: 'вопрос ясен', explanation: 'x', evidence: [] }).entry.value, null);
  assert.match(toOfficialCriterion(discovery, { status: 'not_evaluated', explanation: '', evidence: [] }).error, /не оценён/);
  assert.match(toOfficialCriterion(OFFICIAL_CRITERIA[3], { status: 'scored', answer: '12', explanation: 'x', evidence: [] }).error, /недопустимое значение/);
});

// ------------------------------------------------------------------------------------------- quotes

test('quotes: nesting, timed closing after a shortened inner quote, short labels are not quotes', () => {
  const s = 'Оператор: «Откройте вкладку «Кабинет» — тариф под ФИО» (01:10), затем «спасибо» и «Меню → Поручения →…» (02:00); кнопка «Купить».';
  const q = extractQuotes(s).map((x) => x.text);
  assert.deepEqual(q, ['Откройте вкладку «Кабинет» — тариф под ФИО', 'спасибо', 'Меню → Поручения →…', 'Купить']);
  assert.deepEqual(quotesToCheck(s).map((x) => x.text), ['Откройте вкладку «Кабинет» — тариф под ФИО', 'Меню → Поручения →…']);
  // the old lazy regex turned «спасибо» и «…» (01:10) into one invented quote
  assert.deepEqual(quotesToCheck('Сказал «спасибо» и «Меня зовут Алина» (01:10)').map((x) => x.text), ['Меня зовут Алина']);
  // an inner quote cut by shortening must not swallow the quotes that follow
  assert.deepEqual(quotesToCheck('«Здравствуйте. Откройте «Меню → Поручения →…» (00:40) и «Поняла, спасибо.» (01:00)').map((x) => x.text), ['Здравствуйте. Откройте «Меню → Поручения →…', 'Поняла, спасибо.']);
});

test('quotes: the AI-layer check and the validator agree (verified quote kept, invented one marked)', () => {
  const conv = buildConversation(parseDatasetPayload(readJson(MINI)).records[0], 'T');
  const r = checkExplanationQuotes('Оператор: «Меня зовут Алина» (01:10). Клиент: «спасибо большое за помощь вам».', conv);
  assert.deepEqual(r.cited.map((x) => x.id), ['m4']);
  assert.deepEqual(r.invented, ['спасибо большое за помощь вам']);
  assert.match(r.text, /«Меня зовут Алина» \(01:10\)/);
  assert.match(r.text, /\[пересказ модели, дословно в транскрипте нет: спасибо большое за помощь вам\]/);
  assert.equal(quotesToCheck(r.text).length, 1);
});

// ------------------------------------------------------------------------------------------- schema & DEV

test('JSON Schema: criterion ids, value types and enums match the format table', () => {
  const schema = readJson(join(ROOT, 'schemas', 'results-1.0.schema.json'));
  const branches = schema.$defs.criterion.oneOf.map((b) => [b.properties.criterion_id.const, b.properties.value]);
  assert.deepEqual(branches.map((b) => b[0]), OFFICIAL_CRITERIA.map((c) => c.id));
  for (const [id, v] of branches) {
    const oc = OFFICIAL_CRITERIA.find((c) => c.id === id);
    if (oc.kind === 'scale') assert.deepEqual(v.enum, oc.nullable ? [...oc.values, null] : oc.values, id);
    else assert.deepEqual(v.type, oc.nullable ? ['boolean', 'null'] : 'boolean', id);
  }
  const keys = (o) => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
  assert.equal(keys(schema).includes('multipleOf'), false, 'multipleOf 0.01 rejects valid two-decimal floats');
});

const py = spawnSync('python3', ['-c', 'import jsonschema'], { encoding: 'utf8' });
test('JSON Schema (third-party jsonschema): valid file passes, structural breakages fail', { skip: py.status !== 0 && 'python3 + jsonschema не установлены' }, async () => {
  const { doc } = await miniExport();
  const dir = mkdtempSync(join(tmpdir(), 'cqa-schema-'));
  try {
    const run = (d, name) => {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, JSON.stringify(d));
      return spawnSync('python3', [join(ROOT, 'scripts', 'check-schema.py'), p], { cwd: ROOT, encoding: 'utf8' });
    };
    assert.equal(run(doc, 'valid').status, 0);
    const structural = MUTATIONS.filter(([n]) => /extra|schema_version|model\.mode|missing model|not an array|7 criteria|duplicate criterion|unknown criterion|string|off the scale|null|turn 0|fractional|duplicate evidence|above 100|without score|error message|unknown status|keeps criteria|0 points|without a reason|empty team/.test(n));
    assert.ok(structural.length >= 25);
    for (const [name, mutate] of structural) {
      const d = structuredClone(doc);
      mutate(d);
      assert.equal(run(d, 'broken').status, 1, `схема должна отклонить: ${name}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const dev = devFile();
test('DEV: message m<i> is transcript[i] of the organisers\' file (turn = i + 1), for all 65 dialogs', { skip: !dev && 'DEV-набор не загружен локально' }, () => {
  const raw = JSON.parse(readFileSync(dev, 'utf8').replace(/^﻿/, ''));
  const parsed = parseDatasetPayload(raw);
  assert.equal(parsed.records.length, 65);
  for (const rec of parsed.records) {
    const conv = buildConversation(rec, 'DEV');
    const src = raw.data.records.find((x) => x.conversation_id === rec.conversation_id).transcript;
    assert.equal(conv.messages.length, src.length, rec.conversation_id);
    conv.messages.forEach((m, i) => {
      assert.equal(m.id, `m${i}`);
      assert.equal(turnOf(m.id), i + 1);
      assert.equal(m.original, src[i].text, `${rec.conversation_id} m${i}`);
    });
  }
});
