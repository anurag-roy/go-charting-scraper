import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHEET_COLUMNS,
  formatSheetCandleTime,
  isLegacyVwapHeader,
  mapSheetRow,
  rowToSheetValues,
  sheetCandleDate,
  sheetTabName,
  csvRowKey,
  selectNewCsvRows,
  shouldRewriteHeader,
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

  it('writes OHLC immediately after candle_time, then the slim metrics', () => {
    const values = rowToSheetValues({
      candle_time: '2026-08-17T09:15:00+05:30',
      open: 100,
      high: 110,
      low: 99,
      close: 105,
      delta: 40,
      max_delta: 80,
      max_vol_b: 50,
      max_vol_s: 30,
      poc: 24300,
      volume: 150,
      oi_change: 12,
      vwap: 7800.5,
      vwap2: 7873.38,
    });
    assert.deepEqual(values, [
      '2026-08-17T09:15:00',
      100, 110, 99, 105,
      40, 80, 50, 30, 24300, 150, 12, 7800.5,
    ]);
    assert.deepEqual(SHEET_COLUMNS, [
      'candle_time', 'open', 'high', 'low', 'close',
      'delta', 'max_delta', 'max_vol_b', 'max_vol_s',
      'poc', 'volume', 'oi_change', 'vwap',
    ]);
  });

  it('treats vwap1/vwap2 headers as legacy and maps vwap1 onto vwap', () => {
    const legacy = [
      'candle_time', 'open', 'high', 'low', 'close',
      'delta', 'max_delta', 'max_vol_b', 'max_vol_s',
      'poc', 'volume', 'oi_change', 'vwap1', 'vwap2',
    ];
    assert.equal(isLegacyVwapHeader(legacy, SHEET_COLUMNS), true);
    assert.equal(shouldRewriteHeader(legacy, SHEET_COLUMNS), true);
    assert.equal(shouldRewriteHeader(SHEET_COLUMNS, SHEET_COLUMNS), false);
    assert.deepEqual(
      mapSheetRow(legacy, ['2026-08-17T09:15:00+05:30', 100, 110, 99, 105, 1, 2, 3, 4, 5, 6, 7, 80.1, 99]),
      ['2026-08-17T09:15:00', 100, 110, 99, 105, 1, 2, 3, 4, 5, 6, 7, 80.1],
    );
    assert.equal(sheetCandleDate('2026-08-17T09:15:00+05:30'), '2026-08-17');
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
      { ok: true, contract: 'NIFTY2681824300CE', interval: '2m', candle_time: '2026-08-17T09:15:00+05:30', open: 1, high: 2, low: 1, close: 1.5, delta: 1 },
      { ok: true, contract: 'NIFTY2681824300CE', interval: '2m', candle_time: '2026-08-17T09:17:00+05:30', delta: 2 },
      { ok: true, contract: 'CRUDEOIL-I', interval: '5m', candle_time: '2026-08-17T09:15:00+05:30', delta: 3 },
    ]);
    assert.equal(n, 3);
    assert.equal(appended[0].range, sheetA1(tab2, 'A1'));
    assert.deepEqual(appended[0].requestBody.values[0].slice(0, 6), [
      '2026-08-17T09:15:00', 1, 2, 1, 1.5, 1,
    ]);
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

  it('retainSession drops previous-day rows and keeps today on the current schema', async () => {
    const tab = sheetTabName('NIFTY-I', '2m');
    const today = [
      '2026-08-18T09:15:00', 100, 110, 99, 105, 8, 9, 10, 11, 12, 13, 14, 20.2,
    ];
    const calls = { get: [], update: [], clear: [], batchUpdate: [] };
    const titles = new Set([tab]);
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    sink.sheetsApi = {
      spreadsheets: {
        get: async () => ({ data: { sheets: [...titles].map((title) => ({ properties: { title } })) } }),
        batchUpdate: async (req) => { calls.batchUpdate.push(req); return {}; },
        values: {
          get: async (req) => {
            calls.get.push(req);
            return {
              data: {
                values: [
                  SHEET_COLUMNS,
                  ['2026-08-17T09:15:00', 90, 95, 88, 92, 1, 2, 3, 4, 5, 6, 7, 10.1],
                  today,
                ],
              },
            };
          },
          update: async (req) => { calls.update.push(req); return {}; },
          clear: async (req) => { calls.clear.push(req); return {}; },
        },
      },
    };

    const dropped = await sink.retainSession('NIFTY-I', ['2m'], '2026-08-18');
    assert.equal(dropped, 1);
    assert.equal(calls.clear.length, 1);
    assert.equal(calls.update.length, 1);
    assert.deepEqual(calls.update[0].requestBody.values[0], today);
    assert.equal(sink.keys.has(`${tab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.keys.has(`${tab}\t2026-08-18T09:15:00`), true);
  });

  it('retainSession remaps vwap1 onto vwap while keeping OHLC', async () => {
    const tab = sheetTabName('NIFTY-I', '2m');
    const legacyHeader = [
      'candle_time', 'open', 'high', 'low', 'close',
      'delta', 'max_delta', 'max_vol_b', 'max_vol_s',
      'poc', 'volume', 'oi_change', 'vwap1', 'vwap2',
    ];
    const calls = { get: [], update: [], clear: [], batchUpdate: [] };
    const titles = new Set([tab]);
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    sink.sheetsApi = {
      spreadsheets: {
        get: async () => ({ data: { sheets: [...titles].map((title) => ({ properties: { title } })) } }),
        batchUpdate: async (req) => { calls.batchUpdate.push(req); return {}; },
        values: {
          get: async (req) => {
            calls.get.push(req);
            return {
              data: {
                values: [
                  legacyHeader,
                  ['2026-08-17T09:15:00+05:30', 90, 95, 88, 92, 1, 2, 3, 4, 5, 6, 7, 10.1, 11],
                  ['2026-08-18T09:15:00+05:30', 100, 110, 99, 105, 8, 9, 10, 11, 12, 13, 14, 20.2, 21],
                ],
              },
            };
          },
          update: async (req) => { calls.update.push(req); return {}; },
          clear: async (req) => { calls.clear.push(req); return {}; },
        },
      },
    };

    const dropped = await sink.retainSession('NIFTY-I', ['2m'], '2026-08-18');
    assert.equal(dropped, 1);
    assert.equal(calls.clear.length, 1);
    assert.deepEqual(calls.update[0].requestBody.values[0], SHEET_COLUMNS);
    assert.deepEqual(calls.update[1].requestBody.values[0], [
      '2026-08-18T09:15:00', 100, 110, 99, 105, 8, 9, 10, 11, 12, 13, 14, 20.2,
    ]);
    assert.equal(sink.keys.has(`${tab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.keys.has(`${tab}\t2026-08-18T09:15:00`), true);
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
    assert.equal(rows[0].open, 1);
    assert.equal(rows[0].high, 2);
    assert.equal(rows[0].low, 1);
    assert.equal(rows[0].close, 2);
    assert.equal(rows[0].oi_change, '');
    assert.equal(rows[0].vwap, 1.67);
    assert.equal(rows[0].vwap2, undefined);
    assert.deepEqual(rowToSheetValues(rows[0]).slice(0, 5), [
      '2026-08-17T09:15:00', 1, 2, 1, 2,
    ]);
  });
});
