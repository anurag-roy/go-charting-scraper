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
} from './session.js';

const SESSION = { open: '09:15', close: '15:40', graceMs: 2000 };

describe('intervalMinutes', () => {
  it('parses minute bars including 10m', () => {
    assert.equal(intervalMinutes('2m'), 2);
    assert.equal(intervalMinutes('3m'), 3);
    assert.equal(intervalMinutes('5m'), 5);
    assert.equal(intervalMinutes('10m'), 10);
  });
});

describe('NSE session window', () => {
  it('includes 09:15 through 15:39 and excludes 15:40 starts', () => {
    assert.equal(inSession('2026-08-14T09:15:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:39:00+05:30', SESSION), true);
    assert.equal(inSession('2026-08-14T15:40:00+05:30', SESSION), false);
  });

  it('closes the last 5m bar (15:35) at 15:40 plus grace', () => {
    const candle = '2026-08-14T15:35:00+05:30';
    const close = Date.parse('2026-08-14T15:40:00+05:30');
    assert.equal(isCandleClosed(candle, '5m', close + 1000, SESSION), false);
    assert.equal(isCandleClosed(candle, '5m', close + 2000, SESSION), true);
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
    assert.equal(isAfterClose(close, SESSION), true);
  });

  it('walks back over the weekend to Friday', () => {
    assert.equal(persistSessionDate(Date.parse('2026-08-15T10:25:00+05:30'), SESSION), '2026-08-14');
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
});
