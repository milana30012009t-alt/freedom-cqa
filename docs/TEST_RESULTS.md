# Результаты тестирования

Последний запуск: 7 ноября 2026, этап «подписка Claude через Claude Code» (правила `rules-2026.11.3`, промпт `cqa-prompt-v2`, чек-лист с дословными формулировками PDF). Среда сборки Linux x86_64, Node.js 22.23.4, Chrome (headless) через Playwright. На MacBook Apple Silicon в этой среде не запускалось; нативных зависимостей в проекте нет.

## Итог

| Набор | Команда | Результат |
|---|---|---|
| Модульные + интеграционные | `npm test` | **113 из 113 пройдено**, 0 ошибок, 0 пропущено (из них 20 — Results JSON 1.0, 9 — провайдер Claude Code CLI) |
| Без DEV-файла | `npm test` на чистой копии (нет `data/`) | 102 пройдено, 11 пропущено с пояснением, 0 ошибок |
| Браузерный сценарий | `npm run test:e2e` | **12 из 12 шагов**, ошибок в консоли браузера нет; новый шаг проверяет, что на страницах и в раскрытых карточках нет текстов «null/undefined/NaN» |
| Полный прогон DEV после исправлений | `node audit/07-reevaluate.mjs --from-first` | 65 из 65 оценены; итог изменился у 30, ответов по критериям — 34 (07: 28, 02: 3, 06: 2, 03: 1); средний балл 85,85 → 82,94; 100 баллов: 36 → 13; грубых ошибок 8 → 8. Исходные 65 оценок сохранены без изменений (история) — `audit/07-reevaluate.out.md` |
| Results JSON: предварительный прогон DEV без модели | `npm run export:dev -- --engine rules` | 65 записей (ok 64, error 1 — `p4-ru-005`: критерий 01 не оценён автоматически, записан как ошибка, а не 0), 512 критериев, 760 номеров реплик, 446 цитат найдены в транскрипте; проверка пройдена с 2 ожидаемыми предупреждениями (заглушка team_name, модель NO-LLM). Файл в `results/preview/`, к сдаче не допускается |
| Results JSON: сторонняя проверка схемы | `python3 scripts/check-schema.py results/preview/dev.rules-preview.json` (jsonschema 4.26, draft 2020-12) | OK, 65 из 65 записей |
| Results JSON: экспорт моделью | `npm run export:dev -- --team "Проверка"` | **Не выполнен**: модель в среде сборки не подключена (нет ключа, локальной модели нет). Команда остановилась с кодом 2, файл не записан; без названия команды — раньше, с кодом 1 |
| Независимый пересчёт итогов | `node audit/05e-scoring-recompute.mjs` | 195 из 195 сохранённых оценок (исходные, промежуточные и новые) совпали с пересчётом по тексту PDF |
| Кодировка | `node audit/02-encoding.mjs <DEV-файл>` | 1037 из 1037 повреждённых сообщений восстановлены, обратная проверка стандартным декодером windows-1251 — 1037/1037, неоднозначных 0; оригиналы сохранены |
| Контрольное задание через интерфейс | `node audit/08-control-task.mjs` | Замена критерия → новая версия → переоценка → загрузка нового (искусственного) набора через интерфейс → оценка по новой версии. **Без AI новый критерий получает «Не оценён»** (балл не выдумывается, итог помечен предварительным); с правилом ключевых фраз оценивается правилом, не AI |

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
| 14 | Решение проверяющего | `appeal confirm keeps the score; invalid change values are rejected`; интеграционный (403 для роли «оператор»); e2e |
| 15 | Перерасчёт итогового балла | `reviewer override recalculates the total; diff shows the change`; `appeal lifecycle…`; e2e «итог диалога пересчитан, исходная оценка сохранена» |
| 16 | Изменение критерия | `checklist change: new version is applied on re-evaluation…`; `checklist parameter change (first-reaction threshold) changes criterion 06…`; e2e (изменение в интерфейсе) |
| 17 | Применение новой версии чек-листа | `checklist versions: … immutable snapshot, activation, diff…`; интеграционные `checklist edit through the API → … outdated dialogs re-evaluated` и `control set: switch group_id…`; e2e «переоценка по v2…» |
| 18 | Пустой или повреждённый JSON | `empty, broken or unsuccessful payloads are rejected with clear errors`; интеграционный `dataset API errors and corrupted uploads…` |
| 19 | Невалидный ответ AI | `AI output: invalid answer, forbidden N/A, unknown evidence…`; `AI output: tolerant JSON parsing, garbage rejected`; `invalid AI response: one repair retry, then fallback…` |
| 20 | Недоступную аудиоссылку | `audio proxy: unavailable link (403) and missing audio produce clear errors…`; e2e «звонок: недоступная запись…» |

