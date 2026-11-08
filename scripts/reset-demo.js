#!/usr/bin/env node
// Reset evaluations and appeals (and optionally checklist versions) — datasets are kept.
// Usage: npm run reset [-- --checklists]
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';

const cfg = loadConfig();
rmSync(join(cfg.dataDir, 'store', 'evaluations'), { recursive: true, force: true });
rmSync(join(cfg.dataDir, 'store', 'appeals.json'), { force: true });
if (process.argv.includes('--checklists')) rmSync(join(cfg.dataDir, 'store', 'checklists.json'), { force: true });
console.log(`Сброшено: оценки и апелляции${process.argv.includes('--checklists') ? ', версии чек-листа (при запуске восстановится официальный v1)' : ''}. Наборы данных сохранены.`);
