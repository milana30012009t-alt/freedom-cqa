// Dashboard: KPIs from real data, priority review queue, distributions, recurring issues, activity.
import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { store } from '../core/store.js';
import { setCrumbs } from '../core/crumbs.js';
import { loading, emptyState, toast, errorToast } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { fmtScore, fmtPct, fmtRelative, langChip, channelChip, priorityChip, scorePill, actorLabel, LANGUAGE_LABELS } from '../core/format.js';
import { barList, columnChart } from '../components/charts.js';

const ACTION_LABELS = {
  evaluated: 'оценён', override: 'оценка изменена', verified: 'проверка подтверждена', finding_confirmed: 'нарушение подтверждено',
  finding_rejected: 'сигнал отклонён', created: 'подана апелляция', taken: 'апелляция в работе', confirmed: 'апелляция: оценка подтверждена',
  changed: 'апелляция: оценка изменена', closed: 'апелляция закрыта', withdrawn: 'апелляция отозвана', overrides_carried: 'решения перенесены', overrides_not_carried: 'решения не перенесены',
};

export async function render(root, { isCurrent }) {
  setCrumbs('Обзор');
  mount(root, loading());
  let a;
  try {
    a = await api.get('/api/analytics/summary');
  } catch (e) {
    mount(root, emptyState('alert', 'Не удалось загрузить данные', e.message));
    return;
  }
  if (!isCurrent()) return;
  const t = a.totals;
  const sys = store.state.system;

  if (!t.conversations) {
    mount(root, emptyState('database', 'Данные не загружены', 'Загрузите набор DEV из API организаторов или из JSON-файла.', h('a', { class: 'btn primary', href: '#/data' }, icon('upload'), 'Перейти к загрузке данных')));
    return;
  }

  const evalAll = async () => {
    try {
      const job = await api.post('/api/evaluations/batch', { scope: 'unevaluated' });
      toast(`Запущена оценка ${job.total} диалогов`, 'info');
      const poll = async () => {
        const j = await api.get(`/api/jobs/${job.id}`);
        if (j.status === 'running') { setTimeout(poll, 700); return; }
        toast(`Готово: оценено ${j.done - j.failed} из ${j.total}`, j.failed ? 'error' : 'good');
        if (isCurrent()) render(root, { isCurrent });
      };
      poll();
    } catch (e) { errorToast(e); }
  };

  const tile = (label, value, sub, onClick, { cls = '', meter, ic } = {}) => {
    let m = null;
    if (Number.isFinite(meter)) {
      const i = h('i');
      i.style.width = `${Math.round(meter * 100)}%`;
      m = h('div', { class: 't-meter' }, i);
    }
    return h('div', { class: `tile ${cls}`, role: 'button', tabindex: 0, onclick: onClick, onkeydown: (e) => { if (e.key === 'Enter') onClick(); } },
      h('div', { class: 't-label' }, ic ? icon(ic) : null, label), h('div', { class: 't-value' }, value), m, h('div', { class: 't-sub' }, sub));
  };

  const head = h('div', { class: 'page-head' },
    h('div', {},
      h('h1', {}, `Качество обслуживания · набор ${a.group}`),
      h('div', { class: 'sub' },
        a.checklist ? h('span', { class: a.checklist.official ? 'badge-official' : 'badge-custom' }, a.checklist.official ? 'официальный чек-лист' : 'изменённый чек-лист') : null,
        a.checklist ? `${a.checklist.name} · v${a.checklist.version}` : 'чек-лист не задан',
        h('span', {}, '·'),
        sys?.engine.ai_available ? `AI: ${sys.engine.ai.label}` : 'Предварительная автоматическая оценка: офлайн-правила, AI не подключён')),
    h('div', { class: 'spacer' }),
    t.not_evaluated ? h('button', { class: 'btn primary', onclick: evalAll }, icon('sparkle'), `Оценить неоценённые (${t.not_evaluated})`) : null,
    h('a', { class: 'btn', href: '#/conversations' }, icon('chats'), 'Все диалоги'));

  const tiles = h('div', { class: 'grid k6' },
    tile('Диалогов в наборе', String(t.conversations), `${a.by_channel.chat?.count || 0} чатов · ${a.by_channel.call?.count || 0} звонков`, () => navigate('/conversations'), { ic: 'chats' }),
    tile('Оценено', `${t.evaluated}`, t.not_evaluated ? `ожидают оценки: ${t.not_evaluated}` : 'все диалоги оценены', () => navigate('/conversations?status=not_evaluated'), { meter: t.evaluated / t.conversations, cls: 'accent', ic: 'check' }),
    tile('Требуют проверки', String(t.needs_review), `проверено человеком: ${t.verified}`, () => navigate('/conversations?status=needs_review&sort=priority'), { ic: 'eye' }),
    tile('Апелляции', `${t.appeals_open}`, `открытых · всего ${t.appeals_total}`, () => navigate('/appeals'), { ic: 'scale' }),
    tile('Критические случаи', String(t.critical_cases), `грубые ошибки · ещё ${t.risk_cases} с сигналами риска`, () => navigate('/conversations?critical=1&sort=priority'), { cls: t.critical_cases ? 'alert' : '', ic: 'alert' }),
    tile('Средний балл', fmtScore(t.avg_score), Number.isFinite(t.median_score) ? `медиана ${fmtScore(t.median_score)}${t.preliminary ? ` · ${t.preliminary} предварит.` : ''}` : 'нет оценок', () => navigate('/analytics'), { ic: 'chart' }));

  const queue = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('flag'), h('h3', {}, 'Приоритетная очередь ручной проверки'), h('span', { class: 'hint' }, 'грубые ошибки → сигналы риска → низкая уверенность'),
      h('div', { class: 'spacer' }), h('a', { class: 'btn ghost sm', href: '#/conversations?status=needs_review&sort=priority' }, 'Все')),
    a.priority_queue.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Диалог', 'Язык', 'Канал', 'Балл', 'Приоритет', 'Причины'].map((x) => h('th', {}, x)))),
      h('tbody', {}, a.priority_queue.map((r) => h('tr', { class: 'clickable', onclick: () => navigate(`/c/${encodeURIComponent(r.uid)}`) },
        h('td', { class: 'id' }, r.conversation_id), h('td', {}, langChip(r.language)), h('td', {}, channelChip(r.channel_type)),
        h('td', {}, scorePill(r.total, { complete: r.complete })), h('td', {}, priorityChip(r.priority)),
        h('td', { class: 'small dim' }, r.reasons.slice(0, 2).join(' · '))))))) : emptyState('check', 'Очередь пуста', t.evaluated ? 'Все оценки проверены' : 'Сначала оцените диалоги'));

  const dist = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Распределение итоговых баллов'), h('span', { class: 'hint' }, `оценено ${t.evaluated}`)),
    h('div', { class: 'card-body' }, t.evaluated ? columnChart(a.score_buckets.map((b) => ({
      label: b.label, value: b.count, title: 'диалогов',
      onClick: () => { const [lo, hi] = b.label.split('–'); navigate(`/conversations?min=${lo}&max=${hi === '100' ? 100 : Number(hi) + 0.99}`); },
    })), { height: 200 }) : emptyState('chart', 'Нет оценок')));

  const langs = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Языки'), h('span', { class: 'hint' }, 'диалогов · средний балл')),
    h('div', { class: 'card-body' }, barList(['RU', 'KZ', 'EN'].filter((l) => a.by_language[l]).map((l) => ({
      label: `${l} · ${LANGUAGE_LABELS[l]}`, value: a.by_language[l].count, sub: a.by_language[l].avg_score !== null ? `· ${fmtScore(a.by_language[l].avg_score)}` : '',
      title: `${a.by_language[l].count} диалогов, оценено ${a.by_language[l].evaluated}, средний балл ${fmtScore(a.by_language[l].avg_score)}`,
      onClick: () => navigate(`/conversations?language=${l}`),
    })))));

  const channels = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Каналы'), h('span', { class: 'hint' }, 'диалогов · средний балл')),
    h('div', { class: 'card-body' }, barList([['chat', 'Чат'], ['call', 'Звонок']].filter(([k]) => a.by_channel[k]).map(([k, l]) => ({
      label: l, value: a.by_channel[k].count, sub: a.by_channel[k].avg_score !== null ? `· ${fmtScore(a.by_channel[k].avg_score)}` : '',
      title: `${a.by_channel[k].count} диалогов, средний балл ${fmtScore(a.by_channel[k].avg_score)}`, onClick: () => navigate(`/conversations?channel=${k}`),
    })))));

  const issues = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('alert'), h('h3', {}, 'Повторяющиеся проблемы'), h('span', { class: 'hint' }, 'доля «Нет»/частично среди применимых'),
      h('div', { class: 'spacer' }), h('a', { class: 'btn ghost sm', href: '#/analytics' }, 'Аналитика')),
    h('div', { class: 'card-body' }, a.recurring_issues.length ? barList(a.recurring_issues.map((c) => ({
      label: `${c.code} ${c.name}`, value: c.fail_share, sub: `· ${c.partial + c.not_met} дл.`,
      title: c.recommendation || 'Без рекомендации', onClick: () => navigate(`/conversations?fail=${c.id}`),
    })), { format: (v) => fmtPct(v), max: 1, color: 'var(--series-2)' }) : emptyState('check', 'Проблем не выявлено')));

  const activity = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('clock'), h('h3', {}, 'Последние действия')),
    h('div', { class: 'card-body' }, a.recent_activity.length ? h('div', { class: 'timeline' }, a.recent_activity.slice(0, 8).map((x) => h('div', { class: 'tl-item' },
      h('div', { class: `tl-dot ${x.kind === 'appeal' ? 'warn' : ''}` }),
      h('div', {}, h('div', { class: 'tl-text' }, h('a', { href: x.appeal_id ? `#/appeals/${x.appeal_id}` : `#/c/${encodeURIComponent(x.uid)}` }, x.conversation_id), ` — ${ACTION_LABELS[x.action] || x.action}`),
        h('div', { class: 'tl-time' }, `${actorLabel(x.actor)} · ${fmtRelative(x.at)}`))))) : emptyState('clock', 'Пока нет действий')));

  const journey = a.journey;
  const insights = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('layers'), h('h3', {}, 'Клиентский путь'), h('span', { class: 'hint' }, 'по транскриптам')),
    h('div', { class: 'card-body col' },
      h('div', { class: 'small' }, h('b', {}, `${journey.escalated_from_bot} из ${journey.chats}`), ' чатов переданы оператору после бота; в ', h('b', {}, String(journey.bot_answered_then_escalated)), ' из них бот уже ответил, но клиент всё равно попросил человека.'),
      h('div', { class: 'small' }, 'Медиана первой реакции оператора: ', h('b', {}, `${fmtScore(journey.median_first_response_sec, 0)} с`), `; выше порога ${journey.first_response_threshold_sec} с: `, h('b', {}, String(journey.first_response_over_threshold)), '.'),
      h('div', { class: 'small' }, 'Оператор закрыл чат: ', h('b', {}, String(journey.operator_closed)), ' · клиент ушёл/связь прервалась: ', h('b', {}, String(journey.client_left)), '.'),
      h('div', { class: 'small' }, 'Исправлено кодировок: ', h('b', {}, String(a.quality.repaired_messages)), ` реплик в ${a.quality.conversations_with_repairs} диалогах (оригинал сохранён).`)));

  mount(root, head, tiles,
    h('div', { class: 'grid c-7-5 mt-16' }, queue, dist),
    h('div', { class: 'grid c3 mt-16' }, langs, channels, insights),
    h('div', { class: 'grid c-7-5 mt-16' }, issues, activity));
}
