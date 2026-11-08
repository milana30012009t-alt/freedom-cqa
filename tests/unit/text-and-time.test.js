import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairMojibake, detectMojibake, normalizeText, assessMessage, detectLanguage } from '../../shared/text-quality.js';
import { parseTimestamp, computeOffsets, transcriptToAudioTime, audioToTranscriptTime, formatClock } from '../../shared/time.js';
import { toMojibake } from '../helpers.js';

test('mojibake: Russian text damaged as UTF-8→CP1251 is restored exactly', () => {
  const src = 'Здравствуйте! Меня зовут Алина. Откройте «Меню → Пополнить → Перевод по реквизитам».';
  const broken = toMojibake(src);
  assert.notEqual(broken, src);
  assert.ok(detectMojibake(broken).isMojibake);
  const r = repairMojibake(broken);
  assert.equal(r.text, src);
  assert.equal(r.method, 'utf8-as-cp1251');
});

test('mojibake: undefined CP1251 byte 0x98 ("И") and collapsed NBSP ("Р") are handled', () => {
  for (const src of ['Именно на покупку', 'Изменение сведений', 'Рад помочь. Хорошего дня!', 'Реквизиты для перевода']) {
    assert.equal(repairMojibake(toMojibake(src)).text, src);
  }
});

test('mojibake: Kazakh letters are restored', () => {
  const src = 'Сәлеметсіз бе, менің атым Аружан. Қажетті валютаны таңдаңыз, рақмет!';
  assert.equal(repairMojibake(toMojibake(src)).text, src);
});

test('clean text is never modified (RU, KZ with "Сіз", EN with Cyrillic UI names)', () => {
  for (const src of ['Сіз тіркелдіңіз бе? Сәлеметсіз бе!', 'Здравствуйте, я Тимур.', 'Open the account area, labelled «Кабинет».', 'D-счёт и торговый счёт']) {
    const r = normalizeText(src, {});
    assert.equal(r.text, src);
    assert.equal(r.changed, false);
  }
});

test('fragment repair: short replies and a damaged word inside Latin text are restored exactly; original kept', () => {
  for (const clean of ['А.', 'И.', 'Я.', 'С 09:00.', 'Open the account area, labelled «Кабинет» in the Russian interface.', 'Тикер: «ФРИДОМ» №5']) {
    const broken = toMojibake(clean);
    assert.notEqual(broken, clean);
    const r = normalizeText(broken, { channelType: 'call' });
    assert.equal(r.text, clean, `${JSON.stringify(broken)} → ${JSON.stringify(r.text)}`);
    assert.equal(r.original, broken);
    assert.ok(r.flags.includes('encoding_repaired'));
  }
});

test('fragment repair never touches clean text (RU/KZ/EN, quotes, №, ё, Ї, short replies)', () => {
  const clean = ['Р.', 'С.', 'В «Кабинете» откройте вкладку.', 'в«Котировках» есть поиск', 'Сіз тіркелдіңіз бе?', 'Өтінімді жібермей тұрып, «Настройки приказа» ашыңыз.',
    'Ёлка, ёж, Їжак, № 15', 'Счёт № 123 — «Инвестор»', 'Hello — “quoted” text…', 'Ұ, Ү, Ғ, Қ, Ң, Ө, Һ, І', 'Р С Т У В в', 'А', 'Ok, СМС-код не нужен.'];
  for (const src of clean) {
    const r = normalizeText(src, {});
    assert.equal(r.text, src, src);
    assert.equal(r.changed, false, src);
  }
});

test('original text is preserved alongside the normalised one', () => {
  const broken = toMojibake('Нашла, спасибо.');
  const r = normalizeText(broken, { channelType: 'chat' });
  assert.equal(r.original, broken);
  assert.equal(r.text, 'Нашла, спасибо.');
  assert.ok(r.flags.includes('encoding_repaired'));
});

test('message quality flags: masked data, DTMF, ASR fragments; no false "mixed script" for AI-ассистент', () => {
  assert.ok(assessMessage('[Персональные данные скрыты]', { channelType: 'call' }).includes('masked_pii'));
  assert.ok(assessMessage('2', { channelType: 'call' }).includes('dtmf'));
  assert.ok(assessMessage('Аршак.', { channelType: 'call' }).includes('asr_fragment'));
  assert.ok(!assessMessage('Алло.', { channelType: 'call' }).includes('asr_fragment'));
  assert.ok(!assessMessage('Я AIM, AI-ассистент Freedom Broker.', { channelType: 'chat' }).includes('mixed_script'));
  assert.ok(assessMessage('Компания fernetbark Здравствуйте', { channelType: 'call', language: 'RU' }).includes('asr_suspicious_token'));
  assert.ok(!assessMessage('Bot dialog language changed', { channelType: 'call', language: 'RU', speaker: 'system' }).includes('asr_suspicious_token'));
});

test('language detection for greetings', () => {
  assert.equal(detectLanguage('Сәлеметсіз бе, мен Дана.'), 'KZ');
  assert.equal(detectLanguage('Здравствуйте, я Тимур'), 'RU');
  assert.equal(detectLanguage("Hi, I'm Maya"), 'EN');
});

test('timestamps: chat MM:SS and call ISO 8601 with 7 fractional digits and offset', () => {
  assert.deepEqual(parseTimestamp('01:15'), { kind: 'clock', seconds: 75 });
  assert.equal(parseTimestamp('1:02:03').seconds, 3723);
  const iso = parseTimestamp('2026-11-03T15:49:13.1900670+00:00');
  assert.equal(iso.kind, 'iso');
  assert.equal(iso.epochMs, Date.UTC(2026, 10, 3, 15, 49, 13) + 190.067);
  const shifted = parseTimestamp('2026-11-03T20:49:13+05:00');
  assert.equal(shifted.epochMs, Date.UTC(2026, 10, 3, 15, 49, 13));
  assert.equal(parseTimestamp('garbage').kind, 'unknown');
});

test('relative offsets keep original order and do not invent time', () => {
  const { offsets, kind } = computeOffsets(['2026-11-03T10:00:00+00:00', '2026-11-03T10:00:05.5+00:00', 'bad', '2026-11-03T10:01:00+00:00']);
  assert.equal(kind, 'iso');
  assert.deepEqual(offsets, [0, 5.5, null, 60]);
  assert.equal(formatClock(75), '01:15');
});

test('audio sync: recording pauses can be excluded and a calibration offset applied (and inverted)', () => {
  const opts = { pauses: [[10, 22]], pauseAware: true, anchor: 0, calibration: 0 };
  assert.equal(transcriptToAudioTime(5, opts), 5);
  assert.equal(transcriptToAudioTime(25, opts), 13);
  assert.equal(transcriptToAudioTime(25, { ...opts, pauseAware: false }), 25);
  assert.equal(transcriptToAudioTime(25, { ...opts, calibration: 2 }), 15);
  assert.equal(audioToTranscriptTime(13, opts), 25);
});
