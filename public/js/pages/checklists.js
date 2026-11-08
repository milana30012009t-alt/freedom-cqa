// Checklist management: immutable versions, editor (save as a new version), activation,
// JSON import/export, diff, and re-evaluation with the new version.
import { h, mount, clear, downloadJson } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { setCrumbs } from '../core/crumbs.js';
import { loading, emptyState, toast, errorToast, openModal, confirmModal } from '../core/ui.js';
import { navigate } from '../core/router.js';
import { fmtDate, fmtScore, actorLabel } from '../core/format.js';
import { allowedAnswers } from '../../shared/checklist-schema.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const SOURCE = { seed: 'начальная конфигурация', ui: 'изменено в интерфейсе', import: 'импорт JSON' };

export async function render(root, { params, isCurrent }) {
  setCrumbs(['Чек-лист', '#/checklists'], params.version ? `Версия ${params.version}` : 'Управление');
  mount(root, loading());
  let list;
  let meta;
  try {
    [list, meta] = await Promise.all([api.get('/api/checklists'), api.get('/api/checklists/meta')]);
  } catch (e) {
    mount(root, emptyState('alert', 'Ошибка загрузки', e.message));
    return;
  }
  if (!isCurrent()) return;
  if (!list.versions.length) {
    mount(root, emptyState('checklist', 'Чек-лист не создан', 'Импортируйте JSON чек-листа.'));
    return;
  }
  const selected = Number(params.version) || list.active_version;
  let version;
  try {
    version = await api.get(`/api/checklists/${selected}`);
  } catch (e) {
    mount(root, emptyState('alert', 'Версия не найдена', e.message));
    return;
  }
  const state = { mode: 'view', draft: null, expanded: new Set(), validation: null };

  const versionsCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, icon('layers'), h('h3', {}, 'Версии'), h('div', { class: 'spacer' }), importButton()),
    h('div', { class: 'versions' }, list.versions.map((v) => h('div', { class: `version ${v.version === selected ? 'selected' : ''}`, role: 'button', tabindex: 0, onclick: () => navigate(`/checklists/${v.version}`) },
      h('div', { class: 'v-title' }, `v${v.version}`, v.status === 'active' ? h('span', { class: 'chip brand' }, icon('check'), 'активна') : h('span', { class: 'chip' }, 'архив'),
        v.official ? h('span', { class: 'badge-official' }, 'официальный') : h('span', { class: 'badge-custom' }, 'изменён')),
      h('div', { class: 'small' }, v.change_note || '—'),
      h('div', { class: 'v-meta' }, `${fmtDate(v.created_at)} · ${actorLabel(v.created_by)} · ${SOURCE[v.source] || v.source}`),
      h('div', { class: 'v-meta' }, `${v.criteria_count} критериев · сумма весов ${fmtScore(v.weights_sum)}`)))));

  const main = h('div', { class: 'card' });
  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Управление чек-листом'),
      h('div', { class: 'sub' }, 'Каждое сохранение создаёт новую неизменяемую версию. Оценка хранит снимок использованной версии — прошлые результаты не меняются задним числом.'))),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(260px, 320px) minmax(0, 1fr)' } }, versionsCard, main));

  function renderMain() {
    clear(main);
    if (state.mode === 'view') main.append(...viewMode());
    else main.append(...editMode());
  }

  // ------------------------------------------------------------------ view
  function viewMode() {
    const cl = version.checklist;
    const isActive = version.status === 'active';
    const sections = new Map(cl.sections.map((s) => [s.id, s.name]));
    return [
      h('div', { class: 'card-head' },
        h('h3', {}, `${cl.name} · v${version.version}`), isActive ? h('span', { class: 'chip brand' }, 'активная') : h('span', { class: 'chip' }, 'архивная'),
        cl.official ? h('span', { class: 'badge-official' }, 'официальный') : h('span', { class: 'badge-custom' }, 'изменён'),
        h('div', { class: 'spacer' }),
        !isActive ? h('button', { class: 'btn sm', onclick: () => showDiff(list.active_version, version.version) }, icon('eye'), `Сравнить с v${list.active_version}`) : null,
        version.parent_version ? h('button', { class: 'btn sm', onclick: () => showDiff(version.parent_version, version.version) }, icon('eye'), `Изменения от v${version.parent_version}`) : null,
        h('button', { class: 'btn sm', onclick: () => downloadJson(`checklist-v${version.version}.json`, cl) }, icon('download'), 'Экспорт JSON'),
        !isActive ? h('button', { class: 'btn sm', onclick: activate }, icon('check'), 'Сделать активной') : null,
        h('button', { class: 'btn sm primary', onclick: startEdit }, icon('edit'), 'Изменить → новая версия')),
      h('div', { class: 'card-body col gap-12' },
        h('div', { class: 'small dim' }, cl.description),
        cl.source ? h('div', { class: 'xs muted' }, `Источник: ${cl.source}`) : null,
        h('div', { class: 'xs muted' }, `Создана: ${fmtDate(version.created_at)} · ${actorLabel(version.created_by)}${version.change_note ? ` · «${version.change_note}»` : ''}`),
        h('div', { class: 'row wrap' },
          h('span', { class: 'chip outline' }, `N/A: ${meta.na_policies[cl.scoring.na_policy]}`),
          h('span', { class: 'chip outline' }, `Округление: ${meta.rounding_modes[cl.scoring.rounding.mode]}, ${cl.scoring.rounding.decimals} зн.`),
          h('span', { class: 'chip outline' }, `Грубые ошибки: ${meta.critical_policies[cl.scoring.critical_policy]}`),
          Object.entries(cl.parameters || {}).map(([k, v]) => h('span', { class: 'chip outline' }, `${k === 'first_response_threshold_sec' ? 'Порог первой реакции' : k}: ${v}${k.endsWith('_sec') ? ' с' : ''}`))),
        weightsBar(cl),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['№', 'Критерий', 'Секция', 'Ответ / шкала', 'Вес', 'N/A', 'Офлайн-детектор', 'Режим'].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x)))),
          h('tbody', {}, cl.criteria.map((c) => h('tr', { class: c.enabled ? '' : 'muted' },
            h('td', { class: 'mono' }, c.code),
            h('td', {}, h('b', {}, c.name), c.enabled ? null : h('span', { class: 'chip' }, 'отключён'), h('div', { class: 'xs muted' }, c.description)),
            h('td', { class: 'small' }, sections.get(c.section_id) || '—'),
            h('td', { class: 'small' }, c.scoring_role === 'flag' ? 'Да / Нет · флаг без баллов' : answerSummary(c)),
            h('td', { class: 'num' }, c.scoring_role === 'flag' ? '—' : fmtScore(c.weight)),
            h('td', { class: 'small' }, c.na_allowed ? h('span', { title: c.na_condition }, 'да') : 'нет'),
            h('td', { class: 'small' }, c.detector ? meta.detectors.find((d) => d.type === c.detector.type)?.name || c.detector.type : h('span', { class: 'muted' }, 'только AI')),
            h('td', { class: 'small' }, { auto: 'авто', llm: 'только AI', rules: 'офлайн' }[c.evaluation_mode])))))),
        cl.risk_rules?.length ? h('div', {}, h('h4', {}, 'Дополнительные сигналы риска (вне чек-листа, не влияют на балл)'),
          h('div', { class: 'col mt-8' }, cl.risk_rules.map((r) => h('div', { class: 'small' }, h('span', { class: `chip ${r.enabled ? 'warning' : ''}` }, r.enabled ? 'вкл' : 'выкл'), ' ', h('b', {}, r.name), h('span', { class: 'dim' }, ` — ${r.description}`))))) : null,
        cl.instructions ? h('details', {}, h('summary', { class: 'small dim' }, 'Инструкции к оценке (передаются AI-модели)'), h('pre', { class: 'formula mt-8' }, cl.instructions)) : null,
        cl.notes ? h('div', { class: 'banner info' }, icon('info'), h('div', {}, cl.notes)) : null),
    ];
  }

  function answerSummary(c) {
    if (c.answer_type === 'binary') return `${c.binary.yes_label} / ${c.binary.no_label}`;
    if (c.answer_type === 'scale') return `шкала ${c.scale.min}–${c.scale.max}${c.scale.steps?.length ? `: ${c.scale.steps.map((s) => s.value).join(' / ')}` : ''}`;
    return c.options.map((o) => `${o.label} (${o.score})`).join(' / ');
  }

  function weightsBar(cl) {
    const w = cl.criteria.filter((c) => c.enabled && c.scoring_role === 'weighted');
    const sum = w.reduce((s, c) => s + (Number(c.weight) || 0), 0) || 1;
    return h('div', {},
      h('div', { class: 'xs muted mt-4' }, `Веса (сумма ${fmtScore(sum)}; итог приводится к ${cl.scoring.max_score})`),
      h('div', { class: 'weights-bar mt-4' }, w.map((c) => {
        const d = h('div', { title: `${c.code} ${c.name}: ${c.weight}` }, `${c.code} · ${c.weight}`);
        d.style.flex = `${Number(c.weight) || 0.0001} 1 0`;
        return d;
      })));
  }

  async function activate() {
    try {
      await api.post(`/api/checklists/${version.version}/activate`);
      toast(`Версия v${version.version} активна`, 'good');
      window.dispatchEvent(new CustomEvent('cqa:refresh-system'));
      await offerReevaluation(version.version);
      navigate(`/checklists/${version.version}`);
    } catch (e) { errorToast(e); }
  }

  async function showDiff(from, to) {
    try {
      const d = await api.get(`/api/checklists/diff?from=${from}&to=${to}`);
      const FIELD = { name: 'Название', description: 'Описание', guidance: 'Пояснение', section_id: 'Секция', weight: 'Вес', answer_type: 'Тип ответа', scoring_role: 'Роль', na_allowed: 'N/A разрешён', na_condition: 'Условие N/A', enabled: 'Включён', evaluation_mode: 'Режим оценки', scale: 'Шкала', options: 'Варианты', binary: 'Подписи Да/Нет', detector: 'Офлайн-детектор', flag_subtypes: 'Подтипы нарушений' };
      const show = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—'));
      await openModal((close) => ({
        title: `Изменения: v${from} → v${to}`,
        body: [
          !d.added.length && !d.removed.length && !d.changed.length && !d.settings.length ? h('div', { class: 'muted' }, 'Версии идентичны') : null,
          d.added.length ? h('div', {}, h('h4', {}, 'Добавлены'), d.added.map((c) => h('div', { class: 'small' }, `+ ${c.code} ${c.name}`))) : null,
          d.removed.length ? h('div', {}, h('h4', {}, 'Удалены'), d.removed.map((c) => h('div', { class: 'small' }, `− ${c.code} ${c.name}`))) : null,
          d.changed.length ? h('div', {}, h('h4', {}, 'Изменены'), d.changed.map((c) => h('div', { class: 'mt-8' }, h('b', { class: 'small' }, `${c.code} ${c.name}`),
            c.fields.map((f) => h('div', { class: 'xs' }, h('span', { class: 'muted' }, `${FIELD[f.field] || f.field}: `), h('span', { class: 'delta down' }, show(f.before).slice(0, 300)), ' → ', h('span', { class: 'delta up' }, show(f.after).slice(0, 300))))))) : null,
          d.settings.length ? h('div', {}, h('h4', {}, 'Настройки'), d.settings.map((s) => h('div', { class: 'xs' }, s.field))) : null,
        ],
        footer: [h('button', { class: 'btn', onclick: () => close() }, 'Закрыть')],
      }), { wide: true });
    } catch (e) { errorToast(e); }
  }

  function importButton() {
    const input = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      const text = await file.text();
      const activate = await confirmModal('Импорт чек-листа', `Файл «${file.name}» будет проверен и сохранён как новая версия. Сделать её активной сразу?`, { okLabel: 'Импортировать и активировать' });
      try {
        const v = await api.post('/api/checklists/import', { checklist: text, activate: Boolean(activate), change_note: `Импорт из ${file.name}` });
        toast(`Импортирована версия v${v.version}${v.warnings?.length ? ` (предупреждений: ${v.warnings.length})` : ''}`, 'good');
        window.dispatchEvent(new CustomEvent('cqa:refresh-system'));
        if (activate) await offerReevaluation(v.version);
        navigate(`/checklists/${v.version}`);
      } catch (e) {
        showValidation(e);
      }
      input.value = '';
    });
    return h('span', {}, input, h('button', { class: 'btn sm', onclick: () => input.click() }, icon('upload'), 'Импорт JSON'));
  }

  function showValidation(e) {
    const errs = e.details?.errors || [];
    if (!errs.length) { errorToast(e); return; }
    openModal((close) => ({
      title: 'Чек-лист не прошёл проверку',
      body: h('div', { class: 'errors' }, errs.map((x) => h('div', { class: 'e' }, `${x.path}: ${x.message}`)), (e.details?.warnings || []).map((x) => h('div', { class: 'w' }, `${x.path}: ${x.message}`))),
      footer: [h('button', { class: 'btn', onclick: () => close() }, 'Понятно')],
    }));
  }

  // ------------------------------------------------------------------ edit
  function startEdit() {
    state.mode = 'edit';
    state.draft = clone(version.checklist);
    state.validation = null;
    renderMain();
  }

  function editMode() {
    const d = state.draft;
    const note = h('input', { class: 'input', placeholder: 'Что изменено (например: «Заменён критерий 05 по заданию организаторов»)' });
    note.style.flex = '1';
    const activateBox = h('input', { type: 'checkbox', checked: true });
    const valBox = h('div', { class: 'errors' });
    const weightsHost = h('div', {}, weightsBar(d));
    const refreshWeights = () => mount(weightsHost, weightsBar(d));

    const save = async () => {
      try {
        const payload = clone(d);
        payload.official = false;
        payload.source = `Изменено в интерфейсе на основе v${version.version}`;
        const v = await api.post('/api/checklists', { checklist: payload, change_note: note.value.trim() || 'Изменения в интерфейсе', activate: activateBox.checked, parent_version: version.version });
        toast(`Сохранена версия v${v.version}${activateBox.checked ? ' и сделана активной' : ''}`, 'good');
        window.dispatchEvent(new CustomEvent('cqa:refresh-system'));
        if (activateBox.checked) await offerReevaluation(v.version);
        navigate(`/checklists/${v.version}`);
      } catch (e) {
        showValidation(e);
      }
    };
    const validate = async () => {
      try {
        const r = await api.post('/api/checklists/validate', { checklist: d });
        mount(valBox, r.ok && !r.warnings.length ? h('div', { class: 'w' }, '✓ Ошибок нет') : null,
          r.errors.map((x) => h('div', { class: 'e' }, `${x.path}: ${x.message}`)), r.warnings.map((x) => h('div', { class: 'w' }, `${x.path}: ${x.message}`)));
      } catch (e) { errorToast(e); }
    };

    const scoring = h('div', { class: 'editor-block' },
      h('h4', {}, icon('chart'), 'Расчёт итога'),
      h('div', { class: 'form-grid' },
        selectField('Правило N/A', meta.na_policies, d.scoring.na_policy, (v) => { d.scoring.na_policy = v; }),
        selectField('Округление', meta.rounding_modes, d.scoring.rounding.mode, (v) => { d.scoring.rounding.mode = v; }),
        numField('Знаков после запятой', d.scoring.rounding.decimals, (v) => { d.scoring.rounding.decimals = v; }, { min: 0, max: 4, step: 1 }),
        selectField('Грубые ошибки', meta.critical_policies, d.scoring.critical_policy, (v) => { d.scoring.critical_policy = v; }),
        numField('Порог первой реакции, с', d.parameters?.first_response_threshold_sec ?? 180, (v) => { d.parameters = { ...(d.parameters || {}), first_response_threshold_sec: v }; }, { min: 0, step: 10 })),
      h('div', { class: 'xs muted' }, 'Официальные правила: N/A — пропорциональное перераспределение, итог до двух знаков, грубые ошибки отмечаются отдельно; порог первой реакции — 3 минуты (используется критерием 06, AI-промптом и аналитикой).'));

    const sectionsBlock = h('div', { class: 'editor-block' });
    const renderSections = () => {
      mount(sectionsBlock, h('h4', {}, icon('layers'), 'Секции'),
        d.sections.map((s, i) => h('div', { class: 'row' },
          textInput(s.name, (v) => { s.name = v; }, { placeholder: 'Название секции' }),
          h('span', { class: 'xs muted mono' }, s.id),
          h('button', { class: 'btn ghost sm icon-only', title: 'Удалить секцию (если пустая)', onclick: () => {
            if (d.criteria.some((c) => c.section_id === s.id)) { errorToast(new Error('В секции есть критерии — перенесите их перед удалением')); return; }
            d.sections.splice(i, 1);
            renderSections();
          } }, icon('trash')))),
        h('div', {}, h('button', { class: 'btn sm', onclick: () => { d.sections.push({ id: `section_${Date.now().toString(36).slice(-4)}`, name: 'Новая секция' }); renderSections(); renderCriteria(); } }, icon('plus'), 'Добавить секцию')));
    };
    renderSections();

    const critHost = h('div', { class: 'col gap-12' });
    const renderCriteria = () => {
      mount(critHost, d.criteria.map((c, i) => criterionEditor(c, i)),
        h('div', {}, h('button', { class: 'btn', onclick: addCriterion }, icon('plus'), 'Добавить критерий')));
    };

    function addCriterion() {
      const n = d.criteria.length + 1;
      const id = `custom_${Date.now().toString(36).slice(-5)}`;
      d.criteria.push({
        id, code: String(n).padStart(2, '0'), section_id: d.sections[0]?.id || null, name: 'Новый критерий', description: '', guidance: '',
        answer_type: 'binary', binary: { yes_label: 'Да', no_label: 'Нет' }, weight: 10, scoring_role: 'weighted', na_allowed: false, na_condition: '',
        enabled: true, evaluation_mode: 'auto', detector: null,
      });
      state.expanded.add(id);
      renderCriteria();
      refreshWeights();
    }

    function criterionEditor(c, i) {
      const orig = version.checklist.criteria.find((x) => x.id === c.id);
      const changed = !orig ? 'added' : JSON.stringify(orig) !== JSON.stringify(c) ? 'changed' : '';
      const body = h('div', { class: `crit-edit-body ${state.expanded.has(c.id) ? '' : 'hidden'}` });
      const box = h('div', { class: `crit-edit ${c.enabled ? '' : 'disabled'} ${changed}` },
        h('div', { class: 'crit-edit-head', onclick: (e) => {
          if (e.target.closest('button,input,label')) return;
          if (state.expanded.has(c.id)) state.expanded.delete(c.id); else state.expanded.add(c.id);
          body.classList.toggle('hidden');
        } },
        h('span', { class: 'mono muted' }, c.code), h('b', {}, c.name),
        changed === 'added' ? h('span', { class: 'chip brand' }, 'новый') : changed === 'changed' ? h('span', { class: 'chip info' }, 'изменён') : null,
        c.scoring_role === 'flag' ? h('span', { class: 'chip critical' }, 'флаг') : h('span', { class: 'chip outline' }, `вес ${c.weight}`),
        h('div', { class: 'spacer' }),
        h('label', { class: 'check xs' }, h('input', { type: 'checkbox', checked: c.enabled, onchange: (e) => { c.enabled = e.target.checked; renderCriteria(); refreshWeights(); } }), 'включён'),
        h('button', { class: 'btn ghost sm icon-only', title: 'Выше', disabled: i === 0, onclick: () => { d.criteria.splice(i - 1, 0, d.criteria.splice(i, 1)[0]); renderCriteria(); } }, icon('up')),
        h('button', { class: 'btn ghost sm icon-only', title: 'Ниже', disabled: i === d.criteria.length - 1, onclick: () => { d.criteria.splice(i + 1, 0, d.criteria.splice(i, 1)[0]); renderCriteria(); } }, icon('down')),
        h('button', { class: 'btn ghost sm icon-only', title: 'Удалить из новой версии', onclick: () => { d.criteria.splice(i, 1); renderCriteria(); refreshWeights(); } }, icon('trash'))),
        body);
      const rebuild = () => { mount(body, ...criterionFields(c, rebuild)); };
      rebuild();
      return box;
    }

    function criterionFields(c, rebuild) {
      const fields = [];
      fields.push(h('div', { class: 'form-grid' },
        field('Номер', textInput(c.code, (v) => { c.code = v; }, { maxlength: 10 })),
        field('ID (латиница)', textInput(c.id, (v) => { c.id = v.trim(); }, { maxlength: 40, title: 'Используется в оценках и апелляциях; при замене критерия задайте новый ID' })),
        selectField('Секция', Object.fromEntries(d.sections.map((s) => [s.id, s.name])), c.section_id, (v) => { c.section_id = v; }),
        selectField('Роль', { weighted: 'С весом (в итоге)', flag: 'Флаг без баллов (грубые ошибки)' }, c.scoring_role, (v) => {
          c.scoring_role = v;
          if (v === 'flag') { c.answer_type = 'binary'; c.binary = c.binary || { yes_label: 'Да', no_label: 'Нет' }; c.weight = 0; c.flag_subtypes = c.flag_subtypes || []; }
          else if (!c.weight) c.weight = 10;
          rebuild(); refreshWeights();
        }),
        c.scoring_role === 'weighted' ? numField('Вес', c.weight, (v) => { c.weight = v; refreshWeights(); }, { min: 0, step: 1 }) : null));
      fields.push(field('Название', textInput(c.name, (v) => { c.name = v; }, { maxlength: 200 })));
      fields.push(field('Описание (что считается выполнением — передаётся AI дословно)', textArea(c.description, (v) => { c.description = v; })));
      fields.push(field('Пояснение для единообразной оценки (необязательно)', textArea(c.guidance, (v) => { c.guidance = v; }, 3)));

      if (c.scoring_role === 'weighted') {
        fields.push(selectField('Тип ответа', meta.answer_types, c.answer_type, (v) => {
          c.answer_type = v;
          if (v === 'binary' && !c.binary) c.binary = { yes_label: 'Да', no_label: 'Нет' };
          if (v === 'scale' && !c.scale) c.scale = { min: 0, max: 10, steps: [{ value: 10, label: 'Полностью' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Не выполнено' }] };
          if (v === 'options' && !c.options) c.options = [{ value: 'full', label: 'Выполнено', score: 1 }, { value: 'partial', label: 'Частично', score: 0.5 }, { value: 'none', label: 'Не выполнено', score: 0 }];
          rebuild();
        }));
      }
      if (c.answer_type === 'binary') {
        fields.push(h('div', { class: 'form-grid' },
          field('Подпись «Да»', textInput(c.binary.yes_label, (v) => { c.binary.yes_label = v; })),
          field('Подпись «Нет»', textInput(c.binary.no_label, (v) => { c.binary.no_label = v; }))));
      } else if (c.answer_type === 'scale') {
        const steps = h('div', { class: 'steps-edit' });
        const renderSteps = () => mount(steps,
          h('div', { class: 'xs muted' }, 'Ступени шкалы (верхняя ступень = max даёт полный вес; балл = значение / max × вес)'),
          c.scale.steps.map((s, j) => h('div', { class: 'step-row' },
            numInput(s.value, (v) => { s.value = v; }), textInput(s.label, (v) => { s.label = v; }, { placeholder: 'Что означает ступень' }),
            h('span', { class: 'xs muted num' }, c.scale.max ? `${Math.round((s.value / c.scale.max) * 100)}%` : ''),
            h('button', { class: 'btn ghost sm icon-only', onclick: () => { c.scale.steps.splice(j, 1); renderSteps(); } }, icon('x')))),
          h('div', {}, h('button', { class: 'btn xs', onclick: () => { c.scale.steps.push({ value: 0, label: '' }); renderSteps(); } }, icon('plus'), 'Ступень')));
        c.scale.steps = c.scale.steps || [];
        renderSteps();
        fields.push(h('div', { class: 'form-grid' },
          numField('Минимум', c.scale.min, (v) => { c.scale.min = v; }), numField('Максимум', c.scale.max, (v) => { c.scale.max = v; renderSteps(); })), steps);
      } else if (c.answer_type === 'options') {
        const opts = h('div', { class: 'steps-edit' });
        const renderOpts = () => mount(opts,
          h('div', { class: 'xs muted' }, 'Варианты: значение, подпись, доля балла 0…1'),
          c.options.map((o, j) => h('div', { class: 'step-row' },
            textInput(o.value, (v) => { o.value = v; }), textInput(o.label, (v) => { o.label = v; }),
            numInput(o.score, (v) => { o.score = v; }, { step: 0.05, min: 0, max: 1 }),
            h('button', { class: 'btn ghost sm icon-only', onclick: () => { c.options.splice(j, 1); renderOpts(); } }, icon('x')))),
          h('div', {}, h('button', { class: 'btn xs', onclick: () => { c.options.push({ value: `opt${c.options.length + 1}`, label: 'Вариант', score: 0 }); renderOpts(); } }, icon('plus'), 'Вариант')));
        renderOpts();
        fields.push(opts);
      }
      if (c.scoring_role === 'flag') {
        fields.push(h('div', { class: 'xs muted' }, '«Да» означает, что нарушение выявлено. Критерий не даёт баллов и отмечается отдельно.'));
      }
      fields.push(h('div', { class: 'form-grid' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.na_allowed, onchange: (e) => { c.na_allowed = e.target.checked; rebuild(); } }), 'N/A допускается'),
        c.na_allowed ? field('Условие N/A', textInput(c.na_condition, (v) => { c.na_condition = v; })) : null));

      const detTypes = { '': '— нет (оценивает только AI)' };
      for (const det of meta.detectors) detTypes[det.type] = det.name;
      fields.push(h('div', { class: 'form-grid' },
        selectField('Режим оценки', meta.evaluation_modes, c.evaluation_mode, (v) => { c.evaluation_mode = v; }),
        selectField('Офлайн-детектор (без AI)', detTypes, c.detector?.type || '', (v) => {
          if (!v) c.detector = null;
          else {
            const def = meta.detectors.find((x) => x.type === v);
            c.detector = { type: v, params: { ...(def.params || {}) } };
          }
          rebuild();
        })));
      if (c.detector) {
        const def = meta.detectors.find((x) => x.type === c.detector.type);
        fields.push(h('div', { class: 'xs muted' }, def?.description || ''));
        for (const [k, dv] of Object.entries(def?.params || {})) {
          const label = { phrases: 'Фразы (по одной на строку; /regex/ поддерживается)', position: 'Где искать', first_response_sec: 'Порог первой реакции, с', silent_wait_sec: 'Ожидание без предупреждения, с', reply_gap_sec: 'Пауза перед ответом, с' }[k] || k;
          if (k === 'phrases') fields.push(field(label, textArea(c.detector.params[k] ?? dv, (v) => { c.detector.params[k] = v; }, 3)));
          else if (k === 'position') fields.push(selectField(label, { any: 'в любой реплике', first: 'в первой реплике', last: 'в последних репликах' }, c.detector.params[k] ?? dv, (v) => { c.detector.params[k] = v; }));
          else fields.push(numField(label, c.detector.params[k] ?? dv, (v) => { c.detector.params[k] = v; }));
        }
      } else if (c.evaluation_mode !== 'llm') {
        fields.push(h('div', { class: 'banner info' }, icon('info'), h('div', {}, 'Без детектора критерий оценивается AI-моделью по тексту описания. Если AI не подключён, критерий получит статус «не оценён» (без выдуманного балла) и попадёт на ручную проверку.')));
      }
      fields.push(h('div', { class: 'xs muted' }, `Допустимые ответы: ${allowedAnswers(c).map((a) => a.label).join(' / ')}${c.na_allowed ? ' / N/A' : ''}`));
      return fields;
    }

    renderCriteria();
    const nameInput = textInput(d.name, (v) => { d.name = v; }, { maxlength: 200 });
    return [
      h('div', { class: 'card-head' }, h('h3', {}, `Редактирование → новая версия (на основе v${version.version})`), h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost sm', onclick: () => { state.mode = 'view'; renderMain(); } }, 'Отмена')),
      h('div', { class: 'editor' },
        h('div', { class: 'banner info' }, icon('info'), h('div', {}, 'Изменённая версия перестаёт считаться официальной. После сохранения с активацией система предложит переоценить диалоги — новый текст критериев сразу уходит в AI-оценку, а офлайн-детекторы применяют новые веса, шкалы и фразы.')),
        field('Название чек-листа', nameInput),
        scoring, sectionsBlock,
        h('div', { class: 'editor-block' }, h('h4', {}, icon('checklist'), 'Критерии'), weightsHost, critHost),
        h('div', { class: 'editor-block' },
          h('div', { class: 'row wrap' }, note, h('label', { class: 'check' }, activateBox, 'сделать активной')),
          valBox,
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: validate }, icon('check'), 'Проверить'), h('div', { class: 'spacer' }),
            h('button', { class: 'btn primary', onclick: save }, icon('download'), 'Сохранить как новую версию')))),
    ];
  }

  renderMain();
}

