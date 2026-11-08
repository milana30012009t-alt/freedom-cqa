// Catalogue of deterministic (offline) detectors that can be attached to a criterion.
// A detector lets a criterion be evaluated without an LLM; with an LLM configured the
// criterion text itself is sent to the model (evaluation_mode "auto"/"llm").
//
// IMPORTANT: detectors are transparent heuristics over transcript text and timestamps.
// They never claim semantic understanding; their explanations say what was checked.

export const DETECTORS = Object.freeze({
  contact_greeting: {
    name: 'Приветствие на языке клиента и представление',
    description: 'Ищет приветствие и имя оператора в его первом ответе; проверяет язык приветствия.',
    answer_types: ['binary', 'options', 'scale'],
    params: {},
  },
  need_discovery: {
    name: 'Выявление потребности',
    description: 'Уточняющие вопросы до ответа, переспрашивание уже известного, поправки клиента («я уже писал», «какое приложение?»).',
    answer_types: ['binary', 'options', 'scale'],
    params: {},
  },
  identification: {
    name: 'Идентификация до раскрытия данных',
    description: 'Порядок событий: подтверждение личности → раскрытие данных счёта / защищённое действие.',
    answer_types: ['binary', 'options'],
    params: {},
  },
  consultation_completeness: {
    name: 'Полнота консультации',
    description: 'Каждый вопрос клиента получил ответ по существу или корректный следующий шаг; отписки и повторные вопросы клиента.',
    answer_types: ['scale', 'options', 'binary'],
    params: {},
  },
  empathy: {
    name: 'Вежливость и реакция на недовольство',
    description: 'Грубость/пренебрежение, фамильярность; реакция оператора на выраженное недовольство или неудобство.',
    answer_types: ['binary', 'options', 'scale'],
    params: {},
  },
  dialog_management: {
    name: 'Ведение диалога и скорость',
    description: 'Переспрашивания из-за формулировок, ответы не по порядку, ожидание без предупреждения; порог первой реакции берётся из общих параметров чек-листа.',
    answer_types: ['scale', 'options', 'binary'],
    params: { silent_wait_sec: 180 },
    // checklist-level parameters this detector reads (a change invalidates reviewer decisions on the criterion)
    uses_checklist_parameters: ['first_response_threshold_sec'],
  },
  closing: {
    name: 'Завершение диалога',
    description: 'Итог или предложение помощи + прощание; закрытие чата без прощания; обрыв со стороны клиента (N/A).',
    answer_types: ['binary', 'options', 'scale'],
    params: {},
  },
  gross_errors: {
    name: 'Грубые ошибки',
    description: 'Оскорбление клиента, платная услуга / перевод денег в обход компании, раскрытие конфиденциальной информации.',
    answer_types: ['binary'],
    params: {},
  },
  keyword_presence: {
    name: 'Обязательная фраза оператора',
    description: 'Критерий выполнен, если оператор произнёс хотя бы одну из фраз (по одной на строку; /regex/ поддерживается).',
    answer_types: ['binary', 'options', 'scale'],
    params: { phrases: '', position: 'any' },
  },
  keyword_absence: {
    name: 'Запрещённая фраза оператора',
    description: 'Критерий не выполнен, если оператор использовал хотя бы одну из фраз (по одной на строку; /regex/ поддерживается).',
    answer_types: ['binary', 'options', 'scale'],
    params: { phrases: '' },
  },
  response_time: {
    name: 'Скорость реакции',
    description: 'Первая реакция после передачи оператору и паузы между вопросом клиента и ответом (только чаты).',
    answer_types: ['binary', 'options', 'scale'],
    params: { first_response_sec: 180, reply_gap_sec: 180 },
  },
});

export function detectorInfo(type) {
  return type ? DETECTORS[type] || null : null;
}

export function listDetectors() {
  return Object.entries(DETECTORS).map(([type, d]) => ({ type, ...d }));
}
