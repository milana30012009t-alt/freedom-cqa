#!/usr/bin/env node
// Evaluate conversations from the command line (useful before the demo).
// Usage: npm run evaluate -- [--group DEV] [--engine auto|ai|rules] [--all]
import { loadConfig } from '../server/config.js';
import { createServices, initServices } from '../server/app.js';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const cfg = loadConfig();
cfg.dataset.autoload = false;
const s = createServices(cfg);
await initServices(s);
const group = opt('group', s.datasets.status().active_group);
const engine = opt('engine', 'auto');
const convs = s.datasets.conversations(group).filter((c) => args.includes('--all') || !s.evaluations.latestFor(c.uid));
console.log(`Набор ${group}: к оценке ${convs.length} диалогов, движок: ${engine === 'rules' ? 'rules' : s.evaluations.engineInfo().default_engine}`);
let done = 0;
let cost = 0;
const queue = [...convs];
const concurrency = engine !== 'rules' && s.evaluations.engineInfo().ai_available ? cfg.ai.concurrency : 1;
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
  while (queue.length) {
    const c = queue.shift();
    try {
      const e = await s.evaluations.evaluate(c.uid, { engine, actor: { role: 'system', name: 'CLI' } });
      cost += e.usage.cost_usd || 0;
      done += 1;
      const gross = e.score_final.gross_error ? ' ГРУБАЯ ОШИБКА' : '';
      console.log(`${String(done).padStart(3)}. ${c.conversation_id.padEnd(10)} ${String(e.score_final.total ?? '—').padStart(6)}${gross} [${e.engine.used}${e.engine.fallback ? ', fallback' : ''}]`);
    } catch (err) {
      console.log(`ОШИБКА ${c.conversation_id}: ${err.message}`);
    }
  }
}));
console.log(`Готово: ${done}/${convs.length}. Стоимость AI: $${cost.toFixed(4)}`);
