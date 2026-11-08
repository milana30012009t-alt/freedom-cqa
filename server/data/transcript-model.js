// Builds the normalised conversation model from a validated API record.
// Original texts and timestamps are preserved verbatim next to the normalised values.
import { createHash } from 'node:crypto';
import { normalizeText } from '../../shared/text-quality.js';
import { computeOffsets, formatClock } from '../../shared/time.js';
import { CHANNEL_TYPES, SPEAKERS } from '../../shared/constants.js';

// System events (RU / KZ / EN wording seen in Dynamics 365 Omnichannel logs).
export const SYSTEM_EVENTS = {
  escalation: /эскалац|операторға жіберілді|transferred to an agent|переведен от агента на представителя|передан оператору|переведен на оператора/iu,
  agentJoined: /агент присоединился|agent joined|оператор подключился|оператор қосылды/iu,
  identityVerified: /личность клиента подтверждена|жеке басы расталды|identity verified|личность подтверждена/iu,
  clientLeft: /клиент покинул|клиент завершил|соединение с клиентом прервано|байланыс үзілді|connection to customer lost|customer left|customer ended|клиент отключился/iu,
  operatorClosed: /оператор закрыл|оператор чатты жапты|agent closed|operator closed/iu,
  holdEnd: /больше не находится на удержании|снят с удержания|off hold|removed from hold|resumed from hold/iu,
  holdStart: /на удержании|on hold/iu,
  consultStart: /консультаци[яи] с агентом|consult(?:ation)? (?:started|initiated)/iu,
  consultEnd: /агент вышел из разговора|agent left the (?:conversation|call)/iu,
  recordingStarted: /запись и транскрибирование запущены|жазу және транскрипция басталды|recording (?:and transcription )?started/iu,
  recordingPaused: /запись и транскрибирование приостановлены|recording (?:and transcription )?paused|жазу .*тоқтатыл/iu,
  recordingResumed: /запись и транскрибирование возобновлены|recording (?:and transcription )?resumed|жазу .*жалғас/iu,
};

export function transcriptHash(transcript) {
  return createHash('sha256').update(JSON.stringify(transcript)).digest('hex').slice(0, 16);
}

/**
 * @param {{conversation_id:string, channel:string, language:string, transcript:Array, audio_url:string|null}} record
 * @param {string} group dataset group id (DEV, control group, ...)
 */
