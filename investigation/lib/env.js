import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const investigationDir = path.join(__dirname, '..');
export const repoRoot = path.join(investigationDir, '..');

dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(investigationDir, '.env'), override: true, quiet: true });

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
    path.join(investigationDir, p),
    path.join(repoRoot, p),
  ]) || path.resolve(p);
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

  const runMsEnv = process.env.RUN_MS;
  const runMs = runMsEnv == null || runMsEnv === '' ? null : Number(runMsEnv);
  const wsDc = process.env.WS_DC || 'blr1';

  return {
    email: String(process.env.GOCHARTING_EMAIL || '').trim(),
    password: String(process.env.GOCHARTING_PASSWORD || ''),
    headless: flag('HEADLESS'),
    pwChannel: process.env.PW_CHANNEL || '',
    chartUrl: process.env.CHART_URL || 'https://gocharting.com/terminal/chart/kd5OXEIXs',
    wsDc,
    wsTag: process.env.WS_TAG || 'go-charting-scraper',
    wsHost: process.env.WS_HOST || `wss://origin.ws.prodb.${wsDc}.gocharting.com/${wsDc}/ws`,
    symbol: {
      exchange: process.env.GOCHARTING_EXCHANGE || 'NSE',
      segment: process.env.GOCHARTING_SEGMENT || 'FUTURE',
      symbol: process.env.GOCHARTING_SYMBOL || 'NIFTY-I',
    },
    session: process.env.GOCHARTING_SESSION || 'RTH',
    intervals,
    marketOpen: process.env.MARKET_OPEN || '09:15',
    marketClose: process.env.MARKET_CLOSE || '15:30',
    closeGraceMs: Number(process.env.CLOSE_GRACE_MS || 2000),
    runMs,
    sampleMs: Number(process.env.SAMPLE_MS || 15_000),
    lastN: Number(process.env.LAST_N || 0),
    writeCsv: flag('WRITE_CSV'),
    csvPath: process.env.CSV_PATH || path.join(investigationDir, 'evidence', 'maxvol.csv'),
    outDir: process.env.OUT_DIR || path.join(investigationDir, 'out', 'poc'),
    sheetId,
    googleCredentialsPath,
    googleCredentialsJson,
    googleClientEmail: String(process.env.GOOGLE_CLIENT_EMAIL || '').trim(),
    googlePrivateKey: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    tokenRefreshMs: Number(process.env.TOKEN_REFRESH_MS || 45 * 60_000),
    afterCloseBufferMs: Number(process.env.AFTER_CLOSE_BUFFER_MS || 60_000),
  };
}

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.email || !cfg.password) {
    errors.push('missing GOCHARTING_EMAIL / GOCHARTING_PASSWORD');
  }
  if (!cfg.writeCsv && !cfg.sheetId) {
    errors.push('set GOOGLE_SHEET_ID (spreadsheet id or URL) and/or WRITE_CSV=1');
  }
  const hasFile = Boolean(cfg.googleCredentialsPath || cfg.googleCredentialsJson);
  const hasPair = Boolean(cfg.googleClientEmail && cfg.googlePrivateKey);
  if (cfg.sheetId && !hasFile && !hasPair) {
    errors.push(
      'GOOGLE_SHEET_ID is set but Google credentials are missing (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)',
    );
  }
  if (!cfg.intervals.length) errors.push('INTERVALS is empty');
  if (cfg.runMs != null && !Number.isFinite(cfg.runMs)) {
    errors.push('RUN_MS must be a number of milliseconds (or omit it to run until market close)');
  }
  if (cfg.sheetId && cfg.googleCredentialsPath && !cfg.googleCredentialsJson && !fs.existsSync(cfg.googleCredentialsPath)) {
    errors.push(`Google credentials file not found: ${cfg.googleCredentialsPath}`);
  }
  return errors;
}
