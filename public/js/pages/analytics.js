// Analytics: recurring operator errors per criterion, gross errors/risks, customer-journey friction,
// topics, languages/channels and transcript quality — computed only from loaded data.
import { h, mount } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { setCrumbs } from '../core/crumbs.js';
import { loading, emptyState } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { fmtScore, fmtPct, LANGUAGE_LABELS } from '../core/format.js';
import { segmentedBar, legend, barList } from '../components/charts.js';

const OUTCOME = [
  ['met', 'Выполнено', 'var(--good)'],
  ['partial', 'Частично', 'var(--warning)'],
  ['not_met', 'Не выполнено', 'var(--critical)'],
  ['na', 'N/A', 'var(--neutral)'],
  ['not_evaluated', 'Не оценено', 'var(--surface-4)'],
];

export async function render(root, { isCurrent }) {
  setCrumbs('Аналитика');
  mount(root, loading());
  let a;
  try {
    a = await api.get('/api/analytics/summary');
  } catch (e) {
    mount(root, emptyState('alert', 'Ошибка', e.message));
    return;
  }
  if (!isCurrent()) return;
  const t = a.totals;
  if (!t.evaluated) {
    mount(root, emptyState('chart', 'Нет оценённых диалогов', 'Аналитика строится только по реальным оценкам. Оцените диалоги на странице «Диалоги».', h('a', { class: 'btn primary', href: '#/conversations' }, 'К диалогам')));
    return;
  }

  const criteriaCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('checklist'), h('h3', {}, 'Результаты по критериям'), h('span', { class: 'hint' }, `по последним оценкам ${t.evaluated} диалогов · чек-лист v${a.checklist?.version}`)),
    h('div', { class: 'card-body' },
      legend(OUTCOME.map(([, l, c]) => ({ label: l, color: c }))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Критерий', 'Распределение', 'Выполн.', 'Частично', 'Не выполн.', 'N/A', 'Доля проблем', ''].map((x, i) => h('th', { class: i >= 2 && i <= 6 ? 'num' : '' }, x)))),
        h('tbody', {}, a.criteria.map((c) => {
          const bar = segmentedBar(OUTCOME.map(([k, l, color]) => ({ label: c.role === 'flag' && k === 'not_met' ? 'Нарушение' : c.role === 'flag' && k === 'met' ? 'Нет нарушений' : l, value: c[k], color })), { title: `${c.code} ${c.name}` });
          bar.style.minWidth = '160px';
          return h('tr', {},
            h('td', {}, h('span', { class: 'mono muted' }, `${c.code} `), h('b', {}, c.name), c.role === 'flag' ? h('span', { class: 'chip critical' }, 'флаг') : null),
            h('td', {}, bar),
            h('td', { class: 'num' }, String(c.met)), h('td', { class: 'num' }, String(c.partial)), h('td', { class: 'num' }, String(c.not_met)), h('td', { class: 'num' }, String(c.na)),
            h('td', { class: 'num' }, c.fail_share === null ? '—' : fmtPct(c.fail_share)),
            h('td', {}, (c.partial + c.not_met) ? h('button', { class: 'btn xs', onclick: () => navigate(`/conversations?fail=${c.id}`) }, 'Диалоги') : null));
        }))))));

  const recurring = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('alert'), h('h3', {}, 'Повторяющиеся ошибки операторов'), h('span', { class: 'hint' }, 'что улучшить в обучении и инструкциях')),
    h('div', { class: 'card-body col gap-12' }, a.recurring_issues.length ? a.recurring_issues.map((c) => h('div', { class: 'col gap-4' },
      h('div', { class: 'row' }, h('b', {}, `${c.code} ${c.name}`), h('div', { class: 'spacer' }), h('span', { class: 'small' }, `${c.partial + c.not_met} из ${c.met + c.partial + c.not_met} применимых (${fmtPct(c.fail_share)})`)),
      c.recommendation ? h('div', { class: 'small dim' }, `Типовая рекомендация: ${c.recommendation}`) : null,
      h('div', { class: 'row wrap gap-4' }, c.examples.map((uid) => h('a', { class: 'chip outline clickable', href: `#/c/${encodeURIComponent(uid)}` }, uid.split(':')[1]))))) : emptyState('check', 'Повторяющихся ошибок нет')));

  const findings = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('shield'), h('h3', {}, 'Грубые ошибки и сигналы риска')),
    h('div', { class: 'card-body col gap-12' }, a.findings.length ? a.findings.map((f) => h('div', { class: 'col gap-4' },
      h('div', { class: 'row' }, h('span', { class: `chip ${f.severity === 'critical' ? 'critical' : 'warning'}` }, icon(f.severity === 'critical' ? 'alert' : 'shield'), f.severity === 'critical' ? 'грубая ошибка' : 'риск'),
        h('b', {}, f.name), h('div', { class: 'spacer' }), h('span', { class: 'small' }, `${f.count}`)),
      h('div', { class: 'row wrap gap-4' }, f.conversations.map((uid) => h('a', { class: 'chip outline clickable', href: `#/c/${encodeURIComponent(uid)}` }, uid.split(':')[1]))))) : emptyState('check', 'Не выявлено')));

  const j = a.journey;
  const journey = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('layers'), h('h3', {}, 'Клиентский путь'), h('span', { class: 'hint' }, 'факты из транскриптов')),
    h('div', { class: 'card-body' }, h('div', { class: 'grid c2' },
      stat('Переданы оператору после бота', `${j.escalated_from_bot} / ${j.chats}`, 'чатов'),
      stat('Бот ответил, но клиент попросил человека', String(j.bot_answered_then_escalated), 'кандидаты на улучшение ответов бота'),
      stat('Медиана первой реакции оператора', `${fmtScore(j.median_first_response_sec, 0)} с`, `максимум ${fmtScore(j.max_first_response_sec, 0)} с · порог ${j.first_response_threshold_sec} с`),
      stat('Первая реакция дольше порога', String(j.first_response_over_threshold), 'чатов'),
      stat('Оператор закрыл чат', String(j.operator_closed), 'проверьте завершение диалога'),
      stat('Клиент ушёл / связь прервалась', String(j.client_left), 'диалогов'))));

  const topics = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('chats'), h('h3', {}, 'Темы обращений'), h('span', { class: 'hint' }, 'классификация по ключевым словам первых реплик клиента (RU/KZ/EN)')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Тема', 'Диалогов', 'Средний балл', 'Грубые ошибки', 'Примеры'].map((x, i) => h('th', { class: i >= 1 && i <= 3 ? 'num' : '' }, x)))),
      h('tbody', {}, a.topics.map((tp) => h('tr', {},
        h('td', {}, tp.label), h('td', { class: 'num' }, String(tp.count)), h('td', { class: 'num' }, fmtScore(tp.avg_score)), h('td', { class: 'num' }, String(tp.critical)),
        h('td', {}, h('div', { class: 'row wrap gap-4' }, tp.examples.slice(0, 4).map((uid) => h('a', { class: 'chip outline clickable', href: `#/c/${encodeURIComponent(uid)}` }, uid.split(':')[1]))))))))));

  const langs = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Средний балл по языкам и каналам')),
    h('div', { class: 'card-body col gap-16' },
      barList(Object.entries(a.by_language).map(([l, v]) => ({ label: `${l} · ${LANGUAGE_LABELS[l] || l}`, value: v.avg_score ?? 0, sub: `· ${v.evaluated} дл.`, title: `оценено ${v.evaluated} из ${v.count}` })), { max: 100, format: (v) => fmtScore(v) }),
      barList(Object.entries(a.by_channel).map(([k, v]) => ({ label: k === 'call' ? 'Звонки' : 'Чаты', value: v.avg_score ?? 0, sub: `· ${v.evaluated} дл.`, title: `оценено ${v.evaluated} из ${v.count}` })), { max: 100, format: (v) => fmtScore(v) })));

  const quality = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('info'), h('h3', {}, 'Качество данных')),
    h('div', { class: 'card-body' }, h('div', { class: 'grid c2' },
      stat('Восстановлена кодировка', String(a.quality.repaired_messages), `реплик в ${a.quality.conversations_with_repairs} диалогах · оригинал сохранён`),
      stat('Похоже на ошибки распознавания', String(a.quality.asr_flagged_messages), 'реплик в звонках'),
      stat('Скрытые персональные данные', String(a.quality.masked_messages), 'реплик (маскировано в источнике)'),
      stat('Диалоги с низким качеством текста', String(a.quality.low_quality_conversations), 'направляются на ручную проверку'))));

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Аналитика качества'),
      h('div', { class: 'sub' }, `Набор ${a.group} · оценено ${t.evaluated} из ${t.conversations} · движки: ${Object.entries(a.engines).map(([k, v]) => `${k === 'rules' ? 'офлайн-правила' : k} — ${v}`).join(', ')}. Статистика считается только по реальным оценкам.`))),
    criteriaCard,
    h('div', { class: 'grid c2 mt-16' }, recurring, findings),
    h('div', { class: 'grid c2 mt-16' }, journey, langs),
    h('div', { class: 'grid c2 mt-16' }, topics, quality));
}

function stat(label, value, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 't-label' }, label), h('div', { class: 't-value' }, value), h('div', { class: 't-sub' }, sub));
}
