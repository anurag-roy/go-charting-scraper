import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getNseHolidays, isTradingDate, parseNseHolidays, previousTradingDate } from './calendar.js';
import { updateNseHolidays } from '../scripts/update-holidays.js';

describe('local NSE calendar', () => {
  it('loads the source format, including 2027, and deduplicates dates', () => {
    const dates = parseNseHolidays('\uFEFFdate,holiday\r\n26-Jan-2027,Republic Day\r\n26-Jan-2027,Republic Day\r\n');
    assert.deepEqual([...dates], ['2027-01-26']);
    assert.equal(getNseHolidays().has('2026-10-02'), true);
    assert.equal(getNseHolidays().has('2027-01-26'), true);
  });

  it('rejects malformed, empty, and impossible dates instead of silently opening the market', () => {
    for (const csv of [
      '<html>unavailable</html>', 'date,holiday\n', 'date,holiday\n31-Feb-2026,Invalid',
      'date,holiday\n26-XYZ-2026,Invalid', 'date,holiday\n2026-01-26,Wrong format',
      'date,holiday\n26-Jan-2026,',
    ]) assert.throws(() => parseNseHolidays(csv), /holiday|Holiday/);
  });

  it('closes NSE/BSE on holidays and every exchange on weekends', () => {
    assert.equal(isTradingDate('2026-10-02', 'NSE'), false);
    assert.equal(isTradingDate('2026-10-02', 'bse'), false);
    assert.equal(isTradingDate('2026-10-02', 'MCX'), true);
    for (const exchange of ['NSE', 'BSE', 'MCX']) {
      assert.equal(isTradingDate('2026-10-03', exchange), false);
      assert.equal(isTradingDate('2026-10-04', exchange), false);
      assert.equal(isTradingDate('2026-10-05', exchange), true);
    }
  });

  it('walks across consecutive holidays and weekend/holiday combinations', () => {
    assert.equal(previousTradingDate('2027-04-16'), '2027-04-13');
    assert.equal(previousTradingDate('2026-11-10'), '2026-11-06');
    assert.equal(previousTradingDate('2026-11-10', 'MCX'), '2026-11-09');
  });
});

describe('holiday refresh', () => {
  function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gocharting-holidays-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const destination = path.join(directory, 'nse_holidays.csv');
    const original = 'date,holiday\n26-Jan-2026,Republic Day\n';
    fs.writeFileSync(destination, original);
    return { destination, original, directory };
  }

  it('replaces the local copy with a validated future-year download', async (t) => {
    const { destination, directory } = fixture(t);
    const csv = 'date,holiday\n26-Jan-2028,Republic Day\n';
    const result = await updateNseHolidays({ destination, fetchImpl: async () => new Response(csv) });
    assert.deepEqual(result, { count: 1, years: ['2028'] });
    assert.equal(fs.readFileSync(destination, 'utf8'), csv);
    assert.deepEqual(fs.readdirSync(directory), ['nse_holidays.csv']);
  });

  for (const [name, fetchImpl] of [
    ['network failure', async () => { throw new Error('offline'); }],
    ['HTTP failure', async () => new Response('unavailable', { status: 503 })],
    ['malformed download', async () => new Response('date,holiday\n31-Feb-2026,Invalid\n')],
  ]) {
    it(`preserves the previous copy after a ${name}`, async (t) => {
      const { destination, original, directory } = fixture(t);
      await assert.rejects(updateNseHolidays({ destination, fetchImpl }));
      assert.equal(fs.readFileSync(destination, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(directory), ['nse_holidays.csv']);
    });
  }
});
