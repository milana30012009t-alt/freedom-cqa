# Запуск на MacBook (Apple Silicon) без оплаты API: подписка Claude через Claude Code

Пошагово: команда → что должно появиться. Все команды вводятся в приложении «Терминал» (zsh).

Правила ввода:
- копируйте команды целиком, по одной строке;
- слова ЗАГЛАВНЫМИ (`GROUP_ID`, `ORG/REPO`) замените своими значениями, **без угловых скобок** — в zsh `<…>` ломает команду;
- не дописывайте после команды комментарии через `#`: zsh передаст их программе как аргументы.

Как это работает: проект вызывает установленный у вас официальный Claude Code в неинтерактивном режиме (`claude -p`), вошедший в **вашу подписку Claude**. Ключ API не нужен и не используется: проект убирает `ANTHROPIC_API_KEY` и похожие переменные из окружения Claude Code, запускает его из пустой папки, без инструментов и без сохранения сессий, и при каждом вызове проверяет, что Claude Code сам сообщает «ключ API не используется» (`apiKeySource: none`). Иначе вызов останавливается.

Расход — из лимитов подписки (5-часовые и недельные; общие с чатами на claude.ai). Сколько диалогов поместится в одно 5-часовое окно Pro, заранее неизвестно. При достижении лимита прогон останавливается, ничего не перезаписывает, а после сброса продолжается с места остановки.

Проект считается готовым к сдаче только после шага 13: настоящая модель создала `results/dev/results.json`, проверка пройдена, файл в GitHub.

---

## Что подготовить заранее

| Что | Где взять |
|---|---|
| Подписка Claude Pro (или Max) | ваша учётная запись claude.ai |
| Название команды | LUCKYCHARM (уже вписано в `.env.example` и README) |
| Ссылка GET для DEV | кнопка «Открыть GET для DEV» в PDF-задании (длинная ссылка с `sig=…`; никому не пересылать) |
| Репозиторий GitHub | адрес вида `https://github.com/ORG/REPO.git` и токен доступа (шаг 13) |

---

## 1. Проверить Mac и инструменты

```zsh
uname -m
```
Должно быть: `arm64`.

```zsh
git --version
```
Должно быть: `git version 2.…`. Если macOS предлагает установить «инструменты разработчика» — нажмите «Установить», дождитесь окончания и повторите команду.

```zsh
node -v
```
Должно быть: `v22.…` или `v24.…` (проект проверен на 22.23 и 24.22; минимум 18.15).
Если `command not found` или версия ниже — скачайте установщик LTS для macOS на https://nodejs.org (файл `.pkg`), установите, **закройте и заново откройте Терминал**, повторите `node -v`.

## 2. Распаковать проект

Если Safari уже распаковал архив, в «Загрузках» лежит папка `freedom-cqa` — тогда вместо `unzip` выполните `mkdir -p ~/cqa && mv ~/Downloads/freedom-cqa ~/cqa/`.

```zsh
mkdir -p ~/cqa && cd ~/cqa && unzip -q ~/Downloads/freedom-cqa.zip && cd freedom-cqa && ls
```
Должно быть: `README.md  checklists  data  docs  package.json  public  results  schemas  scripts  server  shared  tests`.

Дальше **все команды — из этой папки**. Если открыли новое окно Терминала: `cd ~/cqa/freedom-cqa`.

## 3. Тесты

```zsh
npm test
```
Через 10–20 секунд последние строки:
```
ℹ tests 113
ℹ pass 102
ℹ fail 0
ℹ skipped 11
```
11 пропущенных — тесты на реальном DEV; после шага 7 они тоже выполняются (`pass 113`). Тесты не обращаются к Claude и не расходуют подписку. Если `fail` больше 0 — остановитесь и пришлите вывод.

## 4. Убрать ключи API из терминала

