// Text quality control: encoding-damage (mojibake) detection and safe repair,
// plus lightweight ASR/transcript quality flags.
//
// Principles (from the specification):
//  * the original text is never modified — we return a normalised copy and the method used;
//  * we only repair when the repair is provably consistent (strict UTF-8 decode succeeds);
//  * unclear fragments are flagged, never "guessed".

// Windows-1251 bytes 0x80..0xBF -> Unicode. 0x98 is undefined in CP1251; Windows maps it to U+0098,
// which is exactly what we see in the damaged DEV file ("Р\u0098" == "И").
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ' + // 0x80-0x8F
  'ђ‘’“”•–—\u0098™љ›њќћџ' + // 0x90-0x9F
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї' + // 0xA0-0xAF
  '°±Ііґµ¶·ё№є»јЅѕї'; // 0xB0-0xBF

const UNICODE_TO_CP1251 = new Map();
for (let i = 0; i < 0x80; i += 1) UNICODE_TO_CP1251.set(i, i);
for (let i = 0; i < CP1251_HIGH.length; i += 1) UNICODE_TO_CP1251.set(CP1251_HIGH.charCodeAt(i), 0x80 + i);
for (let i = 0; i < 64; i += 1) UNICODE_TO_CP1251.set(0x0410 + i, 0xC0 + i); // А..я

// Characters that represent UTF-8 continuation bytes (0x80..0xBF) when misread as CP1251.
const CONTINUATION_CHARS = new Set([...CP1251_HIGH]);
// Characters that represent UTF-8 lead bytes for Cyrillic / punctuation when misread:
// 0xC2 'В', 0xD0 'Р', 0xD1 'С', 0xD2 'Т', 0xD3 'У', 0xE2 'в'.
const LEAD_CHARS = new Set(['В', 'Р', 'С', 'Т', 'У', 'в']);

/**
 * Count "lead + continuation" pairs typical for UTF-8 text decoded as CP1251.
 * @returns {{pairs:number, letters:number, score:number, isMojibake:boolean}}
 */
export function detectMojibake(text) {
  if (typeof text !== 'string' || text.length < 2) return { pairs: 0, letters: 0, score: 0, isMojibake: false };
  let pairs = 0;
  let letters = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!/\s/.test(ch)) letters += 1;
    if (LEAD_CHARS.has(ch)) {
      const next = text[i + 1];
      // A collapsed NBSP (0xA0 -> ' ') after 'Р' is also typical ("Р " == "Р").
      if (next !== undefined && (CONTINUATION_CHARS.has(next) || (ch === 'Р' && next === ' ' && i + 2 < text.length))) {
        pairs += 1;
        i += 1;
        if (!/\s/.test(next)) letters += 1;
      }
    }
  }
  const score = letters ? (pairs * 2) / letters : 0;
  return { pairs, letters, score, isMojibake: pairs >= 2 && score >= 0.3 };
}

function toCp1251Bytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const b = UNICODE_TO_CP1251.get(text.charCodeAt(i));
    if (b === undefined) return null; // character cannot come from CP1251 -> not this kind of damage
    bytes[i] = b;
  }
  // Restore NBSP (0xA0) bytes that were collapsed into regular spaces inside multi-byte sequences.
  let need = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (need > 0) {
      if (b >= 0x80 && b <= 0xBF) { need -= 1; continue; }
      if (b === 0x20) { bytes[i] = 0xA0; need -= 1; continue; }
      need = 0;
    }
    if (b >= 0xC2 && b <= 0xDF) need = 1;
    else if (b >= 0xE0 && b <= 0xEF) need = 2;
    else if (b >= 0xF0 && b <= 0xF4) need = 3;
  }
  return bytes;
}

let strictDecoder = null;
function decodeUtf8Strict(bytes) {
  if (!strictDecoder) strictDecoder = new TextDecoder('utf-8', { fatal: true });
  return strictDecoder.decode(bytes);
}

/**
 * Try to repair "UTF-8 read as Windows-1251" damage.
 * @returns {{text:string, changed:boolean, method:string|null, detail:string}}
 */
export function repairMojibake(text) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', changed: false, method: null, detail: 'empty' };
  const detection = detectMojibake(text);
  if (!detection.isMojibake) return { text, changed: false, method: null, detail: 'clean' };
  let current = text;
  let rounds = 0;
  // Double damage is possible in principle; never loop more than twice.
  while (rounds < 2 && detectMojibake(current).isMojibake) {
    const bytes = toCp1251Bytes(current);
    if (!bytes) return { text, changed: false, method: null, detail: 'unmappable-characters' };
    let decoded;
    try {
      decoded = decodeUtf8Strict(bytes);
    } catch {
      return rounds === 0
        ? { text, changed: false, method: null, detail: 'strict-utf8-decode-failed' }
        : { text: current, changed: current !== text, method: 'utf8-as-cp1251', detail: `partial-after-${rounds}` };
    }
    current = decoded;
    rounds += 1;
  }
  return { text: current, changed: current !== text, method: 'utf8-as-cp1251', detail: rounds > 1 ? 'double' : 'single' };
}

