#!/usr/bin/env node
// Pre-submission check (run before the 23rd hour and before git push):
// config (team, model, API) without printing secrets, results files, git repository, remote reachability.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig, resolveProvider } from '../server/config.js';
import { ClaudeCodeCliProvider, STRIPPED_ENV } from '../server/evaluation/providers/claude-code-cli.js';
import { passedSample } from '../server/results/model-check.js';

const cfg = loadConfig();
const ok = (m) => console.log(`✔ ${m}`);
const bad = (m) => { console.log(`✖ ${m}`); process.exitCode = 1; };
const info = (m) => console.log(`• ${m}`);
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();

console.log('— Настройки (значения секретов не выводятся)');
cfg.teamName ? ok(`TEAM_NAME: «${cfg.teamName}»`) : bad('TEAM_NAME не задан в .env');
const provider = resolveProvider(cfg);
if (provider === 'anthropic') ok(`модель: Anthropic API, ${cfg.ai.anthropic.model} (ключ задан)`);
else if (provider === 'openai') ok(`модель: OpenAI-совместимый API ${new URL(cfg.ai.openai.baseUrl).host}, ${cfg.ai.openai.model}`);
else if (provider === 'claude-code-cli') {
  const p = new ClaudeCodeCliProvider(cfg);
  try {
    const pf = await p.preflight();
    ok(`модель: Claude Code CLI ${pf.version || ''}, ${cfg.ai.claudeCode.model}; вход через подписку Claude${pf.auth.subscriptionType ? ` (${pf.auth.subscriptionType})` : ''}`);
  } catch (e) { bad(`Claude Code: ${e.message}`); }
  const present = STRIPPED_ENV.filter((k) => process.env[k]);
  if (present.length) info(`в окружении терминала есть ${present.join(', ')} — для Claude Code они убираются, используется только подписка`);
  passedSample(cfg, p.info) ? ok('пробный прогон RU/KZ/EN пройден (npm run check:model)') : info('пробный прогон ещё не пройден: npm run check:model, затем npm run check:model -- --sample');
}
else bad('модель не подключена (нет AI_PROVIDER=claude-code-cli, ANTHROPIC_API_KEY или OPENAI_MODEL) — файлы результатов не будут сформированы');
cfg.dataset.apiUrl ? ok(`DATASET_API_URL задан (хост ${new URL(cfg.dataset.apiUrl).host})`) : bad('DATASET_API_URL не задан — PROD не получить из API (останется только --file)');

console.log('— Файлы результатов');
for (const f of ['results/dev/results.json', 'results/prod/results.json']) existsSync(f) ? ok(`${f} есть`) : info(`${f} ещё нет`);

console.log('— Git');
try {
  git('rev-parse', '--is-inside-work-tree');
  ok(`репозиторий: ветка ${git('rev-parse', '--abbrev-ref', 'HEAD')}`);
  const remotes = git('remote', '-v');
  if (!remotes) bad('нет remote: git remote add origin <URL открытого репозитория>');
  else {
    ok(`remote: ${remotes.split('\n')[0].replace(/\/\/[^@/]+@/, '//***@')}`);
    try { git('ls-remote', '--heads', 'origin'); ok('origin доступен (ls-remote)'); } catch (e) { bad(`origin недоступен: ${String(e.stderr || e.message).split('\n')[0]}`); }
  }
  for (const f of ['results/dev/results.json', 'results/prod/results.json']) {
    try { git('check-ignore', '-q', f); bad(`${f} игнорируется .gitignore — не попадёт в репозиторий`); } catch { ok(`${f} не игнорируется`); }
  }
  for (const f of ['.env', 'data/datasets/DEV.raw.json']) {
    try { git('ls-files', '--error-unmatch', f); bad(`${f} в репозитории — там секреты/подписанные ссылки, удалите из индекса`); } catch { ok(`${f} не в репозитории`); }
  }
} catch (e) {
  bad(`не git-репозиторий или git недоступен (${String(e.stderr || e.message).split('\n')[0]})`);
}
