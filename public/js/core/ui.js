// Toasts, modal dialogs and drawers.
import { h, mount, clear } from './dom.js';
import { icon } from './icons.js';

export function toast(message, kind = 'info', timeout = 4200) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: 'status' },
    icon(kind === 'good' ? 'check' : kind === 'error' ? 'alert' : 'info'), h('div', {}, message));
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove(); // keep the stack short
  setTimeout(() => el.remove(), timeout);
}

export function errorToast(e) {
  toast(e?.message || String(e), 'error', 6500);
}

/**
 * Open a modal dialog. `build(close)` returns {title, body, footer}.
 * Resolves with the value passed to close().
 */
export function openModal(build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}` });
    const close = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    const { title, body, footer } = build(close);
    mount(dlg,
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost sm icon-only', 'aria-label': 'Закрыть', onclick: () => close(null) }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.getElementById('app').appendChild(dlg);
    dlg.showModal();
  });
}

export function confirmModal(title, text, { okLabel = 'Подтвердить', danger = false } = {}) {
  return openModal((close) => ({
    title,
    body: h('p', { class: 'dim' }, text),
    footer: [
      h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Отмена'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel),
    ],
  }));
}

let activeDrawer = null;
export function openDrawer(build, { onClose } = {}) {
  closeDrawer({ silent: true }); // replacing a drawer is not a user "close"
  const backdrop = h('div', { class: 'drawer-backdrop', onclick: () => closeDrawer() });
  const body = h('div', { class: 'drawer-body' });
  const head = h('div', { class: 'drawer-head' });
  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true' }, head, body);
  const onKey = (e) => { if (e.key === 'Escape') closeDrawer(); };
  document.addEventListener('keydown', onKey);
  activeDrawer = { backdrop, drawer, onKey, onClose };
  document.getElementById('app').append(backdrop, drawer);
  const render = () => {
    const { title, actions, content } = build({ rerender: render, close: closeDrawer });
    mount(head, h('h3', {}, title), h('div', { class: 'spacer' }), actions || null,
      h('button', { class: 'btn ghost sm icon-only', 'aria-label': 'Закрыть', onclick: closeDrawer }, icon('x')));
    clear(body);
    const nodes = Array.isArray(content) ? content : [content];
    for (const n of nodes) if (n) body.appendChild(n);
  };
  render();
  return { rerender: render };
}

export function closeDrawer({ silent = false } = {}) {
  if (!activeDrawer) return;
  activeDrawer.backdrop.remove();
  activeDrawer.drawer.remove();
  document.removeEventListener('keydown', activeDrawer.onKey);
  const { onClose } = activeDrawer;
  activeDrawer = null;
  if (!silent) {
    try { onClose?.(); } catch { /* ignore */ }
  }
}

export function loading(text = 'Загрузка…') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), ` ${text}`);
}

export function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName), h('div', { class: 'dim' }, title), text ? h('div', { class: 'small' }, text) : null, action || null);
}
