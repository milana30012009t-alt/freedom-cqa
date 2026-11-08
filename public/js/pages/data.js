// Data sources & AI: organisers' API by group_id (DEV → control set), local JSON upload,
// active dataset switch, validation report, AI engine status, cost estimate, batch evaluation.
import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { setCrumbs } from '../core/crumbs.js';
import { loading, emptyState, toast, errorToast } from '../core/ui.js';
import { fmtDate, fmtNum } from '../core/format.js';
import { refreshSystem } from '../main.js';

export async function render(root, { isCurrent }) {
  setCrumbs('Данные и AI');
  mount(root, loading());
  let sys;
  try {
    sys = await api.get('/api/system');
  } catch (e) {
    mount(root, emptyState('alert', 'Ошибка', e.message));
    return;
  }
  if (!isCurrent()) return;
  const ds = sys.dataset;
  const progress = h('div', { class: 'col' });

  const groupInput = h('input', { class: 'input', value: ds.default_group || 'DEV', placeholder: 'group_id, например DEV' });
  groupInput.style.width = '160px';
  const fetchBtn = h('button', { class: 'btn primary', disabled: !ds.api_configured }, icon('download'), 'Загрузить из API');
  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true;
    mount(progress, h('div', { class: 'small' }, h('span', { class: 'spinner' }), ` Запрос GET ?group_id=${groupInput.value}…`));
    try {
      const r = await api.post('/api/datasets/fetch', { group_id: groupInput.value.trim(), activate: true });
      report(r.result);
      toast(`Загружено ${r.result.record_count} диалогов (${r.result.group_id})`, 'good');
      await refreshSystem();
      render(root, { isCurrent });
    } catch (e) {
      mount(progress, h('div', { class: 'banner critical' }, icon('alert'), h('div', {}, e.message)));
    } finally {
      fetchBtn.disabled = !ds.api_configured;
    }
  });

  const fileGroup = h('input', { class: 'input', value: 'DEV', placeholder: 'group_id' });
  fileGroup.style.width = '120px';
  const fileInput = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', class: 'hidden' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    mount(progress, h('div', { class: 'small' }, h('span', { class: 'spinner' }), ` Проверка файла «${file.name}»…`));
    try {
      const content = await file.text();
      const r = await api.post('/api/datasets/import', { group_id: fileGroup.value.trim(), content, activate: true });
      report(r.result);
      toast(`Импортировано ${r.result.record_count} диалогов`, 'good');
      await refreshSystem();
      render(root, { isCurrent });
    } catch (e) {
      mount(progress, h('div', { class: 'banner critical' }, icon('alert'), h('div', {}, e.message)));
    }
    fileInput.value = '';
  });

  function report(r) {
    mount(progress, h('div', { class: `banner ${r.errors.length ? 'warning' : 'good'}` }, icon(r.errors.length ? 'alert' : 'check'), h('div', { class: 'b-body' },
      h('div', {}, h('b', {}, `${r.group_id}: ${r.record_count} диалогов`), ` (новых ${r.added}, обновлено ${r.updated}${r.duplicates.length ? `, пропущено дубликатов ${r.duplicates.length}` : ''})`),
      r.errors.length ? h('div', {}, `Ошибки: ${r.errors.slice(0, 5).join('; ')}`) : null,
      r.warnings.length ? h('details', {}, h('summary', { class: 'small' }, `Предупреждения: ${r.warnings.length}`), h('ul', { class: 'small' }, r.warnings.slice(0, 50).map((w) => h('li', {}, w)))) : null)));
  }

  const groups = ds.groups.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['Набор', 'Диалогов', 'Языки', 'Каналы', 'Источник', 'Загружен', 'Проверка', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, ds.groups.map((g) => h('tr', {},
      h('td', {}, h('b', { class: 'mono' }, g.group_id), g.group_id === ds.active_group ? h('span', { class: 'chip brand' }, 'активный') : null),
      h('td', { class: 'num' }, String(g.record_count), g.declared_total !== null && g.declared_total !== g.record_count ? h('span', { class: 'chip warning' }, `заявлено ${g.declared_total}`) : null),
      h('td', { class: 'small' }, Object.entries(g.by_language).map(([k, v]) => `${k} ${v}`).join(' · ')),
      h('td', { class: 'small' }, Object.entries(g.by_channel).map(([k, v]) => `${k === 'call' ? 'звонки' : 'чаты'} ${v}`).join(' · ')),
      h('td', { class: 'small' }, g.source === 'api' ? 'API' : 'файл'),
      h('td', { class: 'small' }, fmtDate(g.loaded_at)),
      h('td', { class: 'small' }, g.validation.errors.length ? h('span', { class: 'chip critical' }, `ошибок ${g.validation.errors.length}`) : h('span', { class: 'chip good' }, 'OK'),
        g.validation.warnings.length ? h('span', { class: 'chip warning', title: g.validation.warnings.slice(0, 10).join('\n') }, `предупр. ${g.validation.warnings.length}`) : null,
        g.repaired_messages ? h('span', { class: 'chip info', title: 'Реплики с восстановленной кодировкой (оригинал сохранён)' }, `кодировка: ${g.repaired_messages}`) : null),
      h('td', {}, g.group_id !== ds.active_group ? h('button', { class: 'btn xs', onclick: async () => { try { await api.post('/api/datasets/active', { group_id: g.group_id }); toast(`Активный набор: ${g.group_id}`, 'good'); await refreshSystem(); render(root, { isCurrent }); } catch (e) { errorToast(e); } } }, 'Сделать активным') : null)))))) : emptyState('database', 'Наборы не загружены');

  const dataCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('database'), h('h3', {}, 'Наборы данных')),
    h('div', { class: 'card-body col gap-16' },
      groups,
      h('div', { class: 'editor-block' },
        h('h4', {}, icon('link'), 'API организаторов (GET по group_id)'),
        h('div', { class: 'small dim' }, ds.api_configured ? `Адрес: ${ds.api_url_display}. Подписанная ссылка хранится только в .env на сервере.` : 'DATASET_API_URL не задан в .env — вставьте туда ссылку кнопки «Открыть GET для DEV» из PDF-задания и перезапустите сервер. Пока можно загрузить JSON-файл.'),
        h('div', { class: 'row wrap' }, h('label', { class: 'field' }, h('span', {}, 'group_id'), groupInput), h('div', { class: 'spacer' }), fetchBtn),
        h('div', { class: 'xs muted' }, 'Для контрольного набора (через 23 часа) введите выданный организаторами group_id и нажмите «Загрузить из API» — набор станет активным, затем оцените его на странице «Диалоги». Повторы при временных ошибках и проверка структуры ответа выполняются автоматически, дубликаты conversation_id отбрасываются.')),
      h('div', { class: 'editor-block' },
        h('h4', {}, icon('upload'), 'Локальный JSON-файл (резерв, если API недоступен)'),
        h('div', { class: 'row wrap' }, h('label', { class: 'field' }, h('span', {}, 'group_id'), fileGroup), fileInput,
          h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => fileInput.click() }, icon('upload'), 'Выбрать файл (.json / .txt)')),
        h('div', { class: 'xs muted' }, 'Файл может быть сохранённым ответом API (даже с расширением .txt). Повреждённая кодировка восстанавливается безопасно, оригинал сохраняется.')),
      progress));

  const e = sys.engine;
  const estBox = h('div', { class: 'col' });
  const estimate = async () => {
    mount(estBox, h('div', { class: 'small' }, h('span', { class: 'spinner' }), ' Расчёт…'));
    try {
      const est = await api.get('/api/estimate?scope=all');
      mount(estBox, h('dl', { class: 'kv' },
        h('dt', {}, 'Модель'), h('dd', {}, est.model),
        h('dt', {}, 'Диалогов'), h('dd', {}, String(est.conversations)),
        h('dt', {}, 'Вызовов на оценку'), h('dd', {}, est.calls_per_evaluation),
        h('dt', {}, 'Токены (в среднем)'), h('dd', {}, `вход ~${fmtNum(est.avg_input_tokens)}, выход ~${fmtNum(est.avg_output_tokens)} (включая запас на рассуждения модели)`),
        h('dt', {}, 'Одна оценка'), h('dd', {}, `≈ $${est.per_evaluation_usd}`),
        h('dt', {}, 'Весь набор'), h('dd', {}, h('b', {}, `≈ $${est.total_usd}`), ' с кэшированием неизменной части промпта'),
        h('dt', {}, 'Цены'), h('dd', { class: 'small dim' }, `$${est.pricing.inputPerMTok} / $${est.pricing.outputPerMTok} за 1 млн входных/выходных токенов; чтение кэша $${est.pricing.cacheReadPerMTok}`)));
    } catch (err) { mount(estBox, h('div', { class: 'banner critical' }, icon('alert'), h('div', {}, err.message))); }
  };

  const batchBox = h('div', { class: 'col' });
  const runBatch = async (scope, engine) => {
    try {
      const job = await api.post('/api/evaluations/batch', { scope, engine });
      if (!job.total) { toast('Нет диалогов для оценки', 'info'); return; }
      const bar = h('i');
      bar.style.width = '0%';
      const label = h('div', { class: 'small' }, `0 / ${job.total}`);
      mount(batchBox, label, h('div', { class: 'progress' }, bar));
      const poll = async () => {
        const j = await api.get(`/api/jobs/${job.id}`);
        bar.style.width = `${Math.round((j.done / j.total) * 100)}%`;
        label.textContent = `${j.done} / ${j.total}${j.failed ? ` · ошибок ${j.failed}` : ''}`;
        if (j.status === 'running') { setTimeout(poll, 600); return; }
        toast(`Оценка завершена: ${j.done - j.failed} из ${j.total}`, j.failed ? 'error' : 'good');
        const costs = j.results.filter((r) => r.ok);
        label.textContent = `Готово: ${j.done - j.failed} из ${j.total}. Движки: ${[...new Set(costs.map((r) => r.engine))].join(', ') || '—'}`;
        refreshSystem();
      };
      poll();
    } catch (err) { errorToast(err); }
  };

  const aiCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('sparkle'), h('h3', {}, 'AI-оценка')),
    h('div', { class: 'card-body col gap-12' },
      h('div', { class: `banner ${e.ai_available ? 'good' : 'warning'}` }, icon(e.ai_available ? 'check' : 'info'), h('div', { class: 'b-body' },
        e.ai_available ? h('div', {}, h('b', {}, `Подключено: ${e.ai.label}. `), 'Модель оценивает смысл диалога по тексту критериев; ответ проверяется по JSON-схеме, ссылки на реплики — по транскрипту; баллы считает детерминированный модуль.')
          : h('div', {}, h('b', {}, 'AI-ключ не задан. '), 'Работает офлайн-движок правил: прозрачные многоязычные проверки с доказательствами, без «понимания смысла». Чтобы включить Claude, добавьте ANTHROPIC_API_KEY в .env и перезапустите сервер.'),
        h('div', { class: 'small' }, `При сбое AI: ${e.fallback_to_rules ? 'оценка офлайн-правилами с пометкой' : 'ошибка без оценки'}. Параллельных запросов: ${e.concurrency}. Версия правил: ${e.rules_version}.`))),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', onclick: () => runBatch('unevaluated', 'auto') }, icon('sparkle'), 'Оценить неоценённые'),
        h('button', { class: 'btn', onclick: () => runBatch('outdated', 'auto') }, icon('refresh'), 'Переоценить устаревшие'),
        h('button', { class: 'btn', onclick: () => runBatch('all', 'auto') }, icon('refresh'), 'Переоценить все'),
        h('button', { class: 'btn ghost', onclick: () => runBatch('all', 'rules') }, icon('cpu'), 'Все — офлайн-правилами')),
      batchBox,
      h('div', { class: 'divider' }),
      h('div', { class: 'row' }, h('h4', {}, 'Стоимость AI-оценки'), h('div', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: estimate }, icon('chart'), 'Рассчитать для набора')),
      estBox,
      h('div', { class: 'xs muted' }, 'Оценка до запуска — по размеру промпта (чек-лист + транскрипт) и ценам из .env. Фактические токены и стоимость каждой AI-оценки сохраняются в ней (вкладка «История» → экспорт JSON).')));

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Данные и AI'), h('div', { class: 'sub' }, 'Источник данных, переключение на контрольный набор, движок оценки и стоимость.'))),
    h('div', { class: 'grid c-7-5' }, dataCard, aiCard));
  void store;
}
