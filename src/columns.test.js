import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHEET_COLUMNS,
  formatSheetCandleTime,
  rowToSheetValues,
  sheetTabName,
  csvRowKey,
  selectNewCsvRows,
} from './columns.js';
import { SheetsSink, sheetA1 } from './sheets.js';
import { closedRowsForInterval } from './collect.js';

describe('sheet helpers', () => {
  it('names tabs with the contract id and 2m/3m/5m', () => {
    assert.equal(sheetTabName('NIFTY2681824300CE', '2m'), 'NIFTY2681824300CE 2m');
    assert.equal(sheetTabName('CRUDEOIL-I', '3m'), 'CRUDEOIL-I 3m');
    assert.equal(sheetTabName('NIFTY-I', '5m'), 'NIFTY-I 5m');
  });

  it('strips a trailing timezone offset from candle_time', () => {
    assert.equal(formatSheetCandleTime('2026-08-17T09:15:00+05:30'), '2026-08-17T09:15:00');
  });

  it('writes only the slim 10-column schema', () => {
    const values = rowToSheetValues({
      candle_time: '2026-08-17T09:15:00+05:30',
      delta: 40,
      max_delta: 80,
      max_vol_b: 50,
      max_vol_s: 30,
      poc: 24300,
      volume: 150,
      oi_change: 12,
      vwap1: 7800.5,
      vwap2: 7873.38,
      open: 1,
    });
    assert.deepEqual(values, [
      '2026-08-17T09:15:00',
      40, 80, 50, 30, 24300, 150, 12, 7800.5, 7873.38,
    ]);
    assert.equal(SHEET_COLUMNS.length, 10);
  });
});

describe('SheetsSink', () => {
  it('appends unseen rows grouped by symbol+interval tab', async () => {
    const appended = [];
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    const tab2 = sheetTabName('NIFTY2681824300CE', '2m');
    const tab5 = sheetTabName('CRUDEOIL-I', '5m');
    sink.loadedTabs.add(tab2);
    sink.loadedTabs.add(tab5);
    sink.sheetsApi = {
      spreadsheets: {
        values: {
          append: async (req) => {
            appended.push(req);
            return {};
          },
        },
      },
    };

    const n = await sink.writeRows([
      { ok: true, contract: 'NIFTY2681824300CE', interval: '2m', candle_time: '2026-08-17T09:15:00+05:30', delta: 1 },
      { ok: true, contract: 'NIFTY2681824300CE', interval: '2m', candle_time: '2026-08-17T09:17:00+05:30', delta: 2 },
      { ok: true, contract: 'CRUDEOIL-I', interval: '5m', candle_time: '2026-08-17T09:15:00+05:30', delta: 3 },
    ]);
    assert.equal(n, 3);
    assert.equal(appended[0].range, sheetA1(tab2, 'A1'));
    assert.equal(appended[1].range, sheetA1(tab5, 'A1'));
  });

  it('dropInstrument forgets old keys and leaves other symbols', () => {
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    const oldTab = sheetTabName('NIFTY-I', '2m');
    const keepTab = sheetTabName('CRUDEOIL-I', '2m');
    sink.keys.add(`${oldTab}\t2026-08-17T09:15:00`);
    sink.keys.add(`${keepTab}\t2026-08-17T09:15:00`);
    sink.loadedTabs.add(oldTab);
    sink.loadedTabs.add(keepTab);
    sink.dropInstrument('NIFTY-I', ['2m', '3m', '5m']);
    assert.equal(sink.keys.has(`${oldTab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.keys.has(`${keepTab}\t2026-08-17T09:15:00`), true);
    assert.equal(sink.loadedTabs.has(oldTab), false);
  });
});

describe('csv keys', () => {
  it('does not collide across symbols on the same interval+time', () => {
    const keys = new Set([csvRowKey('NSE:FUTURE:NIFTY-I', '2m', 't1')]);
    const fresh = selectNewCsvRows(keys, [
      { ok: true, symbol: 'NSE:FUTURE:NIFTY-I', interval: '2m', candle_time: 't1' },
      { ok: true, symbol: 'MCX:FUTURE:CRUDEOIL-I', interval: '2m', candle_time: 't1' },
    ]);
    assert.deepEqual(fresh.map((r) => r.symbol), ['MCX:FUTURE:CRUDEOIL-I']);
  });
});

describe('closedRowsForInterval', () => {
  const instrument = {
    exchange: 'NSE',
    segment: 'FUTURE',
    symbol: 'NIFTY-I',
    id: 'NSE:FUTURE:NIFTY-I',
  };
  const sessionOpts = { open: '09:15', close: '15:40', graceMs: 2000 };

  it('writes only closed persistable candles', () => {
    const nowMs = Date.parse('2026-08-17T09:22:02+05:30');
    const rows = closedRowsForInterval({
      instrument,
      interval: '5m',
      candles: [
        { date: '2026-08-17T09:15:00+05:30', totals: { buy: { volume: 10 }, sell: { volume: 4 } }, max: { buy: { volume: 6 }, sell: { volume: 3 } }, footprint: [{ level: 1, buy: { volume: 6 }, sell: { volume: 3 } }, { level: 2, buy: { volume: 4 }, sell: { volume: 1 } }] },
        { date: '2026-08-17T09:20:00+05:30', totals: { buy: { volume: 1 }, sell: { volume: 1 } }, max: { buy: { volume: 1 }, sell: { volume: 1 } }, footprint: [{ level: 1, buy: { volume: 1 }, sell: { volume: 1 } }] },
      ],
      ohlcBars: [
        { time: '2026-08-17T09:15:00+05:30', open: 1, high: 2, low: 1, close: 2, volume: 10, oi: 100 },
        { time: '2026-08-17T09:20:00+05:30', open: 2, high: 3, low: 2, close: 3, volume: 5, oi: 110 },
      ],
      nowMs,
      sessionOpts,
      sampled_at_utc: 'u',
      sampled_at_ist: 'i',
      sample_n: 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].candle_time, '2026-08-17T09:15:00+05:30');
    assert.equal(rows[0].contract, 'NIFTY-I');
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].oi_change, '');
  });
});
