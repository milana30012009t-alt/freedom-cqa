// App bootstrap: navigation, role switch, routing, embed mode for Dynamics 365.
import { h, mount, $ } from './core/dom.js';
import { icon, brandMark } from './core/icons.js';
import { route, resolve, navigate } from './core/router.js';
import { store } from './core/store.js';
import { api } from './core/api.js';
import { errorToast } from './core/ui.js';

const NAV = [
  { path: '/', label: 'Обзор', icon: 'dashboard', match: (p) => p === '/' },
  { path: '/conversations', label: 'Диалоги', icon: 'chats', match: (p) => p.startsWith('/conversations') || p.startsWith('/c/') },
  { path: '/appeals', label: 'Апелляции', icon: 'scale', match: (p) => p.startsWith('/appeals'), badge: 'appeals' },
  { path: '/checklists', label: 'Чек-лист', icon: 'checklist', match: (p) => p.startsWith('/checklists') },
  { path: '/analytics', label: 'Аналитика', icon: 'chart', match: (p) => p.startsWith('/analytics') },
  { path: '/data', label: 'Данные и AI', icon: 'database', match: (p) => p.startsWith('/data') },
];

route('/', () => import('./pages/dashboard.js'));
route('/conversations', () => import('./pages/conversations.js'));
route('/c/:uid', () => import('./pages/conversation.js'));
route('/appeals', () => import('./pages/appeals.js'));
route('/appeals/:id', () => import('./pages/appeals.js'));
route('/checklists', () => import('./pages/checklists.js'));
route('/checklists/:version', () => import('./pages/checklists.js'));
route('/analytics', () => import('./pages/analytics.js'));
route('/data', () => import('./pages/data.js'));

function renderNav(path) {
  const nav = $('#nav');
  mount(nav,
    h('div', { class: 'nav-label' }, 'Контроль качества'),
    NAV.map((n) => {
      const badge = n.badge === 'appeals' && store.state.appealsOpen ? h('span', { class: 'count' }, String(store.state.appealsOpen)) : null;
      return h('a', { href: `#${n.path}`, class: n.match(path) ? 'active' : '' }, icon(n.icon), n.label, badge);
    }));
}

function renderFoot() {
  const s = store.state.system;
  if (!s) return;
  const ai = s.engine.ai_available;
  const ds = s.dataset;
  const g = ds.groups.find((x) => x.group_id === ds.active_group);
  mount($('#sidebar-foot'),
    h('a', { class: 'status-line', href: '#/data', title: 'Движок оценки' },
      h('span', { class: `dot ${ai ? 'on' : 'warn'}` }),
      ai ? `AI: ${s.engine.ai.label}` : 'Офлайн-правила (AI не подключён)'),
    h('a', { class: 'status-line', href: '#/data', title: 'Набор данных' },
      h('span', { class: `dot ${g ? 'on' : 'off'}` }), g ? `Набор ${g.group_id} · ${g.record_count} диалогов` : 'Данные не загружены'),
    s.checklist ? h('a', { class: 'status-line', href: '#/checklists', title: 'Активный чек-лист' },
      h('span', { class: 'dot on' }), `Чек-лист v${s.checklist.version}${s.checklist.official ? ' · официальный' : ' · изменён'}`) : null);
}

function renderTopbar() {
  const roleSwitch = h('div', { class: 'segmented role', role: 'group', 'aria-label': 'Роль (демо, без авторизации)' },
    [['specialist', 'Специалист КК'], ['reviewer', 'Проверяющий']].map(([v, label]) => h('button', {
      class: store.state.role === v ? 'active' : '', 'data-value': v, title: v === 'reviewer' ? 'Рассматривает апелляции и меняет оценки' : 'Подаёт апелляции на оценки',
      onclick: () => { store.set({ role: v }); renderTopbar(); window.dispatchEvent(new CustomEvent('cqa:role')); },
    }, icon(v === 'reviewer' ? 'gavel' : 'user'), label)));
  const nameInput = h('input', {
    class: 'input sm', placeholder: 'Ваше имя', value: store.state.userName, maxlength: 40, 'aria-label': 'Имя для истории действий',
    onchange: (e) => store.set({ userName: e.target.value.trim() }),
  });
  nameInput.style.width = '130px';
  mount($('#topbar-actions'), nameInput, roleSwitch);
}

export async function refreshSystem() {
  try {
    const [system, appeals] = await Promise.all([api.get('/api/system'), api.get('/api/appeals?status=new,pending')]);
    store.set({ system, appealsOpen: appeals.items.length });
    renderFoot();
    renderNav(location.hash.replace(/^#/, '').split('?')[0] || '/');
  } catch (e) {
    errorToast(e);
  }
}

function initEmbed() {
  const params = new URLSearchParams(location.search);
  if (params.get('embed') === '1') document.getElementById('app').classList.add('embed');
}

/** Dynamics 365 passes custom parameters to web resources in the "data" query parameter. */
function openRequestedConversation() {
  const params = new URLSearchParams(location.search);
  const conv = (params.get('conversation') || params.get('data') || '').trim();
  if (!conv || location.hash) return;
  const group = store.state.system?.dataset?.active_group || 'DEV';
  // replaceState: no extra hashchange event, the first render below opens the card
  history.replaceState(null, '', `${location.pathname}${location.search}#/c/${encodeURIComponent(conv.includes(':') ? conv : `${group}:${conv}`)}`);
}

async function start() {
  initEmbed();
  mount($('#brand-mark'), brandMark());
  renderTopbar();
  renderNav('/');
  const view = $('#view');
  const go = () => resolve(view, (pattern) => {
    renderNav(location.hash.replace(/^#/, '').split('?')[0] || '/');
    view.focus({ preventScroll: true });
  }).catch((e) => { errorToast(e); });
  window.addEventListener('hashchange', go);
  window.addEventListener('cqa:refresh-system', refreshSystem);
  await refreshSystem();
  openRequestedConversation();
  await go();
}

start();
export { navigate };
