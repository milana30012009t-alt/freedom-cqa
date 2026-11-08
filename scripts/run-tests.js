#!/usr/bin/env node
// Runs the node:test suites without relying on glob support in `node --test` (added only in Node 21),
// so `npm test` works the same on Node 18, 20, 22 and later.
// Usage: node scripts/run-tests.js [unit] [integration]
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['unit', 'integration'];
const files = suites.flatMap((s) => {
  const dir = join(root, 'tests', s);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join('tests', s, f));
});
if (!files.length) {
  console.error('Тесты не найдены');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