Если в терминале задан `ANTHROPIC_API_KEY`, любой ваш запуск `claude -p` вне проекта списывал бы деньги с API. Проект его для себя убирает, но лучше убрать совсем. Команда покажет только имена, без значений:

```zsh
env | grep -oE '^(ANTHROPIC_[A-Z_]+|OPENAI_[A-Z_]+|DATASET_[A-Z_]+|TEAM_NAME|AI_(PROVIDER|CONCURRENCY|TIMEOUT_MS|MAX_RETRIES|FALLBACK_TO_RULES))='
```
Должно быть: **пустой вывод**. Если что-то вывелось — найдите, где это задано: `grep -l ANTHROPIC ~/.zshrc ~/.zprofile ~/.bash_profile 2>/dev/null`, удалите эти строки (`nano ~/.zshrc`), закройте Терминал, откройте новый, `cd ~/cqa/freedom-cqa` и повторите.

## 5. Claude Code: установить, войти через подписку, отключить оплату сверх лимита

```zsh
claude --version
```
Если `command not found` — установите официальным установщиком и **откройте новое окно Терминала**:
```zsh
curl -fsSL https://claude.ai/install.sh | bash
```
Повторите `claude --version` → должно быть `2.1.… (Claude Code)`. Если версия старая — `claude update`.

Вход через подписку (откроется браузер — войдите в свою учётную запись claude.ai и подтвердите доступ):
```zsh
claude auth login --claudeai
```

Проверка входа:
```zsh
claude auth status
```
Должно быть среди строк: `"loggedIn": true`, `"authMethod": "claude.ai"`, `"subscriptionType": "pro"` (или `max`). Если `authMethod` другой — `claude auth logout`, затем снова `claude auth login --claudeai`.

**Чтобы не было никаких доплат:** откройте claude.ai → Settings → **Usage** и убедитесь, что **usage credits** (оплата сверх лимита) **выключены**. Тогда при достижении лимита запросы просто останавливаются до сброса, а не оплачиваются.

Сколько лимита осталось (по желанию): запустите `claude`, введите `/usage`, посмотрите проценты, выйдите `/exit`.

## 6. Настройки `.env`

```zsh
cp .env.example .env && nano .env
```
Откроется редактор. Ничего в нём не меняйте и не раскомментируйте строки с `#` — **пролистайте в самый конец файла** (стрелка вниз или несколько раз `Ctrl+V`) и **допишите** блок. Строки в конце файла главнее одноимённых строк выше. Значения без кавычек. Сохранить: `Ctrl+O`, `Enter`; выйти: `Ctrl+X`.

```
TEAM_NAME=LUCKYCHARM
DATASET_API_URL=ссылка GET для DEV целиком (вставить Cmd+V)
AI_PROVIDER=claude-code-cli
CLAUDE_CODE_MODEL=sonnet
AI_CONCURRENCY=1
AI_TIMEOUT_MS=600000
```
`ANTHROPIC_API_KEY` **не заполняйте**. `sonnet` — Claude Sonnet: расходует лимит экономнее, чем Opus.

## 7. Проверка настроек и загрузка DEV через API

```zsh
npm run preflight
```
Должно быть:
```
✔ TEAM_NAME: «LUCKYCHARM»
✔ модель: Claude Code CLI 2.1.…, sonnet; вход через подписку Claude (pro)
• пробный прогон ещё не пройден: npm run check:model, затем npm run check:model -- --sample
✔ DATASET_API_URL задан (хост …)
• results/dev/results.json ещё нет
• results/prod/results.json ещё нет
✖ не git-репозиторий …
```
Строка про Git станет зелёной на шаге 13. Если вместо второй строки `✖ Claude Code: …` — выполните то, что написано в сообщении (обычно `claude auth login --claudeai`).

