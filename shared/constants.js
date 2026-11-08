// Shared enums and human-readable labels (used by both the server and the browser).

export const SPEAKERS = Object.freeze(['client', 'operator', 'bot', 'system']);

export const SPEAKER_LABELS = Object.freeze({
  client: 'Клиент',
  operator: 'Оператор',
  bot: 'Бот',
  system: 'Система',
  unknown: 'Неизвестно',
});

export const CHANNEL_TYPES = Object.freeze({
  'agent chat': 'chat',
  'voice call': 'call',
});

export const CHANNEL_LABELS = Object.freeze({
  chat: 'Чат',
  call: 'Звонок',
  unknown: 'Другое',
});

export const LANGUAGES = Object.freeze(['RU', 'KZ', 'EN']);

export const LANGUAGE_LABELS = Object.freeze({
  RU: 'Русский',
  KZ: 'Қазақша',
  EN: 'English',
});

// Status of one criterion inside an evaluation.
export const RESULT_STATUS = Object.freeze({
  SCORED: 'scored',
  NA: 'na',
  NOT_EVALUATED: 'not_evaluated',
});

export const RESULT_STATUS_LABELS = Object.freeze({
  scored: 'Оценён',
  na: 'N/A',
  not_evaluated: 'Не оценён',
});

// "Situation" from the specification: A = met, B = partial, C = not met.
export const SITUATIONS = Object.freeze({
  met: 'Выполнено',
  partial: 'Частично',
  not_met: 'Не выполнено',
  na: 'Неприменимо',
  unclear: 'Неясно',
});

export const APPEAL_STATUSES = Object.freeze({
  new: 'Новая',
  pending: 'Ожидает рассмотрения',
  confirmed: 'Подтверждена',
  changed: 'Изменена',
  closed: 'Закрыта',
});

export const APPEAL_OPEN_STATUSES = Object.freeze(['new', 'pending']);

export const ROLES = Object.freeze({
  specialist: 'Специалист КК',
  reviewer: 'Проверяющий',
});

export const SEVERITY_LABELS = Object.freeze({
  critical: 'Критично',
  high: 'Высокий риск',
  medium: 'Средний риск',
  low: 'Низкий риск',
});

export const REVIEW_PRIORITY_LABELS = Object.freeze({
  critical: 'Критический',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
});

export const ENGINE_LABELS = Object.freeze({
  rules: 'Офлайн-движок правил',
  anthropic: 'Claude (Anthropic API)',
  openai: 'OpenAI-совместимая модель',
  mock: 'Тестовый провайдер',
});
