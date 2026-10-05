import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anyLive, earliestOpenMs, hoursForExchange, isBeforeAnyOpen, nextOpenMs, workForInstrument } from './market.js';
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

  it('idles on an NSE holiday, including the close buffer and after-hours startup', () => {
    for (const time of ['08:00:00', '10:00:00', '15:40:30', '16:00:00']) {
      const now = Date.parse(`2026-10-02T${time}+05:30`);
      for (const exchange of ['NSE', 'BSE']) {
        const work = workForInstrument({ ...NSE, exchange }, now, {});
        assert.equal(work.action, 'idle');
        assert.equal(work.persistDate, '2026-10-01');
      }
      assert.equal(anyLive([NSE], now), false);
      assert.equal(isBeforeAnyOpen([NSE], now), true);
    }
  });

  it('keeps MCX active on an NSE holiday and propagates its calendar to candle filtering', () => {
    const now = Date.parse('2026-10-02T10:00:00+05:30');
    const work = workForInstrument(MCX, now, {});
    assert.equal(work.action, 'sample');
    assert.equal(work.persistDate, '2026-10-02');
    assert.equal(work.hours.exchange, 'MCX');
    assert.equal(anyLive([NSE, MCX], now), true);
    assert.equal(isBeforeAnyOpen([NSE, MCX], now), false);
  });

  it('uses the previous trading session for an explicit holiday debug backfill', () => {
    const now = Date.parse('2026-11-09T10:00:00+05:30');
    const work = workForInstrument(NSE, now, {}, { lastWorkingDay: true });
    assert.equal(work.action, 'backfill');
    assert.equal(work.persistDate, '2026-11-06');
    assert.equal(workForInstrument(NSE, now, {}).action, 'idle');
  });

  it('backfills the last working day overnight when LAST_WORKING_DAY is set', () => {
    const extra = { lastWorkingDay: true };
    const twoAm = Date.parse('2026-08-18T02:00:00+05:30');
    assert.equal(persistSessionDate(twoAm, { open: '09:15' }), '2026-08-17');
    assert.equal(workForInstrument(NSE, twoAm, {}).action, 'idle');
    assert.equal(workForInstrument(NSE, twoAm, {}, extra).action, 'backfill');
    assert.equal(workForInstrument(NSE, twoAm, {}, extra).persistDate, '2026-08-17');
    assert.equal(
      workForInstrument(NSE, twoAm, { backfilledSessionDate: '2026-08-17' }, extra).action,
      'idle',
    );

    const sat = Date.parse('2026-08-15T12:00:00+05:30');
    assert.equal(workForInstrument(NSE, sat, {}, extra).action, 'backfill');
    assert.equal(workForInstrument(NSE, sat, {}, extra).persistDate, '2026-08-14');

    const live = Date.parse('2026-08-17T10:00:00+05:30');
    assert.equal(workForInstrument(NSE, live, {}, extra).action, 'sample');
  });
});

describe('next trading-day open', () => {
  it('skips Friday holiday plus weekend and Monday holiday after a weekend', () => {
    assert.equal(nextOpenMs('NSE', Date.parse('2026-10-02T10:00:00+05:30')), Date.parse('2026-10-05T09:15:00+05:30'));
    assert.equal(nextOpenMs('BSE', Date.parse('2026-11-07T12:00:00+05:30')), Date.parse('2026-11-10T09:15:00+05:30'));
    assert.equal(nextOpenMs('NSE', Date.parse('2027-04-13T16:00:00+05:30')), Date.parse('2027-04-16T09:15:00+05:30'));
  });

  it('resumes at opening and honours IST dates across the UTC day boundary', () => {
    const before = Date.parse('2026-10-01T20:00:00Z'); // 02-Oct 01:30 IST, a holiday
    assert.equal(nextOpenMs('NSE', before), Date.parse('2026-10-05T09:15:00+05:30'));
    const open = Date.parse('2026-10-05T09:15:00+05:30');
    assert.equal(nextOpenMs('NSE', open), open);
    assert.equal(workForInstrument(NSE, open, {}).action, 'sample');
  });

  it('chooses MCX when NSE/BSE are closed', () => {
    const now = Date.parse('2026-10-02T08:30:00+05:30');
    assert.equal(earliestOpenMs([NSE, MCX], now), Date.parse('2026-10-02T09:00:00+05:30'));
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
