// Lightweight accessible charts (HTML/SVG). Thin marks, hairline axes, values as text tokens,
// hover tooltips that enhance (every value is also printed or available in a table).
import { h } from '../core/dom.js';

let tip = null;
function showTip(e, title, text) {
  if (!tip) {
    tip = h('div', { class: 'chart-tip', role: 'tooltip' });
    document.getElementById('app').appendChild(tip);
  }
  tip.replaceChildren(h('div', { class: 't' }, title), h('div', {}, text));
  tip.style.display = 'block';
  const x = Math.min(window.innerWidth - 300, e.clientX + 14);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
}
function hideTip() {
  if (tip) tip.style.display = 'none';
}
export function withTip(el, title, text) {
  el.addEventListener('mousemove', (e) => showTip(e, title, text));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    showTip({ clientX: r.left, clientY: r.bottom }, title, text);
  });
  el.addEventListener('blur', hideTip);
  return el;
}

/**
 * Horizontal bar list — one series, one colour; value printed at the bar tip.
 * items: [{label, value, sub?, onClick?, title?}]
 */
export function barList(items, { color = 'var(--series-1)', format = (v) => String(v), max } = {}) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value || 0));
  return h('div', { class: 'col gap-12' }, items.map((it) => {
    const fill = h('i');
    fill.style.display = 'block';
    fill.style.height = '10px';
    fill.style.borderRadius = '0 4px 4px 0';
    fill.style.background = color;
    fill.style.width = `${Math.max(it.value ? 1.5 : 0, ((it.value || 0) / m) * 100)}%`;
    const track = h('div', {});
    track.style.flex = '1';
    track.style.minWidth = '0';
    track.appendChild(fill);
    const row = h('div', {
      class: 'row', tabindex: it.onClick ? 0 : -1, role: it.onClick ? 'button' : undefined,
      onclick: it.onClick || null, onkeydown: it.onClick ? (e) => { if (e.key === 'Enter') it.onClick(); } : null,
    },
    h('div', { class: 'small dim' }, it.label), track,
    h('div', { class: 'small num nowrap' }, h('b', {}, format(it.value)), it.sub ? h('span', { class: 'muted' }, ` ${it.sub}`) : null));
    row.firstChild.style.width = '128px';
    row.firstChild.style.flex = 'none';
    row.lastChild.style.minWidth = '86px';
    row.lastChild.style.textAlign = 'right';
    if (it.onClick) row.style.cursor = 'pointer';
    return withTip(row, it.label, it.title || format(it.value));
  }));
}

/** Column chart (SVG) — e.g. score distribution. items: [{label, value, onClick}] */
export function columnChart(items, { height = 180, color = 'var(--series-1)', format = (v) => String(v) } = {}) {
  const W = 420;
  const padT = 22;
  const padB = 26;
  const plotH = height - padT - padB;
  const max = Math.max(1, ...items.map((i) => i.value));
  const band = W / items.length;
  const barW = Math.min(24, band * 0.42);
  const svg = h('svg:svg', { viewBox: `0 0 ${W} ${height}`, class: 'chart', role: 'img', 'aria-label': items.map((i) => `${i.label}: ${format(i.value)}`).join('; ') });
  const ticks = 4;
  for (let t = 0; t <= ticks; t += 1) {
    const y = padT + plotH - (plotH * t) / ticks;
    svg.appendChild(h('svg:line', { x1: 0, x2: W, y1: y, y2: y, class: t === 0 ? 'axis-line' : 'grid-line' }));
  }
  items.forEach((it, i) => {
    const x = band * i + band / 2 - barW / 2;
    const bh = (it.value / max) * plotH;
    const y = padT + plotH - bh;
    const g = h('svg:g', { tabindex: 0, role: 'button' });
    if (bh > 0) {
      // 4px rounded data-end, square at the baseline
      const r = Math.min(4, bh);
      g.appendChild(h('svg:path', {
        class: 'bar', fill: color,
        d: `M${x},${padT + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${padT + plotH} Z`,
      }));
    }
    g.appendChild(h('svg:text', { x: x + barW / 2, y: y - 6, 'text-anchor': 'middle', class: 'val' }, format(it.value)));
    g.appendChild(h('svg:text', { x: band * i + band / 2, y: height - 8, 'text-anchor': 'middle', class: 'lbl' }, it.label));
    g.appendChild(h('svg:rect', { x: band * i, y: padT, width: band, height: plotH, class: 'hit' }));
    if (it.onClick) g.addEventListener('click', it.onClick);
    withTip(g, it.label, `${format(it.value)}${it.title ? ` · ${it.title}` : ''}`);
    svg.appendChild(g);
  });
  return svg;
}

/**
 * Thin segmented bar (part of a whole). segments: [{label, value, color}]
 * Zero parts draw nothing; 2px surface gaps separate parts (CSS gap).
 */
export function segmentedBar(segments, { title = '' } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const bar = h('div', { class: 'stackbar', role: 'img', 'aria-label': `${title}: ${segments.map((s) => `${s.label} ${s.value}`).join(', ')}` });
  for (const s of segments) {
    if (!s.value) continue;
    const i = h('i', { tabindex: 0 });
    i.style.width = `${(s.value / total) * 100}%`;
    i.style.background = s.color;
    withTip(i, title || s.label, `${s.label}: ${s.value} (${Math.round((s.value / total) * 100)}%)`);
    bar.appendChild(i);
  }
  return bar;
}

export function legend(items) {
  return h('div', { class: 'legend' }, items.map((it) => {
    const sw = h('i');
    sw.style.background = it.color;
    return h('span', {}, sw, it.label);
  }));
}

/** Ring gauge for a score 0..max. */
export function scoreRing(total, { max = 100, tone = 'good', sub = 'из 100' } = {}) {
  const R = 36;
  const C = 2 * Math.PI * R;
  const share = Number.isFinite(total) ? Math.max(0, Math.min(1, total / max)) : 0;
  const colors = { good: 'var(--good)', warning: 'var(--warning)', serious: 'var(--serious)', critical: 'var(--critical)', none: 'var(--neutral)' };
  const svg = h('svg:svg', { viewBox: '0 0 84 84', 'aria-hidden': 'true' },
    h('svg:circle', { cx: 42, cy: 42, r: R, fill: 'none', stroke: 'var(--surface-4)', 'stroke-width': 7 }),
    h('svg:circle', { cx: 42, cy: 42, r: R, fill: 'none', stroke: colors[tone] || colors.good, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${C * share} ${C}` }));
  return h('div', { class: 'score-ring', role: 'img', 'aria-label': `Итоговый балл ${Number.isFinite(total) ? total : 'не рассчитан'} ${sub}` },
    svg, h('div', { class: 'v' }, h('div', {}, h('b', {}, Number.isFinite(total) ? String(total).replace('.', ',') : '—'), h('small', {}, sub))));
}
