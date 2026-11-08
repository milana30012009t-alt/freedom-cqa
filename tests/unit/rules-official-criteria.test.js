// Regression tests for the general rules of criteria 07, 02, 03 and 06, written against the wording of the
// official checklist PDF. Synthetic dialogs only (no DEV ids): the logic must not depend on specific examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConversation } from '../../server/data/transcript-model.js';
import { validateChecklist } from '../../shared/checklist-schema.js';
import { evaluateWithRules } from '../../server/evaluation/rules/rules-engine.js';
import { OFFICIAL_CHECKLIST, readJson } from '../helpers.js';

const checklist = validateChecklist(readJson(OFFICIAL_CHECKLIST)).checklist;
const PRE = {
  RU: [['client', 'Где скачать отчёт брокера?'], ['bot', 'Отчёт есть в приложении.'], ['client', 'Подключите оператора, пожалуйста.'], ['system', 'Эскалация на оператора.']],
  KZ: [['client', 'Брокер есебін қайдан жүктеймін?'], ['bot', 'Есеп қосымшада бар.'], ['client', 'Операторға қосыңызшы.'], ['system', 'Чат операторға жіберілді.']],
  EN: [['client', 'Where can I download my broker report?'], ['bot', 'The report is in the app.'], ['client', 'Please connect me to an agent.'], ['system', 'Chat transferred to an agent.']],
};
let seq = 0;
function run(lang, live, pre = PRE[lang]) {
  const lines = [...pre, ...live];
  const transcript = lines.map(([speaker, text], i) => ({ timestamp: `${String(Math.floor((i * 20) / 60)).padStart(2, '0')}:${String((i * 20) % 60).padStart(2, '0')}`, speaker, text }));
  seq += 1;
  const conv = buildConversation({ conversation_id: `syn-${seq}`, channel: 'agent chat', language: lang, transcript, audio_url: null }, 'SYN');
  return Object.fromEntries(evaluateWithRules(conv, checklist).results.map((r) => [r.criterion_id, r]));
}
const ans = (r) => (r.status === 'na' ? 'na' : r.answer);

const OPEN = {
  RU: ['operator', 'Здравствуйте, меня зовут Анна. Откройте «Меню → Отчёты и документы → Отчёт брокера».'],
  KZ: ['operator', 'Сәлеметсіз бе, менің атым Дана. «Отчёты и документы» бөлімін ашып, «Отчёт брокера» тармағын таңдаңыз.'],
  EN: ['operator', "Hi, I'm Anna. Open Reports and Documents, then Broker Report."],
};
const THANKS = { RU: ['client', 'Нашёл, спасибо.'], KZ: ['client', 'Таптым, рақмет.'], EN: ['client', 'Found it, thanks.'] };

test('07 (PDF): a courtesy formula + farewell after the client\'s thanks is NOT a summary or an offer → «Нет» (RU/KZ/EN)', () => {
  for (const [lang, bye] of [['RU', 'Пожалуйста. Хорошего дня!'], ['RU', 'Рада помочь. До свидания!'], ['RU', 'Отлично. Спасибо за обращение, до свидания!'],
    ['KZ', 'Оқасы жоқ. Сау болыңыз!'], ['EN', "You're welcome. Bye!"], ['EN', 'Great. Thanks for reaching out, and goodbye!'], ['EN', 'Glad you got in. Have a good day!']]) {
    const r = run(lang, [OPEN[lang], THANKS[lang], ['operator', bye]]).closing;
    assert.equal(ans(r), 'no', `${lang}: «${bye}»`);
  }
});

test('07 (PDF): summary or offer of further help + farewell → «Да» (RU/KZ/EN)', () => {
  for (const [lang, bye] of [['RU', 'Отчёт за нужный период теперь у вас. Если появятся вопросы — пишите. До свидания!'],
    ['RU', 'Вопрос передан специалистам, ответ придёт в этот чат. До свидания!'],
    ['KZ', 'Есепті жүктеп алдыңыз. Тағы сұрақ болса, жазыңыз. Сау болыңыз!'],
    ['EN', 'You now have the report for the period you need. Anything else I can help with? Goodbye!']]) {
    const r = run(lang, [OPEN[lang], THANKS[lang], ['operator', bye]]).closing;
    assert.equal(ans(r), 'yes', `${lang}: «${bye}»`);
  }
});

