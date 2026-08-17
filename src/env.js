import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(__dirname, '..');

dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

export function flag(name, fallback = '') {
  return /^(1|true|yes)$/i.test(String(process.env[name] ?? fallback));
}

export function parseSheetId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p)) || '';
}

export function resolvePathMaybe(p) {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  return firstExisting([
    path.resolve(p),
    path.join(repoRoot, p),
  ]) || path.resolve(p);
}

function normalizePrivateKey(raw) {
  let key = String(raw || '').replace(/\\n/g, '\n').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).replace(/\\n/g, '\n');
  }
  return key;
}

export function loadConfig() {
  const intervals = String(process.env.INTERVALS || '2m,3m,5m')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const sheetId = parseSheetId(process.env.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEET_URL || '');
  const credRaw = String(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  ).trim();

  let googleCredentialsPath = '';
  let googleCredentialsJson = null;
  if (credRaw.startsWith('{')) {
    googleCredentialsJson = JSON.parse(credRaw);
  } else if (credRaw) {
    googleCredentialsPath = resolvePathMaybe(credRaw);
  }

  const wsDc = process.env.WS_DC || 'blr1';

  return {
    sheetId,
    googleCredentialsPath,
    googleCredentialsJson,
    googleClientEmail: String(process.env.GOOGLE_CLIENT_EMAIL || '').trim(),
    googlePrivateKey: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY || ''),
    configTab: String(process.env.CONFIG_TAB || 'config').trim() || 'config',
    configPollMs: Number(process.env.CONFIG_POLL_MS || 5_000),
    sampleMs: Number(process.env.SAMPLE_MS || 15_000),
    intervals,
    session: process.env.GOCHARTING_SESSION || 'RTH',
    closeGraceMs: Number(process.env.CLOSE_GRACE_MS || 2000),
    afterCloseBufferMs: Number(process.env.AFTER_CLOSE_BUFFER_MS || 60_000),
    tokenRefreshMs: Number(process.env.TOKEN_REFRESH_MS || 45 * 60_000),
    wsDc,
    wsTag: process.env.WS_TAG || 'go-charting-scraper',
    wsHost: process.env.WS_HOST || `wss://origin.ws.prodb.${wsDc}.gocharting.com/${wsDc}/ws`,
    writeCsv: flag('WRITE_CSV'),
    csvPath: process.env.CSV_PATH || path.join(repoRoot, 'logs', 'maxvol.csv'),
    errorLogPath: process.env.ERROR_LOG_PATH || path.join(repoRoot, 'logs', 'error.log'),
    statusPath: process.env.STATUS_PATH || path.join(repoRoot, 'logs', 'status.json'),
    once: flag('ONCE'),
    debugJsonl: flag('DEBUG_JSONL'),
    outDir: process.env.OUT_DIR || path.join(repoRoot, 'logs'),
    protoDir: process.env.PROTO_DIR || path.join(repoRoot, 'investigation', 'evidence'),
  };
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.sheetId) {
    errors.push('set GOOGLE_SHEET_ID (spreadsheet id or URL)');
  }
  const hasFile = Boolean(cfg.googleCredentialsPath || cfg.googleCredentialsJson);
  const hasPair = Boolean(cfg.googleClientEmail && cfg.googlePrivateKey);
  if (!hasFile && !hasPair) {
    errors.push(
      'Google credentials are missing (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)',
    );
  }
  if (cfg.sheetId && cfg.googleCredentialsPath && !cfg.googleCredentialsJson && !fs.existsSync(cfg.googleCredentialsPath)) {
    errors.push(`Google credentials file not found: ${cfg.googleCredentialsPath}`);
  }
  if (!cfg.intervals.length) errors.push('INTERVALS is empty');
  if (!Number.isFinite(cfg.configPollMs) || cfg.configPollMs < 1000) {
    errors.push('CONFIG_POLL_MS must be at least 1000');
  }
  if (!Number.isFinite(cfg.sampleMs) || cfg.sampleMs < 1000) {
    errors.push('SAMPLE_MS must be at least 1000');
  }
  return errors;
}