const MASK_RE = /\[[^\]]{0,40}(скрыт|hidden|masked|жасырын)[^\]]{0,40}\]/iu;
const DTMF_RE = /^[\s\d#*]+$/u;
const INTERJECTIONS = new Set([
  'алло', 'да', 'нет', 'угу', 'мхм', 'ага', 'так', 'хорошо', 'ок', 'окей', 'спасибо', 'понятно', 'ясно',
  'иә', 'жоқ', 'жарайды', 'рақмет', 'жақсы', 'yes', 'no', 'ok', 'okay', 'thanks', 'hello', 'да да', 'а',
  'сейчас', 'минуту', 'далее', 'город', 'понял', 'поняла', 'как', 'алло здравствуйте',
]);
const BRAND_LATIN = /^(freedom|broker|tradernet|global|whatsapp|nasdaq|nyse|investors|kz|aim|d|sms)$/i;

/**
 * Per-message quality flags.
 * @param {string} text normalised text
 * @param {{channelType?:'chat'|'call', language?:string}} ctx
 * @returns {string[]} flags
 */
export function assessMessage(text, ctx = {}) {
  const flags = [];
  const t = (text || '').trim();
  if (!t) { flags.push('empty'); return flags; }
  if (t.includes('�')) flags.push('replacement_char');
  if (MASK_RE.test(t)) flags.push('masked_pii');
  if (ctx.channelType === 'call' && ctx.speaker !== 'system') {
    if (DTMF_RE.test(t)) flags.push('dtmf');
    const words = t.replace(/[.,!?;:«»"()]/g, ' ').split(/\s+/).filter(Boolean);
    const norm = t.toLowerCase().replace(/[.,!?]/g, '').trim();
    if (!flags.includes('masked_pii') && !flags.includes('dtmf') && words.length <= 2 && !INTERJECTIONS.has(norm)) {
      flags.push('asr_fragment');
    }
    if ((ctx.language === 'RU' || ctx.language === 'KZ')
      && words.some((w) => /^[a-z]{3,}$/i.test(w) && !BRAND_LATIN.test(w))) {
      flags.push('asr_suspicious_token');
    }
  }
  // A word mixing Latin and Cyrillic letters is a strong sign of encoding/recognition damage.
  // Tokens are split on hyphens too, so "AI-ассистент" or "D-счёт" are not flagged.
  const mixed = t.replace(/\[[^\]]*\]/g, ' ').split(/[\s\-–—/«»"()]+/)
    .some((w) => /[a-z]/i.test(w) && /[а-яёәғқңөұүһі]/i.test(w));
  if (mixed) flags.push('mixed_script');
  return flags;
}

export const QUALITY_FLAG_LABELS = Object.freeze({
  encoding_repaired: 'Исправлена кодировка',
  encoding_unrepaired: 'Повреждена кодировка',
  replacement_char: 'Нечитаемые символы',
  masked_pii: 'Данные скрыты',
  dtmf: 'Тоновый набор',
  asr_fragment: 'Фрагмент распознавания',
  asr_suspicious_token: 'Сомнительное распознавание',
  mixed_script: 'Смешение алфавитов',
  duplicate: 'Дубликат реплики',
  after_end: 'После завершения',
  empty: 'Пустая реплика',
  internal: 'Внутренний разговор (клиент на удержании)',
});

/**
 * Normalise a message text and return everything needed to display/compare it.
 */
export function normalizeText(original, ctx = {}) {
  const raw = typeof original === 'string' ? original : String(original ?? '');
  const repair = repairMojibake(raw);
  const flags = assessMessage(repair.text, ctx);
  if (repair.changed) flags.unshift('encoding_repaired');
  else if (detectMojibake(raw).isMojibake) flags.unshift('encoding_unrepaired');
  return {
    text: repair.text,
    original: raw,
    changed: repair.changed,
    method: repair.method,
    method_detail: repair.detail,
    flags,
  };
}

/** Detect the script/language of a short text: 'KZ' | 'RU' | 'EN' | null. */
export function detectLanguage(text) {
  const t = (text || '').replace(/\[[^\]]*\]/g, '').replace(/«[^»]*»/g, '');
  if (/[әғқңөұүһі]/i.test(t)) return 'KZ';
  const cyr = (t.match(/[а-яё]/gi) || []).length;
  const lat = (t.match(/[a-z]/gi) || []).length;
  if (!cyr && !lat) return null;
  return cyr >= lat ? 'RU' : 'EN';
}