test('07 (PDF): an instruction given before the client\'s thanks is an answer, not a closing summary', () => {
  const r = run('RU', [OPEN.RU, ['client', 'А период какой выбрать?'], ['operator', 'Выберите нужные даты и проверьте период перед скачиванием.'], THANKS.RU, ['operator', 'Пожалуйста. До свидания!']]).closing;
  assert.equal(ans(r), 'no');
});

test('07 (PDF): closed without farewell → «Нет»; client left before closing → N/A', () => {
  assert.equal(ans(run('RU', [OPEN.RU, THANKS.RU, ['system', 'Оператор закрыл чат.']]).closing), 'no');
  assert.equal(ans(run('RU', [OPEN.RU, ['system', 'Клиент покинул чат.']]).closing), 'na');
});

test('02 (PDF): an identity check is a procedural step, a clarifying question after it is still "before the answer" → «Да»', () => {
  const pre = [['client', 'Пополнил счёт, деньги не пришли.'], ['bot', 'Уточните, перевод уже отправлен?'], ['client', 'Да, подключите оператора.'], ['system', 'Эскалация на оператора.']];
  const withQuestion = run('RU', [['operator', 'Здравствуйте, меня зовут Олег. Сначала нужно подтвердить личность, чтобы проверить счёт.'], ['client', 'Готов.'],
    ['system', 'Личность клиента подтверждена.'], ['operator', 'Спасибо. В какой валюте был перевод?'], ['client', 'В тенге.'],
    ['operator', 'Передал вопрос специалистам, ответ придёт в этот чат. До свидания!']], pre);
  assert.equal(ans(withQuestion.need_discovery), 'yes');
  // the same request phrased as an instruction, without a question mark
  const imperative = run('RU', [['operator', 'Здравствуйте, меня зовут Олег. Сначала нужно подтвердить личность, чтобы проверить счёт.'], ['client', 'Готов.'],
    ['system', 'Личность клиента подтверждена.'], ['operator', 'Спасибо. Я передал вопрос специалистам. Укажите, пожалуйста, в какой валюте был перевод.'], ['client', 'В тенге.'],
    ['operator', 'Добавил. Ответ придёт в этот чат. До свидания!']], pre);
  assert.equal(ans(imperative.need_discovery), 'yes');
});

test('02 (PDF): data sufficient from the start, operator answers directly → N/A', () => {
  assert.equal(ans(run('EN', [OPEN.EN, THANKS.EN, ['operator', 'You now have the report. Goodbye!']]).need_discovery), 'na');
});

test('03 (PDF): identity check requested but never confirmed, nothing disclosed → N/A (not «Да»)', () => {
  const r = run('RU', [['operator', 'Здравствуйте, я Тимур. Если нужно проверить именно ваш счёт, понадобится идентификация.'],
    ['client', 'Давайте без неё, я сам сверю даты.'], ['operator', 'Хорошо. Если вопрос останется, напишите нам. До свидания!']]);
  assert.equal(ans(r.identification), 'na');
});

test('03 (PDF): confirmed before account data → «Да»; account data before confirmation → «Нет»', () => {
  const ok = run('EN', [['operator', "Hello, I'm Sam. We'll need to verify your identity before we look at the account."], ['client', 'Okay.'],
    ['system', 'Customer identity verified.'], ['operator', 'I can see a pending withdrawal on your account. I sent the case for review. Goodbye!']]);
  assert.equal(ans(ok.identification), 'yes');
  const bad = run('EN', [['operator', "Hi, I'm Tyler. I can see a withdrawal restriction on your account."], ['client', "How do you know it's my account?"], ['operator', 'Goodbye.']]);
  assert.equal(ans(bad.identification), 'no');
});

