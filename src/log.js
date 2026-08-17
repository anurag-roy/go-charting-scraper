import fs from 'node:fs';
import path from 'node:path';
import { redactText, redactValue } from './redact.js';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    if (fs.statSync(filePath).size < MAX_BYTES) return;
    const oldest = `${filePath}.${KEEP}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = KEEP - 1; i >= 1; i -= 1) {
      const src = `${filePath}.${i}`;
      const dest = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dest);
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    /* never crash the process because of log rotation */
  }
}

export function createLogger({ errorLogPath, getSecrets } = {}) {
  const secrets = () => {
    try {
      return (getSecrets?.() || []).filter(Boolean);
    } catch {
      return [];
    }
  };

  if (errorLogPath) {
    fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
  }

  const fmt = (level, args) => {
    const ts = new Date().toISOString();
    const body = args.map((a) => (typeof a === 'string' ? a : redactValue(a, secrets()))).join(' ');
    return redactText(`${ts} ${level} ${body}`, secrets());
  };

  const writeErrorFile = (line) => {
    if (!errorLogPath) return;
    try {
      rotateIfNeeded(errorLogPath);
      fs.appendFileSync(errorLogPath, `${line}\n`);
    } catch (err) {
      console.error('failed to write error log', err?.message || err);
    }
  };

  return {
    info: (...args) => console.log(fmt('INFO', args)),
    warn: (...args) => console.warn(fmt('WARN', args)),
    error: (...args) => {
      const line = fmt('ERROR', args);
      console.error(line);
      writeErrorFile(line);
    },
  };
}

export function writeStatus(filePath, data) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}
