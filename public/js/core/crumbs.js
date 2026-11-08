import { h, mount, $ } from './dom.js';
import { icon } from './icons.js';

/** setCrumbs(['Диалоги', '#/conversations'], 'p1-ru-001') */
export function setCrumbs(...items) {
  const nodes = [];
  items.forEach((it, i) => {
    if (i) nodes.push(icon('next'));
    if (Array.isArray(it)) nodes.push(h('a', { href: it[1] }, it[0]));
    else nodes.push(h('strong', {}, it));
  });
  mount($('#crumbs'), nodes);
  document.title = `${typeof items[items.length - 1] === 'string' ? items[items.length - 1] : items[items.length - 1][0]} · Freedom CQA`;
}