Дополнительно: восстановление кодировки (RU/KZ, байт 0x98, неразрывный пробел), отсутствие изменений чистого текста, флаги качества текста, формат запросов к Claude (структурированный вывод, кэширование, без `temperature`), повтор без неподдерживаемых параметров, ошибки авторизации, заголовки безопасности и защита от выхода за пределы папки, отсутствие подписанных ссылок в ответах API, контрольный набор (смена `group_id` → загрузка → оценка по текущему чек-листу).

Регрессионные тесты правил 02, 03, 06 и 07 по формулировкам PDF — `tests/unit/rules-official-criteria.test.js` (13 тестов): только синтетические диалоги на RU/KZ/EN, без ID из DEV-набора, включая отрицательные случаи (длинное вежливое прощание без итога, новый уточняющий вопрос клиента, предложение «напишите нам» не является уточнением). Восстановление коротких и смешанных фрагментов кодировки — `tests/unit/text-and-time.test.js`; контрольная замена критерия на новых диалогах — `tests/integration/api.test.js`.

## Провайдер Claude Code CLI — подписка Claude (`tests/unit/claude-code-cli.test.js`, 9 тестов)

Тесты работают с **имитацией** команды `claude` (`tests/fixtures/fake-claude.mjs`): она повторяет документированный формат CLI, но не является моделью и подписку не расходует.

| Что проверяется | Результат |
|---|---|
| Ключ API и `ANTHROPIC_BASE_URL`, заданные в терминале, до CLI не доходят; CLI запускается вне папки проекта; инструменты отключены, сессия не сохраняется, `--bare` не используется | пройдено |
| Нет входа / вход не через подписку (`authMethod ≠ claude.ai`) → отказ до вызова модели | пройдено |
| CLI сообщил `apiKeySource ≠ none` → вызов остановлен | пройдено |
| Лимит подписки (429, «5-hour limit reached ∙ resets …») и ошибка входа → остановка с понятным сообщением | пройдено |
| Нет `claude` / старая версия без нужных флагов → подсказка установки / `claude update` | пройдено |
| Ответ JSON в тексте принимается; нечитаемый ответ → один повтор с подсказкой | пройдено |
| Модель берётся из `modelUsage` (вспомогательные модели не считаются); `mode = external_api`; `cost_usd = 0` | пройдено |
| Экспорт без пробного прогона RU/KZ/EN → код 7; лимит посреди прогона → код 6 без записи файла; повторный запуск отправляет только оставшиеся диалоги | пройдено |

Дополнительно на **настоящем** Claude Code 2.1.319 без входа (изолированный домашний каталог, без учётных данных): все нужные флаги распознаны; полный набор аргументов принят (ошибка только «Authentication error»); событие `init` показывает `apiKeySource: none` без ключа и `ANTHROPIC_API_KEY` с ключом; JSON-схема ответа принята; сессия не сохранена; провайдер останавливается на проверке входа и модель не вызывает. Прогон на имитации всех 65 DEV (1 → 3 → 65, лимит после 20 вызовов, продолжение) — 65 из 65, проверка пройдена.

## Results JSON 1.0 (`tests/unit/results-json.test.js`, 20 тестов)