test('06 (PDF scale 4): the client has to ask the same question again — even if the dialog ends with thanks', () => {
  const r = run('RU', [['operator', 'Здравствуйте, я Ирина. Вы можете написать трейдерам на почту или позвонить.'],
    ['client', 'А писать на почту нужно при каждой покупке?'], ['operator', 'Можете писать или звонить, как вам удобнее.'],
    ['client', 'Так писать на почту при каждой покупке нужно?'], ['operator', 'Да, при каждой покупке. Если появятся вопросы — пишите. До свидания!'],
    ['client', 'Понятно, спасибо.']]).dialog_management;
  assert.equal(r.answer, 4);
  assert.match(r.explanation, /повторил вопрос/);
});

test('06: a new, different follow-up question is not a re-ask; "не понимаю" after an operator reply is', () => {
  const fine = run('RU', [OPEN.RU, ['client', 'А как выбрать период?'], ['operator', 'Укажите даты начала и конца в фильтре.'],
    ['client', 'А отчёт по налогам где скачать?'], ['operator', 'Там же, в разделе «Налоговые документы». Если появятся вопросы — пишите. До свидания!']]).dialog_management;
  assert.equal(fine.answer, 10);
  const confused = run('RU', [['operator', 'Здравствуйте, я Алексей. Бот всё написал.'], ['client', 'Не понимаю, куда мне нажать.'],
    ['operator', 'Откройте «Меню → Отчёты и документы». До свидания!']]).dialog_management;
  assert.equal(confused.answer, 4);
});

test('07 (PDF): a long polite wish without the case content is not a summary → «Нет»; a summary about the case → «Да»', () => {
  for (const [lang, bye] of [['RU', 'Благодарю за обращение, желаю вам хорошего дня и отличного настроения!'],
    ['RU', 'Спасибо большое за ваше обращение и терпение, всего вам самого доброго!'],
    ['EN', 'Thank you so much for your patience today, wishing you a wonderful evening!'],
    ['KZ', 'Хабарласқаныңызға көп рақмет, күніңіз сәтті өтсін!'], ['RU', 'Хорошо, понял вас. Всего доброго!']]) {
    assert.equal(ans(run(lang, [OPEN[lang], THANKS[lang], ['operator', bye]]).closing), 'no', `${lang}: «${bye}»`);
  }
  for (const [lang, bye] of [['RU', 'Итак, отчёт за нужный период у вас. Всего доброго!'], ['RU', 'Если будут вопросы, обращайтесь. До свидания!'],
    ['EN', 'Is there anything else I can help you with? Have a nice day!'], ['KZ', 'Басқа сұрақтарыңыз болса, жазыңыз. Сау болыңыз!']]) {
    assert.equal(ans(run(lang, [OPEN[lang], THANKS[lang], ['operator', bye]]).closing), 'yes', `${lang}: «${bye}»`);
  }
});

test('06: a follow-up that adds new content is a new question, not a re-ask', () => {
  for (const [q1, q2] of [['Как пополнить счёт в долларах?', 'А пополнить счёт в евро тоже можно?'],
    ['Можно вывести деньги на карту?', 'А вывести деньги на счёт в другом банке можно?']]) {
    const r = run('RU', [OPEN.RU, ['client', q1], ['operator', 'Да, выберите валюту в разделе пополнения.'], ['client', q2],
      ['operator', 'Да, тоже можно. Если появятся вопросы — пишите. До свидания!']]).dialog_management;
    assert.equal(r.answer, 10, `${q1} / ${q2}`);
  }
});

test('02: an offer to write back ("Напишите нам, когда будете готовы") is not a clarifying question', () => {
  for (const op of ['Здравствуйте, меня зовут Анна. Откройте «Меню → Отчёты». Напишите нам, когда будете готовы.',
    'Здравствуйте, меня зовут Анна. Откройте «Меню → Отчёты». Если появятся вопросы, напишите, как вам удобнее.']) {
    assert.equal(ans(run('RU', [['operator', op], ['client', 'Понятно.'], ['operator', 'Отчёт за период у вас. Если появятся вопросы — пишите. До свидания!']]).need_discovery), 'na');
  }
});
