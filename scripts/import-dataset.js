#!/usr/bin/env node
// Import a dataset JSON file (API response saved to disk) without starting the server.
// Usage: npm run import -- path/to/file.json [--group DEV] [--activate]
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { DatasetService } from '../server/data/dataset-service.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const gi = args.indexOf('--group');
const group = gi >= 0 ? args[gi + 1] : 'DEV';
if (!file) {
  console.error('Использование: npm run import -- <файл.json> [--group DEV] [--activate]');
  process.exit(1);
}
const cfg = loadConfig();
const ds = new DatasetService({ cfg });
const r = await ds.importPayload(group, readFileSync(file, 'utf8'), 'file');
if (args.includes('--activate') || !ds.status().active_group) await ds.setActive(group);
console.log(`Набор ${r.group_id}: ${r.record_count} диалогов (новых ${r.added}, обновлено ${r.updated})`);
if (r.warnings.length) console.log(`Предупреждения:\n - ${r.warnings.slice(0, 20).join('\n - ')}`);
if (r.errors.length) console.log(`Ошибки:\n - ${r.errors.join('\n - ')}`);
const meta = ds.status().groups.find((g) => g.group_id === group);
console.log('По языкам:', meta.by_language, 'По каналам:', meta.by_channel, `Исправлено кодировок: ${meta.repaired_messages}`);