| Что проверяется | Как |
|---|---|
| Точная структура файла и записей, порядок полей, `model` из фактически ответившей модели | экспорт 5 диалогов фикстуры со сценарной моделью (читает промпт и отвечает реальными id и дословными цитатами), режим `local` по адресу `127.0.0.1` |
| `evidence_turns` с единицы по всем сообщениям | `t-ru-001`: клиент, бот, клиент, система, оператор → номер 5; на DEV — `m<i>` = `transcript[i]` для всех 65 диалогов |
| Выдуманная моделью цитата не выдаётся за цитату | фрагмент помечается «пересказ модели», файл остаётся корректным |
| Без модели файл не пишется | код 2, файла нет; без названия команды — отказ; модель не оценила ни одного диалога (например, неверный ключ) — код 5, прежний файл не тронут |
| Число записей | DEV не 65 → код 3; PROD 9 вместо 10 → код 3; PROD без `group_id` → отказ |
| PROD через API | `group_id` в запросе, ровно 10, сбой модели на одном диалоге → запись `error` (не 0 и не N/A), 9 ok / 1 error, в манифесте нет секретов из адреса API |
| Офлайн-правила | пишутся в `results/preview/`, строгая проверка отклоняет имя NO-LLM и заглушку команды |
| Валидатор на испорченных файлах | 47 вариантов (поля, типы, значения, дубликаты, ID, номера реплик, выдуманная цитата, балл ±1, три знака, `critical_flag`, форма записи `error`, «ошибка = 0 баллов») + BOM, битый UTF-8, обрезанный JSON — каждый отклонён с конкретным сообщением |
| Независимый пересчёт балла | целочисленный пересчёт валидатора = движок на 5000 случайных комбинациях; `critical` не обнуляет балл |
| JSON Schema | перечни значений совпадают с таблицей формата; сторонний jsonschema принимает корректный файл и отклоняет 32 структурные поломки |
| Извлечение цитат | вложенные «…», обрезанная внутренняя цитата не «съедает» следующие, короткие названия кнопок не считаются цитатами |

## Что проверено только на имитации

Эти части протестированы на локальных серверах, повторяющих формат реальных сервисов, — в среде сборки к ним не было доступа:

