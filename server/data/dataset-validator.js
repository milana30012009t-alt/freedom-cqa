// Validation of the organisers' dataset payload (API response or local JSON file).
// Lenient where safe (e.g. transcript given as a JSON string), strict where data would be lost.
import { CHANNEL_TYPES, LANGUAGES, SPEAKERS } from '../../shared/constants.js';

export class DatasetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DatasetError';
    this.details = details;
  }
}

/**
 * @param {string|object} input raw text or parsed JSON
 * @returns {{records:Array, meta:object, errors:Array<string>, warnings:Array<string>, duplicates:Array<string>}}
 * @throws {DatasetError} when the payload is unusable
 */
export function parseDatasetPayload(input) {
  let payload = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    const text = String(input).replace(/^﻿/, '').trim();
    if (!text) throw new DatasetError('Пустой ответ: данные не получены');
    try {
      payload = JSON.parse(text);
    } catch (e) {
      throw new DatasetError(`Некорректный JSON: ${e.message}`);
    }
  }
  if (payload === null || typeof payload !== 'object') throw new DatasetError('Ожидался JSON-объект с полем data.records');

  const warnings = [];
  const errors = [];
  let data = payload;
  if (!Array.isArray(payload)) {
    if (payload.isSuccess === false) {
      throw new DatasetError(`API вернул ошибку: ${payload.error || 'isSuccess = false'}`);
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      throw new DatasetError(`API вернул ошибку: ${payload.error.trim()}`);
    }
    if (payload.isSuccess === undefined && payload.data) warnings.push('В ответе нет поля isSuccess');
    data = payload.data ?? payload;
  }
  const records = Array.isArray(data) ? data : data?.records;
  if (!Array.isArray(records)) throw new DatasetError('В ответе нет массива data.records');

  const meta = {
    dataset_group_id: Array.isArray(data) ? null : data?.dataset_group_id ?? null,
    total_records_declared: Array.isArray(data) ? null : Number.isFinite(data?.total_records) ? data.total_records : null,
    received: records.length,
  };
  if (meta.total_records_declared !== null && meta.total_records_declared !== records.length) {
    warnings.push(`total_records = ${meta.total_records_declared}, а получено записей: ${records.length}`);
  }

  const seen = new Set();
  const duplicates = [];
  const out = [];
  records.forEach((r, i) => {
    if (!r || typeof r !== 'object') { errors.push(`Запись #${i + 1}: не объект — пропущена`); return; }
    const id = typeof r.conversation_id === 'string' || typeof r.conversation_id === 'number' ? String(r.conversation_id).trim() : '';
    if (!id) { errors.push(`Запись #${i + 1}: нет conversation_id — пропущена`); return; }
    if (seen.has(id)) { duplicates.push(id); return; }
    seen.add(id);

    let transcript = r.transcript;
    if (typeof transcript === 'string') {
      try {
        transcript = JSON.parse(transcript);
        warnings.push(`${id}: transcript передан строкой — разобран как JSON`);
      } catch {
        errors.push(`${id}: transcript не является массивом и не разбирается как JSON — пропущена`);
        return;
      }
    }
    if (!Array.isArray(transcript)) { errors.push(`${id}: transcript не является массивом — пропущена`); return; }
    if (!transcript.length) warnings.push(`${id}: пустой транскрипт`);

    const channel = String(r.channel ?? '').trim();
    if (!CHANNEL_TYPES[channel.toLowerCase()]) warnings.push(`${id}: неизвестный канал «${channel}»`);
    const language = String(r.language ?? '').trim().toUpperCase();
    if (!LANGUAGES.includes(language)) warnings.push(`${id}: неизвестный язык «${r.language}»`);

    const messages = [];
    transcript.forEach((m, j) => {
      if (!m || typeof m !== 'object') { warnings.push(`${id}: реплика #${j + 1} не объект — пропущена`); return; }
      const speaker = String(m.speaker ?? '').trim();
      if (!SPEAKERS.includes(speaker.toLowerCase())) warnings.push(`${id}: реплика #${j + 1} — неизвестная роль «${speaker}» (сохранена как unknown)`);
      if (typeof m.text !== 'string') warnings.push(`${id}: реплика #${j + 1} без текста`);
      messages.push({
        timestamp: m.timestamp === undefined || m.timestamp === null ? null : String(m.timestamp),
        speaker,
        text: typeof m.text === 'string' ? m.text : m.text === undefined || m.text === null ? '' : String(m.text),
      });
    });

    const audio = typeof r.audio_url === 'string' && r.audio_url.trim() ? r.audio_url.trim() : null;
    if (audio && !/^https?:\/\//i.test(audio)) warnings.push(`${id}: audio_url не похож на http(s)-ссылку`);
    if (!audio && channel.toLowerCase() === 'voice call') warnings.push(`${id}: звонок без audio_url`);

    out.push({ conversation_id: id, channel, language, transcript: messages, audio_url: audio });
  });
  if (duplicates.length) warnings.push(`Пропущено дубликатов conversation_id: ${duplicates.length} (${[...new Set(duplicates)].join(', ')})`);
  if (!out.length) throw new DatasetError('В наборе нет ни одной корректной записи', { errors });
  return { records: out, meta, errors, warnings, duplicates };
}
