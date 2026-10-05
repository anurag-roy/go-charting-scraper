import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { NSE_HOLIDAYS_PATH, NSE_HOLIDAYS_SOURCE, parseNseHolidays } from '../src/calendar.js';

/** Validate the download before atomically replacing the local calendar. */
export async function updateNseHolidays({ destination = NSE_HOLIDAYS_PATH, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(NSE_HOLIDAYS_SOURCE, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Holiday download failed: HTTP ${response.status}`);
  const csv = await response.text();
  const dates = parseNseHolidays(csv);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, csv, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { count: dates.size, years: [...new Set([...dates].map((date) => date.slice(0, 4)))].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await updateNseHolidays();
    console.log(`Updated ${result.count} NSE holidays (${result.years.join(', ')}) in ${NSE_HOLIDAYS_PATH}. Restart the scraper to use them.`);
  } catch (err) {
    console.error(`Holiday update failed; local calendar was not replaced: ${err.message}`);
    process.exitCode = 1;
  }
}