- **API организаторов** — исходящее соединение из среды сборки блокировалось сетевой политикой (403 на прокси). Проверены: параметр `group_id`, повтор после 503, ответ `isSuccess:false`, повреждённый JSON. Реальный DEV-набор загружен из приложенного файла (ответ того же API).
- **Записи звонков** — скачивание по подписанной ссылке, кэш, `Range`, обёртка `$content`, ошибки 403/404 проверены на имитации; реальное воспроизведение не проверялось.
- **Claude API** — ключа в среде сборки не было. Формат запроса и разбор ответа проверены на имитации Messages API; качество AI-оценки на реальной модели не измерялось. Все оценки в этом документе выполнены офлайн-движком правил.
- **Подписка Claude через Claude Code** — вход через подписку, реальные ответы модели, время на диалог и расход лимитов Pro в этой среде **не проверялись** (подписки здесь нет). Первая реальная проверка — `npm run check:model` на MacBook.
- **Экспорт Results JSON моделью** — проверен только со сценарной моделью в тестах. Реальная модель (Claude или локальная) не подключалась; `results/dev/results.json` и `results/prod/results.json` в этой среде не сформированы.

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
✔ control task: replace a criterion → new version → new dialogs; without AI the new criterion is NOT scored
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
✔ claude-code-cli: chosen only explicitly; needs no API key
✔ claude-code-cli: API credentials never reach the CLI, it runs outside the project, tools off, no session saved
✔ claude-code-cli: refuses when not signed in, or signed in without a subscription
✔ claude-code-cli: a call that would use an API key (apiKeySource ≠ none) is stopped
✔ claude-code-cli: subscription limit and login errors are fatal with a clear message
✔ claude-code-cli: missing CLI and an old CLI without the needed flags are reported
✔ claude-code-cli: JSON in the text result is accepted; non-JSON text triggers the repair retry
✔ servedModel: the model with the most output tokens answered (helper models ignored)
✔ export via subscription: needs a passed RU/KZ/EN trial, stops on the limit without writing, resumes without re-sending
✔ API payload: records extracted, structure validated
✔ empty, broken or unsuccessful payloads are rejected with clear errors
✔ duplicates are dropped, transcript given as a string is parsed, unknown roles reported
✔ roles, segments and events: bot/system are context, hold is internal, end detected
✔ encoding damage in a record is repaired for display, original kept
✔ DEV dataset: 65 records, 35 RU / 15 KZ / 15 EN, 60 chats / 5 calls, all roles, all encoding repaired
✔ export: scripted local model → valid file, exact top-level shape, model taken from the served id
✔ export: evidence_turns are 1-based over ALL messages (client, bot, system, operator) and match the quote
✔ export: a quote the model invented is never written as a quote (marked as paraphrase, file stays valid)
✔ export: no model connected → refused with code 2, no results file written
✔ export: the model answered no dialog (e.g. wrong key) → code 5, the previous file is left untouched
✔ export: DEV must have exactly 65 dialogs — the 5-dialog fixture is refused with code 3
✔ export PROD: group_id fetched from the API, exactly 10 records, a failed dialog becomes an error record (not 0, not N/A)
✔ export PROD: wrong number of control dialogs (9) → stop with code 3; no group_id → refused
✔ export: offline rules go to results/preview with a NO-LLM model name that the submission check rejects
✔ model mode comes from the endpoint the evaluations actually used
✔ validator: the valid file passes, each of 47 deliberately broken variants fails with a precise message
✔ validator: byte level — BOM, invalid UTF-8, truncated JSON, non-object top level
✔ validator: error records are accepted only in the exact form {id, "error", [], null, reason}
✔ final_score: independent integer recomputation equals the scoring engine on 5000 random combinations
✔ mapping: N/A only where the format allows null; not evaluated is an error, never null or 0
✔ quotes: nesting, timed closing after a shortened inner quote, short labels are not quotes
✔ quotes: the AI-layer check and the validator agree (verified quote kept, invented one marked)
✔ JSON Schema: criterion ids, value types and enums match the format table
✔ JSON Schema (third-party jsonschema): valid file passes, structural breakages fail
✔ DEV: message m<i> is transcript[i] of the organisers' file (turn = i + 1), for all 65 dialogs
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
✔ 07 (PDF): a courtesy formula + farewell after the client's thanks is NOT a summary or an offer → «Нет» (RU/KZ/EN)
✔ 07 (PDF): summary or offer of further help + farewell → «Да» (RU/KZ/EN)
✔ 07 (PDF): an instruction given before the client's thanks is an answer, not a closing summary
✔ 07 (PDF): closed without farewell → «Нет»; client left before closing → N/A
✔ 02 (PDF): an identity check is a procedural step, a clarifying question after it is still "before the answer" → «Да»
✔ 02 (PDF): data sufficient from the start, operator answers directly → N/A
✔ 03 (PDF): identity check requested but never confirmed, nothing disclosed → N/A (not «Да»)
✔ 03 (PDF): confirmed before account data → «Да»; account data before confirmation → «Нет»
✔ 06 (PDF scale 4): the client has to ask the same question again — even if the dialog ends with thanks
✔ 06: a new, different follow-up question is not a re-ask; "не понимаю" after an operator reply is
✔ 07 (PDF): a long polite wish without the case content is not a summary → «Нет»; a summary about the case → «Да»
✔ 06: a follow-up that adds new content is a new question, not a re-ask
✔ 02: an offer to write back ("Напишите нам, когда будете готовы") is not a clarifying question
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
✔ fragment repair: short replies and a damaged word inside Latin text are restored exactly; original kept
✔ fragment repair never touches clean text (RU/KZ/EN, quotes, №, ё, Ї, short replies)
✔ original text is preserved alongside the normalised one
✔ message quality flags: masked data, DTMF, ASR fragments; no false "mixed script" for AI-ассистент
✔ language detection for greetings
✔ timestamps: chat MM:SS and call ISO 8601 with 7 fractional digits and offset
✔ relative offsets keep original order and do not invent time
✔ audio sync: recording pauses can be excluded and a calibration offset applied (and inverted)
ℹ tests 113
ℹ pass 113
ℹ fail 0
ℹ skipped 0
```

## Вывод `npm run test:e2e`

```
✔ дашборд открывается и показывает набор TEST
✔ список диалогов: 5 строк, поиск по ID фильтрует
✔ карточка: клик по доказательству подсвечивает реплику
✔ оператор подаёт апелляцию по критерию 05
✔ проверяющий: взять в работу → изменить оценку с живым пересчётом
✔ итог диалога пересчитан, исходная оценка сохранена
✔ чек-лист: изменить порог первой реакции в интерфейсе (180 → 30 с) → новая активная версия v2
✔ переоценка по v2 из карточки: критерий 06 и итог изменились, панель «что изменилось»
✔ звонок: недоступная запись → понятное сообщение, транскрипт доступен
✔ аналитика, данные и режим встраивания (Dynamics 365) открываются
✔ ни на одной странице и в раскрытых карточках критериев нет «null» / «undefined» / «NaN»
✔ в консоли браузера нет ошибок
ℹ steps 12  ℹ pass 12  ℹ fail 0
```
