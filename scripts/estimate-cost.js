#!/usr/bin/env node
// Estimate the AI cost of evaluating the loaded dataset with the active checklist.
// Usage: npm run estimate -- [--group DEV]
import { loadConfig } from '../server/config.js';
import { createServices, initServices } from '../server/app.js';
import { estimateBatch } from '../server/evaluation/cost.js';

const args = process.argv.slice(2);
const gi = args.indexOf('--group');
const cfg = loadConfig();
cfg.dataset.autoload = false;
const s = createServices(cfg);
await initServices(s);
const group = gi >= 0 ? args[gi + 1] : s.datasets.status().active_group;
const convs = s.datasets.conversations(group);
const active = s.checklists.getActive();
const p = cfg.ai.pricing;
const withCache = estimateBatch(convs, active.checklist, p, { promptCaching: true });
const noCache = estimateBatch(convs, active.checklist, p, { promptCaching: false });
const chats = convs.filter((c) => c.channel_type === 'chat');
const calls = convs.filter((c) => c.channel_type === 'call');
// average over all dialogs of the type, without cache (worst case for a single evaluation)
const one = (list) => estimateBatch(list, active.checklist, p, { promptCaching: false });
console.log(`Модель: ${cfg.ai.anthropic.model}; цены: вход $${p.inputPerMTok}/1M, выход $${p.outputPerMTok}/1M, чтение кэша $${p.cacheReadPerMTok}/1M`);
console.log(`Диалогов: ${convs.length} (чатов ${chats.length}, звонков ${calls.length}); вызовов на оценку: 1 (+1 повтор при невалидном ответе)`);
if (chats.length) console.log(`Один чат (в среднем): ~${one(chats).avg_input_tokens} вх. / ~${one(chats).avg_output_tokens} вых. токенов ≈ $${one(chats).per_evaluation_usd}`);
if (calls.length) console.log(`Один звонок (в среднем): ~${one(calls).avg_input_tokens} вх. / ~${one(calls).avg_output_tokens} вых. токенов ≈ $${one(calls).per_evaluation_usd}`);
console.log(`Весь набор: ≈ $${noCache.total_usd} без кэша, ≈ $${withCache.total_usd} с кэшированием промпта`);