```zsh
npm start
```
Должно быть (первый запуск сам скачивает DEV из API; в начале строк — дата и время):
```
INFO Загрузка набора DEV из https://…/… (параметры скрыты)
INFO Набор DEV загружен из API: 65 диалогов
INFO CQA запущен: http://127.0.0.1:3000
INFO Оценка: claude-code-cli · sonnet (подписка Claude через Claude Code)
INFO Данные: DEV (65); API: … (параметры скрыты)
```
**Остановите сервер**: `Ctrl+C` (экспорт и проверка работают без сервера; одновременно их не запускать). Интерфейс можно открыть позже, но каждая оценка в нём тоже расходует подписку.

Если вместо 65 диалогов `HTTP 403` — ссылка неверна или устарела: допишите в конец `.env` новую строку `DATASET_API_URL=…`. Если сеть недоступна — откройте ссылку в браузере, сохраните ответ как `~/Downloads/dev.json` и выполните `npm run import -- ~/Downloads/dev.json --group DEV` → `Набор DEV: 65 диалогов …`.

## 8. Пробный прогон: 1 диалог

```zsh
npm run check:model
```
Должно быть (числа и оценки будут другими):
```
Claude Code 2.1.… · вход через подписку Claude (pro) · ключ API не используется · модель sonnet
Пробный прогон: 1 диалог (p1-ru-001 RU), чек-лист v1. Файлы results/dev и results/prod не изменяются.

✔ p1-ru-001 (RU, chat) · NN с · модель claude-sonnet-5-5 · токены: вход …, выход …
   итог NN.NN · contact=true discovery=… identification=… consultation=… empathy=… dialogue=… closure=… critical=false
   пример обоснования (contact, реплики N): …

model: {"mode":"external_api","name":"claude-sonnet-5-5"}
Проверка по формату JSON 1.0: ПРОЙДЕНА (записей 1, ok 1, error 0; …)
✔ Пробный прогон пройден. Следующий шаг: npm run check:model -- --sample (по одному диалогу на RU, KZ, EN)
```
Прочитайте пример обоснования: он должен описывать реальный диалог. Если `✖` — не продолжайте и пришлите вывод.

## 9. Пробный прогон: 3 диалога (RU, KZ, EN)

```zsh
npm run check:model -- --sample
```
Должно быть: три строки `✔` (`p1-ru-002 RU`, `p1-kz-001 KZ`, `p1-en-001 EN`), `Проверка по формату JSON 1.0: ПРОЙДЕНА (записей 3, ok 3, error 0 …)` и в конце:
```
✔ Проверка на RU, KZ, EN пройдена. Можно запускать все 65 диалогов: npm run export:dev
  (уже оценённые здесь диалоги повторно не отправляются; ~NN с на диалог → около NN мин …)
```
Запишите время на диалог. Пробные файлы лежат в `results/preview/` (не попадают в Git). **Пока этот шаг не пройден, `npm run export:dev` для подписки не запустится** (код 7).

## 10. Все 65 диалогов DEV

```zsh
npm run export:dev
```
Должно быть:
```
Claude Code 2.1.…: вход через подписку Claude (pro), ключ API не используется
Чек-лист: v1 (формулировки PDF); движок: Claude Code CLI (подписка) · sonnet; уже успешно оценённые этой моделью диалоги повторно не отправляются
  1/65 p1-ru-001      ok   NN.NN  (оценка от …, повторно не отправлялся)
  2/65 p1-ru-002      ok   NN.NN  (оценка от …, повторно не отправлялся)
  3/65 p1-ru-003      ok   NN.NN
…
Записей: 65 (ok 65, error 0); …
Проверка: ПРОЙДЕНА
```
Не закрывайте Терминал и не давайте Mac уснуть до конца (можно запустить `caffeinate -i npm run export:dev` вместо команды выше).

