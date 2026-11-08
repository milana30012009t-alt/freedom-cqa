# Результаты тестирования

Запуск: 7 ноября 2026, среда сборки Linux x86_64, Node.js 22.23.4, Chrome (headless) через Playwright. На MacBook Apple Silicon проект в этой среде не запускался; платформенно-зависимых модулей и нативных зависимостей в нём нет (только встроенные модули Node.js).

## Итог

| Набор | Команда | Результат |
|---|---|---|
| Модульные + интеграционные | `npm test` | **68 из 68 пройдено**, 0 ошибок, 0 пропущено, ≈ 2,3 с |
| Без DEV-файла | `npm test` (нет `data/datasets/DEV.raw.json`) | 58 пройдено, 10 пропущено с пояснением «DEV-набор не найден» |
| Браузерный сценарий демонстрации | `npm run test:e2e` | **11 из 11 шагов**, ошибок в консоли браузера нет |
| Полный прогон DEV | `npm run evaluate -- --engine rules` | 65 из 65 диалогов оценены без ошибок; 8 диалогов с грубыми ошибками, 3 — с сигналами риска; средний балл 85,85 |
| Сценарий для жюри на DEV | скрипт по шагам `docs/DEMO_SCRIPT.md` | все шаги выполнены, ошибок в консоли нет: p1-ru-022 — итог 31,25, клик по доказательству подсвечивает реплику m9; апелляция p1-en-007 — 54,62 → 77,69; порог 180 → 60 с — p1-ru-006 100 → 94,71 (06: 10 → 7); «Переоценить устаревшие» — итог изменился у 33 из 65 диалогов, решение по апелляции p1-en-007 перенесено (порог не влияет на критерий 05) |

## Покрытие обязательных проверок (раздел требований «Тестирование»)

| № | Что требуется проверить | Тесты |
|---|---|---|
| 1 | Загрузку 65 записей | `DEV dataset: 65 records…`; `dataset API: GET by group_id with retry…` (интеграционный, через HTTP) |
| 2 | Распределение языков и каналов | `DEV dataset: … 35 RU / 15 KZ / 15 EN, 60 chats / 5 calls…` |
| 3 | Обработку разных ролей | `roles, segments and events: bot/system are context, hold is internal…`; `duplicates are dropped… unknown roles reported` |
| 4 | Оценку русского диалога | `RU good chat…`; DEV `p1-ru-022`, `p1-ru-029`, `p1-ru-009`, `p1-ru-025`… |
| 5 | Оценку казахского диалога | `KZ chat: greeting recognised in Kazakh`; DEV `p1-kz-013`, `p1-kz-015` |
| 6 | Оценку английского диалога | `EN chat: insult and paid private advice…`; DEV `p1-en-013`, `p1-en-014` |
| 7 | Расчёт весовых коэффициентов | `weighted scoring: Да = full weight, Нет = 0, scale proportional`; `official checklist (PDF) validates…` |
| 8 | Перераспределение веса при N/A | `N/A: weights are redistributed proportionally…`; `N/A within-section… count as full` |
| 9 | Правила округления | `rounding: two decimals half-up by default…` |
| 10 | Фиксацию критической ошибки | `gross error flag is marked separately and does not change the total (flag_only)…`; `rule-detected gross errors are never silently dropped when the AI disagrees`; `critical finding review…` |
| 11 | Ссылки на доказательства | `every enabled criterion gets a result; evidence ids always point to real messages`; `AI output: … quotes verified`; e2e «клик по доказательству подсвечивает реплику» |
| 12 | Переход к временной метке | `AI output: … timestamps are taken from the transcript`; `timestamps: chat MM:SS and call ISO 8601…`; `audio sync: recording pauses… calibration…`; e2e (подсветка реплики) |
| 13 | Сохранение апелляции | `appeal lifecycle: create → take → change → close…`; интеграционный `… appeal with roles…`; e2e |
| 14 | Решение проверяющего | `appeal confirm keeps the score; invalid change values are rejected`; интеграционный (403 для специалиста); e2e |
| 15 | Перерасчёт итогового балла | `reviewer override recalculates the total; diff shows the change`; `appeal lifecycle…`; e2e «итог диалога пересчитан, исходная оценка сохранена» |
| 16 | Изменение критерия | `checklist change: new version is applied on re-evaluation…`; `checklist parameter change (first-reaction threshold) changes criterion 06…`; e2e (изменение в интерфейсе) |
| 17 | Применение новой версии чек-листа | `checklist versions: … immutable snapshot, activation, diff…`; интеграционные `checklist edit through the API → … outdated dialogs re-evaluated` и `control set: switch group_id…`; e2e «переоценка по v2…» |
| 18 | Пустой или повреждённый JSON | `empty, broken or unsuccessful payloads are rejected with clear errors`; интеграционный `dataset API errors and corrupted uploads…` |
| 19 | Невалидный ответ AI | `AI output: invalid answer, forbidden N/A, unknown evidence…`; `AI output: tolerant JSON parsing, garbage rejected`; `invalid AI response: one repair retry, then fallback…` |
| 20 | Недоступную аудиоссылку | `audio proxy: unavailable link (403) and missing audio produce clear errors…`; e2e «звонок: недоступная запись…» |