export function buildConversation(record, group) {
  const channelType = CHANNEL_TYPES[String(record.channel || '').toLowerCase()] || 'unknown';
  const language = String(record.language || '').toUpperCase();
  const rawMessages = Array.isArray(record.transcript) ? record.transcript : [];
  const { offsets, kind: timestampKind, startEpochMs } = computeOffsets(rawMessages.map((m) => m?.timestamp));

  const messages = rawMessages.map((m, index) => {
    const speakerRaw = String(m?.speaker ?? '').trim();
    const speakerNorm = speakerRaw.toLowerCase();
    const speaker = SPEAKERS.includes(speakerNorm) ? speakerNorm : 'unknown';
    const n = normalizeText(m?.text, { channelType, language, speaker });
    const t = offsets[index];
    return {
      id: `m${index}`,
      index,
      speaker,
      speaker_raw: speakerRaw,
      ts: m?.timestamp ?? null,
      t,
      t_label: Number.isFinite(t) ? (timestampKind === 'iso' ? `+${formatClock(t)}` : formatClock(t)) : '—',
      text: n.text,
      original: n.original,
      changed: n.changed,
      method: n.method,
      method_detail: n.method_detail,
      flags: n.flags,
      segment: 'live',
    };
  });

  // Duplicate fragments (same speaker, text and timestamp as the previous message).
  for (let i = 1; i < messages.length; i += 1) {
    const a = messages[i - 1];
    const b = messages[i];
    if (a.speaker === b.speaker && a.text === b.text && a.ts === b.ts) b.flags.push('duplicate');
  }

  // Events
  const events = {
    escalation: null, agent_joined: null, operator_first: null, identity_verified: null,
    client_left: null, operator_closed: null, end: null, recording_started: null,
    hold_ranges: [], recording_pauses: [],
  };
  let holdStart = null;
  let pauseStart = null;
  for (const m of messages) {
    if (m.speaker === 'operator' && events.operator_first === null) events.operator_first = m.index;
    if (m.speaker !== 'system') continue;
    const t = m.text;
    if (events.escalation === null && SYSTEM_EVENTS.escalation.test(t)) events.escalation = m.index;
    if (events.agent_joined === null && SYSTEM_EVENTS.agentJoined.test(t)) events.agent_joined = m.index;
    if (events.identity_verified === null && SYSTEM_EVENTS.identityVerified.test(t)) events.identity_verified = m.index;
    if (events.client_left === null && SYSTEM_EVENTS.clientLeft.test(t)) events.client_left = m.index;
    if (events.operator_closed === null && SYSTEM_EVENTS.operatorClosed.test(t)) events.operator_closed = m.index;
    if (events.recording_started === null && SYSTEM_EVENTS.recordingStarted.test(t)) events.recording_started = m.index;
    if (SYSTEM_EVENTS.holdEnd.test(t)) {
      if (holdStart !== null) events.hold_ranges.push([holdStart, m.index]);
      holdStart = null;
    } else if (SYSTEM_EVENTS.holdStart.test(t) && holdStart === null) {
      holdStart = m.index;
    }
    if (SYSTEM_EVENTS.recordingPaused.test(t)) pauseStart = m.t;
    else if (SYSTEM_EVENTS.recordingResumed.test(t) && pauseStart !== null && Number.isFinite(m.t)) {
      events.recording_pauses.push([pauseStart, m.t]);
      pauseStart = null;
    }
  }
  if (holdStart !== null) events.hold_ranges.push([holdStart, messages.length - 1]);
  const ends = [events.client_left, events.operator_closed].filter((x) => x !== null);
  events.end = ends.length ? Math.min(...ends) : null;

  // Segments: pre (bot / IVR) → queue → live → hold → after_end
  const handoff = events.escalation ?? events.agent_joined;
  for (const m of messages) {
    if (events.operator_first === null || m.index < events.operator_first) {
      m.segment = handoff !== null && m.index > handoff ? 'queue' : 'pre';
    }
    if (events.end !== null && m.index > events.end) {
      m.segment = 'after_end';
      if (!m.flags.includes('after_end')) m.flags.push('after_end');
    }
  }
  for (const [a, b] of events.hold_ranges) {
    for (let i = a + 1; i < b; i += 1) {
      const m = messages[i];
      if (m.segment === 'after_end') continue;
      m.segment = 'hold';
      if (m.speaker === 'operator' && !m.flags.includes('internal')) m.flags.push('internal');
    }
  }

  // Quality summary
  const repaired = messages.filter((m) => m.changed).length;
  const unrepaired = messages.filter((m) => m.flags.includes('encoding_unrepaired')).length;
  const asrFlagged = messages.filter((m) => m.flags.some((f) => f === 'asr_fragment' || f === 'asr_suspicious_token' || f === 'mixed_script')).length;
  const masked = messages.filter((m) => m.flags.includes('masked_pii')).length;
  const dup = messages.filter((m) => m.flags.includes('duplicate')).length;
  const notes = [];
  if (repaired) notes.push(`Кодировка восстановлена в ${repaired} из ${messages.length} реплик (UTF-8, прочитанный как Windows-1251). Оригинал сохранён.`);
  if (unrepaired) notes.push(`${unrepaired} реплик с признаками повреждения кодировки не удалось безопасно восстановить — показан оригинал.`);
  if (channelType === 'call') notes.push('Звонок: текст получен автоматическим распознаванием речи. Интонация, тембр и дикция не анализируются — система работает только с транскриптом.');
  if (asrFlagged) notes.push(`${asrFlagged} реплик похожи на ошибки распознавания (обрывки, сомнительные слова).`);
  if (masked) notes.push(`В ${masked} репликах персональные данные скрыты в исходных данных.`);
  if (dup) notes.push(`${dup} дублирующихся фрагментов (оставлены в исходном порядке).`);
  const asrShare = messages.length ? asrFlagged / messages.length : 0;
  const level = unrepaired > 0 || asrShare > 0.25 ? 'low' : channelType === 'call' || asrShare > 0.1 ? 'medium' : 'good';

  const bySpeaker = {};
  for (const m of messages) bySpeaker[m.speaker] = (bySpeaker[m.speaker] || 0) + 1;
  const firstOp = events.operator_first !== null ? messages[events.operator_first] : null;
  const handoffMsg = handoff !== null ? messages[handoff] : null;
  const firstResponseSec = firstOp && handoffMsg && Number.isFinite(firstOp.t) && Number.isFinite(handoffMsg.t)
    ? Math.max(0, firstOp.t - handoffMsg.t) : null;
  const lastT = [...messages].reverse().find((m) => Number.isFinite(m.t))?.t ?? null;
  const firstClient = messages.find((m) => m.speaker === 'client' && !m.flags.includes('dtmf') && m.text.length > 3);

  const recordingStartT = events.recording_started !== null ? messages[events.recording_started].t : 0;

  return {
    uid: `${group}:${record.conversation_id}`,
    conversation_id: record.conversation_id,
    group,
    channel: record.channel,
    channel_type: channelType,
    language,
    has_audio: Boolean(record.audio_url),
    transcript_hash: transcriptHash(rawMessages),
    timestamp_kind: timestampKind,
    started_at: startEpochMs,
    duration_sec: lastT,
    messages,
    events,
    audio_sync: {
      anchor: Number.isFinite(recordingStartT) ? recordingStartT : 0,
      pauses: events.recording_pauses,
      pause_aware_default: true,
    },
    quality: { level, repaired_messages: repaired, unrepaired_messages: unrepaired, asr_flagged_messages: asrFlagged, masked_messages: masked, notes },
    stats: { message_count: messages.length, by_speaker: bySpeaker, first_response_sec: firstResponseSec },
    preview: firstClient ? firstClient.text.slice(0, 160) : '',
  };
}

/** Public projection of a conversation for the browser (never includes audio URLs). */
export function publicConversation(conv, { includeMessages = true } = {}) {
  const { messages, ...rest } = conv;
  return includeMessages ? { ...rest, messages } : rest;
}