| Видите | Что делать |
|---|---|
| `✖ Прогон остановлен: Достигнут лимит подписки Claude: … resets …` (код 6) | дождитесь указанного времени сброса и выполните **ту же команду**: уже оценённые диалоги не отправятся повторно. Файл не записан, прежний не тронут |
| `✖ … не авторизован` / `не через подписку` (код 6) | `claude auth login --claudeai`, затем та же команда |
| `✖ Сначала пробный прогон …` (код 7) | шаги 8–9 |
| итог `ok 63, error 2` и `! 2 из 65 записей со статусом error` | выполните ту же команду ещё раз: отправятся только диалоги с ошибкой |
| `Claude Code не ответил за 600 с` | повторите команду; если часто — допишите в `.env` `AI_TIMEOUT_MS=900000` |

```zsh
echo $?
```
Должно быть: `0`.

## 11. Проверить файл

```zsh
npm run validate:results
```
Должно быть:
```
=== DEV: …/results/dev/results.json
Записей 65 (ok 65, error 0); критериев 520; …; сверено с …/data/datasets/DEV.raw.json
✔ ПРОЙДЕНА
```

```zsh
head -c 300 results/dev/results.json
```
Должно быть: `"schema_version": "1.0"`, ваше `team_name`, `"model": {"mode": "external_api", "name": "claude-sonnet-5-5"}` (или та модель, что фактически ответила).

## 12. Перед последним часом: запас лимита

Контрольные 10 чатов тоже пойдут через подписку. Чтобы лимит не закончился посреди PROD-часа:
- не запускайте DEV и тяжёлые чаты на claude.ai в последние ~5 часов перед PROD;
- перед началом часа: `claude`, `/usage`, `/exit` — у текущего 5-часового окна должен быть запас;
- на 10 диалогов уйдёт примерно `10 × время на диалог` из шага 9.

## 13. GitHub: commit и push

### Токен (один раз)
github.com → фото профиля → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** → Repository access: только репозиторий команды → Permissions: **Contents — Read and write** → Generate → скопируйте токен. При первом `git push` Git спросит `Username` (логин GitHub) и `Password` — вставьте **токен**. macOS запомнит его в «Связке ключей».

### Подключить папку к репозиторию

Если репозиторий **пустой** (создан без README):
```zsh
git init -b main
git config user.name "Имя Фамилия"
git config user.email "почта@для.github"
git remote add origin https://github.com/ORG/REPO.git
```
После `git init` должно быть `Initialized empty Git repository in …`, остальные три команды ничего не выводят.

Если в репозитории **уже есть файлы**, выполните вместо этого (дальше работайте в папке `~/cqa/repo`):
```zsh
cd ~/cqa && git clone https://github.com/ORG/REPO.git repo && cp -R freedom-cqa/. repo/ && cd repo && git status --short
```
Если в списке есть `M .gitignore` — посмотрите `git diff .gitignore` и сохраните строки команды, если они нужны.

### Проверить, что секреты не попадут в Git, и отправить

```zsh
git add -A && git status --short | grep -E '\.env$|data/|results/preview'
```
Должно быть: строки только с `data/README.md` и `server/data/…` — **без** `.env`, `data/datasets`, `data/store`, `data/model-check.json` и `results/preview`.

```zsh
git status --short | grep -E '^A +results/'
```
Должно быть: `A  results/README.md` и `A  results/dev/results.json`.

```zsh
git commit -m "CQA: прототип и результаты DEV"
git push -u origin main
```
Должно быть в конце: `main -> main` и `branch 'main' set up to track 'origin/main'`. (Если в существующем репозитории основная ветка называется иначе, например `master`, — `git push -u origin HEAD`.)

```zsh
npm run preflight
```
Должно быть в разделе Git: `✔ репозиторий: ветка main`, `✔ remote: origin …`, `✔ origin доступен (ls-remote)`, `✔ results/dev/results.json не игнорируется`, `✔ results/prod/results.json не игнорируется`, `✔ .env не в репозитории`, `✔ data/datasets/DEV.raw.json не в репозитории`; в настройках — `✔ пробный прогон RU/KZ/EN пройден`.

Откройте репозиторий в браузере: в папке `results/dev` должен быть `results.json`.

**Здесь проект можно считать готовым к сдаче DEV.**