Дополнительно: восстановление кодировки (RU/KZ, байт 0x98, неразрывный пробел), отсутствие изменений чистого текста, флаги качества текста, формат запросов к Claude (структурированный вывод, кэширование, без `temperature`), повтор без неподдерживаемых параметров, ошибки авторизации, заголовки безопасности и защита от выхода за пределы папки, отсутствие подписанных ссылок в ответах API, контрольный набор (смена `group_id` → загрузка → оценка по текущему чек-листу).

## Что проверено только на имитации

Эти части протестированы на локальных серверах, повторяющих формат реальных сервисов, — в среде сборки к ним не было доступа:

- **API организаторов** — исходящее соединение из среды сборки блокировалось сетевой политикой (403 на прокси). Проверены: параметр `group_id`, повтор после 503, ответ `isSuccess:false`, повреждённый JSON. Реальный DEV-набор загружен из приложенного файла (ответ того же API).
- **Записи звонков** — скачивание по подписанной ссылке, кэш, `Range`, обёртка `$content`, ошибки 403/404 проверены на имитации; реальное воспроизведение не проверялось.
- **Claude API** — ключа в среде сборки не было. Формат запроса и разбор ответа проверены на имитации Messages API; качество AI-оценки на реальной модели не измерялось. Все оценки в этом документе выполнены офлайн-движком правил.

## Полный вывод `npm test`

