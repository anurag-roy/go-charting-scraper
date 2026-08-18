import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hoursForExchange, workForInstrument } from './market.js';
import { isCandleClosed, persistSessionDate } from './session.js';

const NSE = { exchange: 'NSE', segment: 'FUTURE', symbol: 'NIFTY-I', id: 'NSE:FUTURE:NIFTY-I' };
const MCX = { exchange: 'MCX', segment: 'FUTURE', symbol: 'CRUDEOIL-I', id: 'MCX:FUTURE:CRUDEOIL-I' };

describe('hoursForExchange', () => {
  it('uses 09:15–15:40 for NSE and BSE', () => {
    assert.deepEqual(hoursForExchange('NSE', Date.parse('2026-08-17T12:00:00+05:30')), {
      open: '09:15',
      close: '15:40',
    });
    assert.equal(hoursForExchange('BSE').open, '09:15');
  });

  it('uses MCX 23:55 close during US daylight saving', () => {
    assert.deepEqual(hoursForExchange('MCX', Date.parse('2026-08-17T12:00:00+05:30')), {
      open: '09:00',
      close: '23:55',
    });
  });

  it('uses MCX 23:30 close during US standard time', () => {
    assert.deepEqual(hoursForExchange('MCX', Date.parse('2026-01-15T12:00:00+05:30')), {
      open: '09:00',
      close: '23:30',
    });
  });
});

describe('workForInstrument', () => {
  it('samples NSE during cash hours and backfills after close', () => {
    const live = Date.parse('2026-08-17T10:00:00+05:30');
    assert.equal(workForInstrument(NSE, live, {}).action, 'sample');

    const after = Date.parse('2026-08-17T16:00:00+05:30');
    assert.equal(workForInstrument(NSE, after, {}).action, 'backfill');
    assert.equal(
      workForInstrument(NSE, after, { backfilledSessionDate: '2026-08-17' }).action,
      'idle',
    );
  });

  it('keeps sampling MCX in the evening after NSE has closed', () => {
    const evening = Date.parse('2026-08-17T20:00:00+05:30');
    assert.equal(workForInstrument(NSE, evening, { backfilledSessionDate: '2026-08-17' }).action, 'idle');
    assert.equal(workForInstrument(MCX, evening, {}).action, 'sample');
  });

  it('idles on the weekend once Friday is backfilled', () => {
    const sat = Date.parse('2026-08-15T12:00:00+05:30');
    assert.equal(persistSessionDate(sat, { open: '09:15' }), '2026-08-14');
    assert.equal(
      workForInstrument(NSE, sat, { backfilledSessionDate: '2026-08-14' }).action,
      'idle',
    );
    assert.equal(workForInstrument(NSE, sat, {}).action, 'idle');
  });

  it('does not backfill a previous weekday before the next open', () => {
    const mondayMorning = Date.parse('2026-08-17T08:00:00+05:30');
    assert.equal(persistSessionDate(mondayMorning, { open: '09:15' }), '2026-08-14');
    assert.equal(workForInstrument(NSE, mondayMorning, {}).action, 'idle');
  });
});

describe('MCX last-bar close', () => {
  it('closes the last 5m bar at the seasonal session close plus grace', () => {
    const hours = { open: '09:00', close: '23:55', graceMs: 2000 };
    const candle = '2026-08-17T23:50:00+05:30';
    const close = Date.parse('2026-08-17T23:55:00+05:30');
    assert.equal(isCandleClosed(candle, '5m', close + 1000, hours), false);
    assert.equal(isCandleClosed(candle, '5m', close + 2000, hours), true);
  });
});
