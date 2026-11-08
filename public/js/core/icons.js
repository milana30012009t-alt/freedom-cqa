// Small original line-icon set (24×24, stroke = currentColor).
import { h } from './dom.js';

const P = {
  dashboard: ['M4 4h7v7H4z', 'M13 4h7v4h-7z', 'M13 10h7v10h-7z', 'M4 13h7v7H4z'],
  chats: ['M4 5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M20 9h0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v2l-3-2h-3'],
  scale: ['M12 4v16', 'M7 20h10', 'M5 7h14', 'M5 7l-3 6a3 3 0 0 0 6 0z', 'M19 7l-3 6a3 3 0 0 0 6 0z'],
  checklist: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M3.5 6l1.5 1.5L7.5 5', 'M3.5 12l1.5 1.5L7.5 11', 'M3.5 18l1.5 1.5L7.5 17'],
  chart: ['M4 20V4', 'M4 20h16', 'M8 16v-5', 'M12 16V8', 'M16 16v-3', 'M20 16V6'],
  database: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6'],
  phone: ['M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z'],
  message: ['M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z'],
  alert: ['M12 3l10 18H2z', 'M12 10v5', 'M12 18h0'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  check: ['M5 12l4.5 4.5L19 7'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  play: ['M8 5v14l11-7z'],
  pause: ['M8 5v14', 'M16 5v14'],
  back: ['M15 5l-7 7 7 7'],
  next: ['M9 5l7 7-7 7'],
  down: ['M6 9l6 6 6-6'],
  up: ['M6 15l6-6 6 6'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'],
  download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v6', 'M12 7.5h0'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  copy: ['M8 8h11v12H8z', 'M5 16V4h11'],
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  sparkle: ['M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'],
  cpu: ['M7 7h10v10H7z', 'M10 3v4', 'M14 3v4', 'M10 17v4', 'M14 17v4', 'M3 10h4', 'M3 14h4', 'M17 10h4', 'M17 14h4'],
  rewind: ['M11 7l-6 5 6 5z', 'M19 7l-6 5 6 5z'],
  forward: ['M13 7l6 5-6 5z', 'M5 7l6 5-6 5z'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  layers: ['M12 3l9 5-9 5-9-5z', 'M3 13l9 5 9-5'],
  wave: ['M3 12h3l2.5-6 4 12 3-8 1.5 2H21'],
  lock: ['M6 11h12v10H6z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  gavel: ['M14 5l5 5', 'M12 7l5 5', 'M13 6l-6 6 3 3 6-6', 'M8 14l-5 5'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  filter: ['M4 5h16l-6 7v6l-4 2v-8z'],
};

export function icon(name, cls = '') {
  const svg = h('svg:svg', { viewBox: '0 0 24 24', class: `icon ${cls}`.trim(), 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const d of P[name] || P.info) {
    svg.appendChild(h('svg:path', { d, fill: name === 'play' || name === 'rewind' || name === 'forward' || name === 'sparkle' ? 'currentColor' : 'none' }));
  }
  return svg;
}

export function brandMark() {
  const svg = h('svg:svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  svg.appendChild(h('svg:path', { d: 'M3 13h3l2.5-6 4 11 3-8 1.5 3H21' }));
  return svg;
}
