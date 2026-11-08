// Timestamp utilities. Original timestamps are never modified: these helpers only
// derive numeric offsets used for sorting-free display and audio synchronisation.
//
// Chats:  "MM:SS" (can also be "H:MM:SS" or "MMM:SS" for long chats)
// Calls:  ISO 8601 with time zone and up to 7 fractional digits,
//         e.g. "2026-11-03T15:49:13.1900670+00:00" (Date.parse is not reliable for 7 digits).

const CLOCK_RE = /^\s*(\d{1,3}):(\d{2})(?::(\d{2}))?(?:[.,](\d+))?\s*$/;
const ISO_RE = /^\s*(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i;

/**
 * Parse a raw timestamp.
 * @returns {{kind:'clock', seconds:number} | {kind:'iso', epochMs:number, offsetMinutes:number|null} | {kind:'unknown'}}
 */
export function parseTimestamp(raw) {
  if (raw === null || raw === undefined) return { kind: 'unknown' };
  const s = String(raw);
  const iso = ISO_RE.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec = '0', frac = '', tz] = iso;
    let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
    if (frac) ms += Number(`0.${frac}`) * 1000;
    let offsetMinutes = null;
    if (tz && tz.toUpperCase() !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1;
      const digits = tz.slice(1).replace(':', '');
      offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
      ms -= offsetMinutes * 60000;
    } else if (tz) {
      offsetMinutes = 0;
    }
    if (!Number.isFinite(ms)) return { kind: 'unknown' };
    return { kind: 'iso', epochMs: ms, offsetMinutes };
  }
  const clock = CLOCK_RE.exec(s);
  if (clock) {
    const [, a, b, c, frac] = clock;
    let seconds = c !== undefined ? (+a * 3600 + +b * 60 + +c) : (+a * 60 + +b);
    if (frac) seconds += Number(`0.${frac}`);
    return { kind: 'clock', seconds };
  }
  return { kind: 'unknown' };
}

/** Format seconds as M:SS / MM:SS / H:MM:SS. */
export function formatClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return '—';
  const neg = totalSeconds < 0;
  let s = Math.floor(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return `${neg ? '-' : ''}${h > 0 ? `${h}:${mm}` : mm}:${ss}`;
}

/** Human duration in Russian, e.g. "2 мин 14 с". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} мин ${rest} с` : `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}

/**
 * Compute offsets (seconds from the first message) for a list of raw timestamps.
 * Unknown timestamps inherit the previous known offset so the order is preserved
 * visually without inventing time.
 * @param {string[]} rawList
 * @returns {{offsets:(number|null)[], kind:'clock'|'iso'|'mixed'|'unknown', startEpochMs:number|null}}
 */
export function computeOffsets(rawList) {
  const parsed = rawList.map(parseTimestamp);
  const kinds = new Set(parsed.map((p) => p.kind).filter((k) => k !== 'unknown'));
  const kind = kinds.size === 0 ? 'unknown' : kinds.size === 1 ? [...kinds][0] : 'mixed';
  let base = null;
  let startEpochMs = null;
  for (const p of parsed) {
    if (p.kind === 'iso') {
      if (startEpochMs === null || p.epochMs < startEpochMs) startEpochMs = p.epochMs;
    }
  }
  const offsets = parsed.map((p) => {
    if (p.kind === 'clock') {
      if (base === null) base = 0; // chat clocks are already relative to the chat start
      return p.seconds;
    }
    if (p.kind === 'iso') return (p.epochMs - startEpochMs) / 1000;
    return null;
  });
  return { offsets, kind, startEpochMs };
}

/**
 * Map a transcript offset to a position in the audio file.
 * Recording pauses ("Запись и транскрибирование приостановлены/возобновлены") can be
 * removed from the timeline when pauseAware is true. A manual calibration offset
 * (seconds) can be added per conversation.
 * @param {number} offset seconds from the first transcript event
 * @param {{pauses?:Array<[number,number]>, pauseAware?:boolean, anchor?:number, calibration?:number}} opts
 */
export function transcriptToAudioTime(offset, opts = {}) {
  const { pauses = [], pauseAware = false, anchor = 0, calibration = 0 } = opts;
  if (!Number.isFinite(offset)) return null;
  let t = offset - anchor;
  if (pauseAware) {
    for (const [start, end] of pauses) {
      if (end <= start) continue;
      if (offset >= end) t -= end - start;
      else if (offset > start) t -= offset - start;
    }
  }
  return Math.max(0, t + calibration);
}

/** Inverse of transcriptToAudioTime (used to highlight the active message while playing). */
export function audioToTranscriptTime(audioTime, opts = {}) {
  const { pauses = [], pauseAware = false, anchor = 0, calibration = 0 } = opts;
  let t = audioTime - calibration + anchor;
  if (pauseAware) {
    for (const [start, end] of [...pauses].sort((a, b) => a[0] - b[0])) {
      if (end <= start) continue;
      if (t >= start) t += end - start;
    }
  }
  return t;
}

/** Format an epoch (ms) in a stable, locale-friendly way: "03.11.2026 15:49". */
export function formatDateTime(epochMs, timeZone) {
  if (!Number.isFinite(epochMs)) return '—';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ');
  }
}
