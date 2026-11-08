// Shared test helpers (no dependencies).
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.js';
import { setLogLevel } from '../server/lib/logger.js';

setLogLevel('silent');

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MINI = join(ROOT, 'tests', 'fixtures', 'mini-dataset.json');
export const OFFICIAL_CHECKLIST = join(ROOT, 'checklists', 'freedom-official.v1.json');

/** Real DEV dataset if available locally (it is git-ignored): CQA_DEV_FILE or data/datasets/DEV.raw.json. */
export function devFile() {
  const candidates = [process.env.CQA_DEV_FILE, join(ROOT, 'data', 'datasets', 'DEV.raw.json')].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

export function tmpCfg(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cqa-test-'));
  const cfg = loadConfig({
    envFile: false,
    dataDir: dir,
    env: {
      AI_PROVIDER: 'rules', DATASET_API_URL: '', ANTHROPIC_API_KEY: '', OPENAI_MODEL: '', OPENAI_API_KEY: '',
      DATASET_AUTOLOAD: 'false', LOG_LEVEL: 'silent', ...extraEnv,
    },
  });
  return { cfg, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

// Windows-1251 high half (0x80..0xBF), used to simulate "UTF-8 read as CP1251" damage.
const CP1251_HIGH = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї';

/** Produce mojibake the way the DEV file was damaged (NBSP collapsed into a space). */
export function toMojibake(text) {
  let out = '';
  for (const b of Buffer.from(text, 'utf8')) {
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xC0) out += b === 0xA0 ? ' ' : CP1251_HIGH[b - 0x80];
    else out += String.fromCharCode(0x0410 + (b - 0xC0));
  }
  return out;
}
