# REST API сервера CQA

Базовый адрес — `http://127.0.0.1:3000`. Все ответы — JSON (`application/json; charset=utf-8`), ошибки — `{ "error": "…", "details": … }` с кодом 4xx/5xx.

Роль и имя пользователя передаются заголовками `x-cqa-role: specialist | reviewer` и `x-cqa-user: <имя в URL-кодировке>` (в демо их выставляет интерфейс; в промышленном варианте — шлюз после авторизации). Действия проверяющего без роли `reviewer` возвращают `403`.

Подписанные ссылки (API организаторов, записи звонков) и ключи AI никогда не возвращаются клиенту.

## Система и данные

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/health` | Проверка работоспособности |
| GET | `/api/system` | Версия, активный набор, активный чек-лист, статус AI (без секретов; адрес API — только хост) |
| GET | `/api/datasets` | Загруженные наборы, активный, отчёты о проверке |
| POST | `/api/datasets/fetch` | Загрузить набор из API организаторов. Тело: `{ "group_id": "DEV", "activate": true }`. Повторы при сетевых ошибках/5xx/429, проверка структуры, дубликаты отбрасываются |
| POST | `/api/datasets/import` | Загрузить JSON-текст. Тело: `{ "group_id": "DEV", "content": "<текст ответа API>", "activate": true }` |
| POST | `/api/datasets/active` | Сделать набор активным: `{ "group_id": "CONTROL" }` |
| GET | `/api/analytics/summary?group=DEV` | Агрегаты для обзора и аналитики (без цитат из диалогов) |
| GET | `/api/audio/:uid` | Запись звонка через серверный прокси (поддерживает `Range`) |
| GET | `/api/audio/:uid/status` | Состояние записи: в кэше / ошибка (например, «ссылка могла истечь») |

## Диалоги и оценки

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/conversations` | Список активного (или `group=`) набора. Фильтры: `q` (ID или текст), `language=RU,KZ,EN`, `channel=chat,call`, `status=not_evaluated,auto,needs_review,reviewed,appeal`, `critical=1` (нарушения/риски), `gross=1`, `min`, `max` (балл), `fail=<criterion_id>`, `appeal=open\|any`; сортировка `sort` + `dir=asc\|desc` |
| GET | `/api/conversations/:uid` | Карточка: диалог (сообщения, события, качество текста), последняя оценка, история оценок, апелляции, состояние записи. `uid` = `<group>:<conversation_id>` в URL-кодировке |
| POST | `/api/conversations/:uid/evaluate` | Оценить: `{ "engine": "auto\|ai\|rules", "checklist_version": 2 }` (версия необязательна — по умолчанию активная). Ответ: `{ evaluation, previous_id, diff }` |
| POST | `/api/evaluations/batch` | Пакетная оценка в фоне: `{ "scope": "unevaluated\|all\|outdated\|selected", "uids": [...], "engine": "auto" }` → `202 { id, total }` |
| GET | `/api/jobs/:id` | Прогресс пакетной оценки: `status` (`running` / `done`), `done`, `failed`, `total`, ошибки |
| GET | `/api/estimate?group=DEV&scope=all` | Прогноз токенов и стоимости AI-оценки |
| GET | `/api/evaluations/:id` | Оценка целиком (снимок чек-листа, результаты, доказательства, решения, история, токены и стоимость) |
| GET | `/api/evaluations/:id/compare/:other` | Что изменилось между двумя оценками |
| POST | `/api/evaluations/:id/override` | Решение проверяющего по критерию (reviewer): `{ "criterion_id": "empathy", "status": "scored\|na", "answer": "yes", "reason": "…" }` |
| POST | `/api/evaluations/:id/findings/:finding/review` | Подтвердить нарушение или отметить ложное срабатывание (reviewer): `{ "decision": "confirmed\|false_positive", "note": "…" }` |
| POST | `/api/evaluations/:id/verify` | Подтвердить проверку оценки (reviewer): `{ "note": "…" }` |

## Апелляции

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/appeals?status=new,pending&uid=…` | Очередь с количеством по статусам |
| GET | `/api/appeals/:id` | Апелляция, спорная оценка, фрагмент диалога, снимок чек-листа, текущий расчёт |
| POST | `/api/appeals` | Подать: `{ "evaluation_id": "EV-…", "criterion_id": "empathy", "comment": "…" }` (комментарий ≥ 5 символов; одна открытая апелляция на критерий оценки, иначе `409`) |
| POST | `/api/appeals/:id/take` | Взять в работу (reviewer): «Новая» → «Ожидает рассмотрения» |
| POST | `/api/appeals/:id/decide` | Решение (reviewer): `{ "decision": "confirm" }` или `{ "decision": "change", "status": "scored\|na", "answer": "yes", "reason": "…" }` — итог пересчитывается, исходная оценка сохраняется |
| POST | `/api/appeals/:id/close` | Закрыть после решения или отозвать новую: `{ "note": "…" }` |

Статусы: `new` (Новая) → `pending` (Ожидает рассмотрения) → `confirmed` (Подтверждена) / `changed` (Изменена) → `closed` (Закрыта); отозванная новая апелляция закрывается с отметкой «отозвана». Удаления нет.

## Чек-лист

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/checklists` | Версии (номер, дата, автор, описание изменений, число критериев, сумма весов) и активная |
| GET | `/api/checklists/meta` | Справочники для редактора: типы ответов, политики N/A, округления, грубых ошибок, режимы, детекторы |
| GET | `/api/checklists/active` | Активная версия целиком |
| GET | `/api/checklists/:version` | Версия целиком |
| GET | `/api/checklists/:version/export` | Скачать JSON версии |
| GET | `/api/checklists/diff?from=1&to=2` | Изменения: добавленные, удалённые, изменённые критерии (по полям), общие настройки |
| POST | `/api/checklists/validate` | Проверить без сохранения: `{ "checklist": {…} }` → `{ ok, errors, warnings }` |
| POST | `/api/checklists` | Сохранить как новую версию: `{ "checklist": {…}, "change_note": "…", "activate": true, "parent_version": 1 }` → `201`; при ошибках схемы `400` с `details.errors` |
| POST | `/api/checklists/import` | Импорт JSON-текста или объекта: `{ "checklist": "<json>", "activate": false, "change_note": "…" }` |
| POST | `/api/checklists/:version/activate` | Сделать версию активной (в т. ч. откат) |

## Пример: контрольный набор и переоценка из терминала

```zsh
B=http://127.0.0.1:3000
curl -sS -X POST $B/api/datasets/fetch -H 'content-type: application/json' \
  -d '{"group_id":"CONTROL","activate":true}'
curl -sS -X POST $B/api/evaluations/batch -H 'content-type: application/json' \
  -d '{"scope":"unevaluated","engine":"auto"}'
curl -sS $B/api/jobs/<id>
```
