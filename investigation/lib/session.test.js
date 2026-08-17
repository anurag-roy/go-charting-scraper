import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  inSession,
  isCandleClosed,
  isBeforeOpen,
  isAfterClose,
  persistSessionDate,
  isPersistableCandle,
  intervalMinutes,
  marketWindowMs,
  sessionDatesFor,
} from './session.js';
import { parseSheetId } from './env.js';
import { COLUMNS, parseCsvLine, rowToCsvLine, selectNewRows, rowKey } from './columns.js';
import { sheetA1 } from './sheets-sink.js';

const SESSION = { open: '09:15', close: '15:40', graceMs: 2000 };

describe('intervalMinutes', () => {
  it('parses 2m/3m/5m', () => {
    assert.equal(intervalMinutes('2m'), 2);
    assert.equal(intervalMinutes('3m'), 3);
    assert.equal(intervalMinutes('5m'), 5);
  });
});

describe('NSE session window', () => {
  it('includes 09:15 through 15:39 and excludes 15:40 starts', () => {
    assert.equal(inSession('2026-08-14T09:15:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:25:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:29:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:30:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:35:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:39:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:40:00+05:30', SESSION), false);
    assert.equal(inSession('2026-08-14T09:14:00+05:30', SESSION), false);
  });

  it('treats a 5m 09:15 bar as closed only after 09:20 plus grace', () => {
    const candle = '2026-08-14T09:15:00+05:30';
    const close = Date.parse('2026-08-14T09:20:00+05:30');
    assert.equal(isCandleClosed(candle, '5m', close + 1999, SESSION), false);
    assert.equal(isCandleClosed(candle, '5m', close + 2000, SESSION), true);
  });

  it('closes the last 5m bar (15:35) at 15:40 plus grace', () => {
    const candle = '2026-08-14T15:35:00+05:30';
    const close = Date.parse('2026-08-14T15:40:00+05:30');
    assert.equal(isCandleClosed(candle, '5m', close + 1000, SESSION), false);
    assert.equal(isCandleClosed(candle, '5m', close + 2000, SESSION), true);
  });

  it('caps a short last 2m bar at the 15:40 session close', () => {
    const candle = '2026-08-14T15:39:00+05:30';
    const close = Date.parse('2026-08-14T15:40:00+05:30');
    assert.equal(isCandleClosed(candle, '2m', close + 2000, SESSION), true);
    assert.equal(isCandleClosed(candle, '2m', close + 1000, SESSION), false);
  });

  it('does not close a forming 2m bar', () => {
    const candle = '2026-08-14T09:15:00+05:30';
    const now = Date.parse('2026-08-14T09:16:30+05:30');
    assert.equal(isCandleClosed(candle, '2m', now, SESSION), false);
  });

  it('detects before-open and after-close in IST', () => {
    const before = Date.parse('2026-08-14T09:14:59+05:30');
    const open = Date.parse('2026-08-14T09:15:00+05:30');
    const close = Date.parse('2026-08-14T15:40:00+05:30');
    assert.equal(isBeforeOpen(before, SESSION), true);
    assert.equal(isBeforeOpen(open, SESSION), false);
    assert.equal(isAfterClose(close - 1, SESSION), false);
    assert.equal(isAfterClose(close, SESSION), true);
  });

  it('persists yesterday before the open, today after the open', () => {
    assert.equal(
      persistSessionDate(Date.parse('2026-08-14T08:00:00+05:30'), SESSION),
      '2026-08-13',
    );
    assert.equal(
      persistSessionDate(Date.parse('2026-08-14T10:00:00+05:30'), SESSION),
      '2026-08-14',
    );
  });

  it('walks back over the weekend to Friday', () => {
    assert.equal(
      persistSessionDate(Date.parse('2026-08-15T10:25:00+05:30'), SESSION),
      '2026-08-14',
    );
    assert.equal(
      persistSessionDate(Date.parse('2026-08-17T08:00:00+05:30'), SESSION),
      '2026-08-14',
    );
  });

  it('drops candles from a different session date', () => {
    const now = Date.parse('2026-08-14T10:00:00+05:30');
    assert.equal(isPersistableCandle('2026-08-14T09:15:00+05:30', now, SESSION), true);
    assert.equal(isPersistableCandle('2026-08-13T09:15:00+05:30', now, SESSION), false);
  });

  it('computes a 385-minute cash session', () => {
    const { openMs, closeMs } = marketWindowMs('2026-08-14', '09:15', '15:40');
    assert.equal((closeMs - openMs) / 60_000, 385);
  });

  it('asks the persist date first when requesting session dates', () => {
    const dates = sessionDatesFor(Date.parse('2026-08-15T10:25:00+05:30'), SESSION);
    assert.equal(dates[0], '2026-08-14');
  });
});

describe('parseSheetId', () => {
  it('accepts a raw id or a full URL', () => {
    assert.equal(parseSheetId('abc-123_ID'), 'abc-123_ID');
    assert.equal(
      parseSheetId('https://docs.google.com/spreadsheets/d/1AbCDefGhIJklmn/edit#gid=0'),
      '1AbCDefGhIJklmn',
    );
    assert.equal(parseSheetId(''), '');
  });
});

describe('csv helpers', () => {
  it('round-trips quoted commas', () => {
    const line = rowToCsvLine({
      sampled_at_utc: 't',
      interval: '2m',
      candle_time: '2026-08-14T09:15:00+05:30',
      error: 'a, b',
    });
    const cols = parseCsvLine(line);
    assert.equal(cols[COLUMNS.indexOf('interval')], '2m');
    assert.equal(cols[COLUMNS.indexOf('candle_time')], '2026-08-14T09:15:00+05:30');
    assert.equal(cols[COLUMNS.indexOf('error')], 'a, b');
  });

  it('selects only new successful closed rows', () => {
    const keys = new Set([rowKey('2m', 't1')]);
    const fresh = selectNewRows(keys, [
      { ok: true, interval: '2m', candle_time: 't1' },
      { ok: true, interval: '2m', candle_time: 't2' },
      { ok: false, interval: '2m', candle_time: 't3' },
      { ok: true, interval: '3m', candle_time: 't2' },
    ]);
    assert.deepEqual(
      fresh.map((r) => `${r.interval}:${r.candle_time}`),
      ['2m:t2', '3m:t2'],
    );
  });
});

describe('sheetA1', () => {
  it('quotes tab names that start with a digit', () => {
    assert.equal(sheetA1('2m', 'A1'), "'2m'!A1");
    assert.equal(sheetA1("O'Brien", 'A:Z'), "'O''Brien'!A:Z");
  });
});
