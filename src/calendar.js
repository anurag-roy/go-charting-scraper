import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './env.js';

export const NSE_HOLIDAYS_SOURCE = 'https://raw.githubusercontent.com/anurag-roy/all-option-chain/main/.data/nse_holidays.csv';
export const NSE_HOLIDAYS_PATH = path.join(repoRoot, '.data', 'nse_holidays.csv');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let nseHolidays;

/** Read the source's date,holiday CSV into ISO dates without locale-dependent parsing. */
export function parseNseHolidays(csv) {
  const lines = String(csv).replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.shift()?.trim() !== 'date,holiday') {
    throw new Error('Holiday CSV must start with date,holiday');
  }
  const dates = new Set();
  for (const [index, line] of lines.entries()) {
    const [rawDate, ...holiday] = line.split(',');
    const match = rawDate.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
    const month = match ? MONTHS.indexOf(match[2]) + 1 : 0;
    if (!match || !month || !holiday.join(',').trim()) {
      throw new Error(`Invalid holiday CSV row ${index + 2}: expected DD-Mmm-YYYY,holiday`);
    }
    const date = `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}`;
    const instant = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid holiday date on CSV row ${index + 2}: ${rawDate}`);
    }
    dates.add(date);
  }
  if (!dates.size) throw new Error('Holiday CSV contains no dates');
  return dates;
}

/** Load once per process. Missing/malformed calendars fail rather than treating holidays as open. */
export function getNseHolidays() {
  if (!nseHolidays) {
    try {
      nseHolidays = parseNseHolidays(fs.readFileSync(NSE_HOLIDAYS_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot load NSE holiday calendar at ${NSE_HOLIDAYS_PATH}: ${err.message}`, { cause: err });
    }
  }
  return nseHolidays;
}

export function shiftDate(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** NSE's calendar is shared with BSE here; MCX retains its existing weekday schedule. */
export function isTradingDate(date, exchange = 'NSE') {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const ex = String(exchange).toUpperCase();
  return !['NSE', 'BSE'].includes(ex) || !getNseHolidays().has(date);
}

export function previousTradingDate(date, exchange = 'NSE') {
  let previous = shiftDate(date, -1);
  while (!isTradingDate(previous, exchange)) previous = shiftDate(previous, -1);
  return previous;
}
