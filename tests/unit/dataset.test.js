import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDatasetPayload, DatasetError } from '../../server/data/dataset-validator.js';
import { buildConversation } from '../../server/data/transcript-model.js';
import { normalizeText } from '../../shared/text-quality.js';
import { MINI, readJson, devFile, toMojibake } from '../helpers.js';

test('API payload: records extracted, structure validated', () => {
  const r = parseDatasetPayload(readFileSync(MINI, 'utf8'));
  assert.equal(r.records.length, 5);
  assert.equal(r.meta.dataset_group_id, 'TEST');
  assert.deepEqual(r.errors, []);
});

test('empty, broken or unsuccessful payloads are rejected with clear errors', () => {
  assert.throws(() => parseDatasetPayload(''), DatasetError);
  assert.throws(() => parseDatasetPayload('{"error":"", "isSuccess": true, "data": {'), /Некорректный JSON/);
  assert.throws(() => parseDatasetPayload({ isSuccess: false, error: 'group not found', data: null }), /group not found/);
  assert.throws(() => parseDatasetPayload({ isSuccess: true, error: '', data: {} }), /data\.records/);
  assert.throws(() => parseDatasetPayload({ isSuccess: true, error: '', data: { records: [{ foo: 1 }] } }), /ни одной корректной записи/);
});

test('duplicates are dropped, transcript given as a string is parsed, unknown roles reported', () => {
  const payload = readJson(MINI);
  const dup = structuredClone(payload.data.records[0]);
  const asString = { ...structuredClone(payload.data.records[1]), conversation_id: 't-str', transcript: JSON.stringify(payload.data.records[1].transcript) };
  asString.transcript = asString.transcript.replace('"speaker":"client"', '"speaker":"customer"');
  payload.data.records.push(dup, asString);
  payload.data.total_records = 7;
  const r = parseDatasetPayload(payload);
  assert.equal(r.records.length, 6);
  assert.deepEqual(r.duplicates, ['t-ru-001']);
  assert.ok(r.warnings.some((w) => w.includes('t-str') && w.includes('строкой')));
  assert.ok(r.warnings.some((w) => w.includes('неизвестная роль')));
  const conv = buildConversation(r.records.find((x) => x.conversation_id === 't-str'), 'TEST');
  assert.equal(conv.messages[0].speaker, 'unknown');
  assert.equal(conv.messages[0].speaker_raw, 'customer');
});

test('roles, segments and events: bot/system are context, hold is internal, end detected', () => {
  const { records } = parseDatasetPayload(readJson(MINI));
  const call = buildConversation(records.find((r) => r.conversation_id === 't-call-001'), 'TEST');
  assert.equal(call.channel_type, 'call');
  assert.equal(call.timestamp_kind, 'iso');
  const hold = call.messages.find((m) => m.text.startsWith('Коллеги'));
  assert.equal(hold.segment, 'hold');
  assert.ok(hold.flags.includes('internal'));
  assert.deepEqual(call.events.recording_pauses, [[10, 22]]);
  assert.equal(call.events.client_left, 19);
  assert.equal(call.messages[5].t_label, '+00:25');
  assert.equal(call.messages[5].ts, '2026-11-03T10:00:25.0000000+00:00');
  const chat = buildConversation(records[0], 'TEST');
  assert.equal(chat.messages[1].segment, 'pre');
  assert.equal(chat.stats.first_response_sec, 48);
  assert.ok(!('audio_url' in chat));
});

test('encoding damage in a record is repaired for display, original kept', () => {
  const payload = readJson(MINI);
  const rec = payload.data.records[0];
  rec.transcript = rec.transcript.map((m) => ({ ...m, text: toMojibake(m.text) }));
  const conv = buildConversation(parseDatasetPayload(payload).records[0], 'TEST');
  assert.equal(conv.messages[0].text, 'Где посмотреть мой тариф? В приложении не нахожу.');
  assert.notEqual(conv.messages[0].original, conv.messages[0].text);
  assert.equal(conv.quality.repaired_messages, rec.transcript.length);
});

const dev = devFile();
test('DEV dataset: 65 records, 35 RU / 15 KZ / 15 EN, 60 chats / 5 calls, all roles, all encoding repaired', { skip: dev ? false : 'DEV-набор не найден (data/datasets/DEV.raw.json или CQA_DEV_FILE)' }, () => {
  const r = parseDatasetPayload(readFileSync(dev, 'utf8'));
  assert.equal(r.records.length, 65);
  const convs = r.records.map((x) => buildConversation(x, 'DEV'));
  const count = (f) => convs.reduce((acc, c) => { acc[f(c)] = (acc[f(c)] || 0) + 1; return acc; }, {});
  assert.deepEqual(count((c) => c.language), { RU: 35, KZ: 15, EN: 15 });
  assert.deepEqual(count((c) => c.channel_type), { chat: 60, call: 5 });
  const speakers = new Set(convs.flatMap((c) => c.messages.map((m) => m.speaker)));
  assert.deepEqual([...speakers].sort(), ['bot', 'client', 'operator', 'system']);
  assert.equal(convs.reduce((s, c) => s + c.quality.unrepaired_messages, 0), 0);
  // 1032 whole-message repairs + 5 fragment repairs (short replies / a word inside English text)
  assert.equal(convs.reduce((s, c) => s + c.quality.repaired_messages, 0), 1037);
  // round trip with the platform's standard windows-1251 decoder: damage(repaired) === original, for every repair
  const cp1251 = new TextDecoder('windows-1251');
  const damage = (t) => cp1251.decode(Buffer.from(t, 'utf8')).replace(/\u00A0/g, ' ');
  const repaired = convs.flatMap((c) => c.messages.filter((m) => m.changed));
  assert.ok(repaired.every((m) => damage(m.text) === m.original));
  // the repaired texts are a large clean RU/KZ/EN corpus: running the repair again must change nothing
  assert.ok(repaired.every((m) => normalizeText(m.text, {}).changed === false));
  const calls = convs.filter((c) => c.channel_type === 'call');
  assert.ok(calls.every((c) => c.has_audio && c.timestamp_kind === 'iso'));
  assert.ok(convs.filter((c) => c.channel_type === 'chat').every((c) => c.timestamp_kind === 'clock' && !c.has_audio));
});