---

## 14. PROD: 10 контрольных чатов за один час

До начала часа: Терминал открыт в папке проекта, `npm run preflight` — всё зелёное, кроме «results/prod ещё нет», запас лимита проверен (шаг 12). Программу больше не меняйте.

| Время | Действие |
|---|---|
| 0:00 | Получить `group_id`. Если для контрольного набора дали **другую** ссылку GET — `nano .env`, допишите в конец `DATASET_API_URL=новая ссылка`, сохраните |
| 0:02 | Запустить экспорт (ниже) |
| по завершении | Проверить, commit, push |
| до 0:30 | Сдано. Оставшееся время — запас на повтор |

```zsh
npm run export:prod -- --group GROUP_ID
```
Должно быть:
```
Набор GROUP_ID получен из API организаторов: 10 записей
Claude Code 2.1.…: вход через подписку Claude (pro), ключ API не используется
…
  1/10 …      ok   …
…
Записей: 10 (ok 10, error 0); …
Проверка: ПРОЙДЕНА
```

| Видите | Действие |
|---|---|
| `✖ API вернул ошибку: …` (код 1) | `group_id` введён с ошибкой — проверьте и повторите |
| `В наборе … N диалогов, по регламенту для PROD нужно ровно 10` (код 3) | неверный `group_id` или API отдал не всё — проверьте, повторите |
| есть строки `ERROR` | повторите ту же команду: отправятся только диалоги с ошибкой |
| `Достигнут лимит подписки` (код 6) | если сброс успевает до конца часа — дождитесь и повторите ту же команду; если нет — запасной вариант: локальная модель (раздел «Запасной вариант» ниже), файл PROD тогда честно укажет её в `model` |
| API недоступен | сохраните ответ GET из браузера в `~/Downloads/control.json` и выполните `npm run export:prod -- --group GROUP_ID --file ~/Downloads/control.json` |

```zsh
npm run validate:results
```
Должно быть: `✔ ПРОЙДЕНА` и для DEV (65), и для PROD (10, «сверено с …/data/datasets/GROUP_ID.raw.json»).

```zsh
git add results/dev/results.json results/prod/results.json
git commit -m "PROD: результаты контрольного набора"
git push
```
Должно быть: `main -> main`. Откройте репозиторий в браузере: есть `results/dev/results.json` и `results/prod/results.json`.

Не редактируйте файлы вручную и не меняйте программу после получения контрольных диалогов.

---

## Запасной вариант: локальная модель Ollama (бесплатно, без интернета для модели)

Нужен, только если подписка недоступна. Проверьте его заранее, не в PROD-час.

- Ограничения: контекст Ollama по умолчанию — 4096 токенов, а один диалог с чек-листом — 7–11 тыс., поэтому сервер запускается с `OLLAMA_CONTEXT_LENGTH=20480`; Node.js обрывает запрос к Ollama через 300 секунд — один диалог должен оцениваться быстрее 5 минут.
- Установка: https://ollama.com/download, запустить один раз, затем закрыть (значок в строке меню → Quit). Во **втором** окне Терминала: `OLLAMA_CONTEXT_LENGTH=20480 ollama serve` (окно не закрывать). В первом: `ollama pull qwen2.5:7b` → `success`.
- Допишите в конец `.env`:
```
AI_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=qwen2.5:7b
OPENAI_RESPONSE_FORMAT=json_object
AI_CONCURRENCY=1
AI_TIMEOUT_MS=290000
AI_MAX_RETRIES=0
```
- Затем те же шаги 7–11 (`npm run check:model` тоже работает с Ollama). Вернуться к подписке — допишите в конец `.env` `AI_PROVIDER=claude-code-cli` и `AI_TIMEOUT_MS=600000`.

Платный вариант с ключом Claude API (`AI_PROVIDER=anthropic`) описан в [RESULTS.md](RESULTS.md); для работы через подписку он не нужен.