async function offerReevaluation(versionNumber) {
  const choice = await openModal((close) => ({
    title: `Применить чек-лист v${versionNumber}`,
    body: [h('p', { class: 'dim' }, 'Новая версия активна. Переоценить диалоги активного набора по ней? Старые оценки сохранятся в истории; в карточке диалога будет показано, что изменилось.')],
    footer: [
      h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Позже'),
      h('button', { class: 'btn', onclick: () => close('outdated') }, 'Переоценить устаревшие'),
      h('button', { class: 'btn primary', onclick: () => close('all') }, icon('refresh'), 'Переоценить все'),
    ],
  }));
  if (!choice) return;
  try {
    const job = await api.post('/api/evaluations/batch', { scope: choice });
    toast(`Переоценка запущена: ${job.total} диалогов`, 'info');
    const poll = async () => {
      const j = await api.get(`/api/jobs/${job.id}`);
      if (j.status === 'running') { setTimeout(poll, 700); return; }
      toast(`Переоценка завершена: ${j.done - j.failed} из ${j.total}`, j.failed ? 'error' : 'good');
    };
    poll();
  } catch (e) { errorToast(e); }
}

// ---- small form helpers ----
function field(label, control) {
  return h('label', { class: 'field' }, h('span', {}, label), control);
}
function textInput(value, onInput, attrs = {}) {
  return h('input', { class: 'input', value: value ?? '', ...attrs, oninput: (e) => onInput(e.target.value) });
}
function textArea(value, onInput, rows = 2) {
  const t = h('textarea', { class: 'textarea', rows, oninput: (e) => onInput(e.target.value) });
  t.value = value ?? '';
  t.style.minHeight = `${rows * 22 + 16}px`;
  return t;
}
function numInput(value, onInput, attrs = {}) {
  return h('input', { class: 'input', type: 'number', value: String(value ?? 0), ...attrs, oninput: (e) => onInput(Number(e.target.value)) });
}
function numField(label, value, onInput, attrs) {
  return field(label, numInput(value, onInput, attrs));
}
function selectField(label, options, value, onChange) {
  const s = h('select', { class: 'select' }, Object.entries(options).map(([v, l]) => h('option', { value: v, selected: v === (value ?? '') }, l)));
  s.addEventListener('change', () => onChange(s.value));
  return field(label, s);
}
