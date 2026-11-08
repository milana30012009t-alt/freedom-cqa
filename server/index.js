#!/usr/bin/env node
// Entry point: `npm start` (or `node server/index.js`).
import { loadConfig, resolveProvider } from './config.js';
import { createApp } from './app.js';
import { logger, setLogLevel, describeUrl } from './lib/logger.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  process.stderr.write(`Нужен Node.js 18 или новее (установлен ${process.versions.node}). На macOS: brew install node\n`);
  process.exit(1);
}

const cfg = loadConfig();
setLogLevel(cfg.logLevel);
const app = createApp(cfg);

await app.init();
app.server.listen(cfg.port, cfg.host, () => {
  const engine = resolveProvider(cfg);
  const status = app.services.datasets.status();
  logger.info(`CQA запущен: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  logger.info(`Оценка: ${engine === 'rules' ? 'офлайн-движок правил (AI-ключ не задан)' : `${engine} · ${engine === 'anthropic' ? cfg.ai.anthropic.model : engine === 'claude-code-cli' ? `${cfg.ai.claudeCode.model} (подписка Claude через Claude Code)` : cfg.ai.openai.model}`}`);
  logger.info(`Данные: ${status.groups.length ? status.groups.map((g) => `${g.group_id} (${g.record_count})`).join(', ') : 'не загружены'}; API: ${status.api_configured ? describeUrl(cfg.dataset.apiUrl) : 'не настроен'}`);
});

const shutdown = () => {
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