```
✔ static UI is served with security headers; path traversal is blocked
✔ dataset API: GET by group_id with retry after a transient 503; signed URL never returned
✔ dataset API errors and corrupted uploads are reported, existing data untouched
✔ conversation list filters; card has no audio URL; evaluation via API
✔ batch evaluation job, appeal with roles, reviewer decision recalculates the total
✔ checklist edit through the API → new active version → outdated dialogs re-evaluated with it
✔ control set: switch group_id, load new dialogs, evaluate them with the current checklist
✔ analytics and cost estimate are computed from data
✔ AI output: valid answer passes; timestamps are taken from the transcript, quotes verified
✔ AI output: invalid answer, forbidden N/A, unknown evidence and missing criteria never become scores
✔ AI output: tolerant JSON parsing, garbage rejected
✔ prompt: transcript is data (ids, speakers), checklist block is stable across conversations
✔ Anthropic provider: wire format (structured output, caching, no sampling params / forced tools) and usage
✔ Anthropic provider: retries without "effort" / structured output when the API rejects them; auth errors are explicit
✔ evaluation with AI: stored with checklist snapshot, enriched evidence and usage; deterministic score
✔ invalid AI response: one repair retry, then fallback to offline rules (marked) or a clear error
✔ rule-detected gross errors are never silently dropped when the AI disagrees
✔ checklist change: new version is applied on re-evaluation, old evaluation keeps its snapshot, overrides carry over only for unchanged criteria
✔ checklist parameter change (first-reaction threshold) changes criterion 06; only decisions that depend on it are dropped
✔ criterion without detector and without AI is "not evaluated" (no invented score)
✔ appeal lifecycle: create → take → change → close; total recalculated, original kept, history complete
✔ appeal confirm keeps the score; invalid change values are rejected
✔ critical finding review and evaluation verification are recorded
✔ checklist versions: official seed v1, new version immutable snapshot, activation, diff, validation errors
✔ audio proxy: downloads once, serves with Range; signed URL never exposed; JSON $content envelope supported
✔ audio proxy: unavailable link (403) and missing audio produce clear errors; transcript stays usable
✔ API payload: records extracted, structure validated
✔ empty, broken or unsuccessful payloads are rejected with clear errors
✔ duplicates are dropped, transcript given as a string is parsed, unknown roles reported
✔ roles, segments and events: bot/system are context, hold is internal, end detected
✔ encoding damage in a record is repaired for display, original kept
✔ DEV dataset: 65 records, 35 RU / 15 KZ / 15 EN, 60 chats / 5 calls, all roles, all encoding repaired
✔ every enabled criterion gets a result; evidence ids always point to real messages
✔ RU good chat: greeting, consultation and closing are met; no gross errors
✔ KZ chat: greeting recognised in Kazakh
✔ EN chat: insult and paid private advice → gross error with both subtypes, empathy "no"
✔ disclosure before identification → identification "no" + confidential disclosure
✔ call: OTP request is a risk signal for review (not a gross error); ID confirmed before disclosure; hold talk ignored
✔ DEV p1-ru-022: personal card + profit promise → gross error (bypass) and risk signal
✔ DEV p1-ru-023, p1-en-013, p1-kz-013: paid private consultation + personal number → bypass flagged
✔ DEV p4-ru-003, p4-ru-004: six-digit SMS code requests → risk signal for manual review
✔ DEV p1-ru-029: rude operator → insult flagged with the exact message
✔ DEV p1-ru-009 / p1-kz-015 / p1-en-014: account data disclosed without identification
✔ DEV negative controls: refusing investment advice (p4-ru-001) and asking for ID (p1-ru-002) are not violations
✔ DEV N/A cases: chat ended before a request (p1-ru-025), connection lost before closing (p1-ru-012)
✔ DEV missed actions show the checked range or evidence (p1-ru-003 unanswered commission question)
✔ DEV all 65 dialogs evaluate without errors; evidence ids valid; RU/KZ/EN covered
✔ official checklist (PDF) validates: 8 criteria, weights 10/15/20/20/15/15/5 + flag, scales 0–20 and 0–10
✔ weighted scoring: Да = full weight, Нет = 0, scale proportional (top step = full weight)
✔ N/A: weights are redistributed proportionally among applicable criteria (max stays 100)
✔ N/A within-section policy and "count as full" policy (configurable, non-official)
✔ rounding: two decimals half-up by default; other modes available
✔ no applicable weighted criteria → total is not computed
✔ gross error flag is marked separately and does not change the total (flag_only); zero/cap policies work
✔ invalid answers and forbidden N/A never become silent zeros
✔ reviewer override recalculates the total; diff shows the change
✔ answer normalisation for RU/EN/boolean inputs and scale steps
✔ checklist validation reports structural errors
✔ mojibake: Russian text damaged as UTF-8→CP1251 is restored exactly
✔ mojibake: undefined CP1251 byte 0x98 ("И") and collapsed NBSP ("Р") are handled
✔ mojibake: Kazakh letters are restored
✔ clean text is never modified (RU, KZ with "Сіз", EN with Cyrillic UI names)
✔ original text is preserved alongside the normalised one
✔ message quality flags: masked data, DTMF, ASR fragments; no false "mixed script" for AI-ассистент
✔ language detection for greetings
✔ timestamps: chat MM:SS and call ISO 8601 with 7 fractional digits and offset
✔ relative offsets keep original order and do not invent time
✔ audio sync: recording pauses can be excluded and a calibration offset applied (and inverted)
ℹ tests 68
ℹ pass 68
ℹ fail 0
```

## Вывод `npm run test:e2e`

```
✔ дашборд открывается и показывает набор TEST
✔ список диалогов: 5 строк, поиск по ID фильтрует
✔ карточка: клик по доказательству подсвечивает реплику
✔ специалист подаёт апелляцию по критерию 05
✔ проверяющий: взять в работу → изменить оценку с живым пересчётом
✔ итог диалога пересчитан, исходная оценка сохранена
✔ чек-лист: изменить порог первой реакции в интерфейсе (180 → 30 с) → новая активная версия v2
✔ переоценка по v2 из карточки: критерий 06 и итог изменились, панель «что изменилось»
✔ звонок: недоступная запись → понятное сообщение, транскрипт доступен
✔ аналитика, данные и режим встраивания (Dynamics 365) открываются
✔ в консоли браузера нет ошибок
ℹ steps 11  ℹ pass 11  ℹ fail 0
```
