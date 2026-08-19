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
  allStaticTabNames,
  tabIdentity,
  csvRowKey,
  selectNewCsvRows,
  shouldRewriteHeader,
} from './columns.js';
import { ConfigSheet, SheetsSink, sheetA1 } from './sheets.js';
import { closedRowsForInterval } from './collect.js';

describe('sheet helpers', () => {
  it('names tabs from the config slot and timeframe letter', () => {
    assert.equal(sheetTabName(1, 0), '1A');
    assert.equal(sheetTabName(1, 1), '1B');
    assert.equal(sheetTabName(1, 2), '1C');
    assert.equal(sheetTabName(2, 0), '2A');
    assert.equal(sheetTabName(6, 2), '6C');
    assert.deepEqual(allStaticTabNames(2, 3), ['1A', '1B', '1C', '2A', '2B', '2C']);
    assert.equal(tabIdentity(1, '2m', 'NSE:FUTURE:NIFTY-I'), '1|2m|NSE:FUTURE:NIFTY-I');
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
  function identityHeader(identity) {
    const header = [...SHEET_COLUMNS];
    while (header.length < 26) header.push('');
    header.push(identity);
    return header;
  }

  it('appends unseen rows grouped by static slot tabs', async () => {
    const appended = [];
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    const tab2 = sheetTabName(1, 0);
    const tab5 = sheetTabName(2, 2);
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
      { ok: true, slot: 1, intervals: ['2m', '3m', '5m'], interval: '2m', candle_time: '2026-08-17T09:15:00+05:30', open: 1, high: 2, low: 1, close: 1.5, delta: 1 },
      { ok: true, slot: 1, intervals: ['2m', '3m', '5m'], interval: '2m', candle_time: '2026-08-17T09:17:00+05:30', delta: 2 },
      { ok: true, slot: 2, intervals: ['2m', '3m', '5m'], interval: '5m', candle_time: '2026-08-17T09:15:00+05:30', delta: 3 },
    ]);
    assert.equal(n, 3);
    assert.equal(tab2, '1A');
    assert.equal(tab5, '2C');
    assert.equal(appended[0].range, sheetA1(tab2, 'A1'));
    assert.deepEqual(appended[0].requestBody.values[0].slice(0, 6), [
      '2026-08-17T09:15:00', 1, 2, 1, 1.5, 1,
    ]);
    assert.equal(appended[1].range, sheetA1(tab5, 'A1'));
  });

  it('dropInstrument forgets old keys for that slot and leaves other slots', () => {
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    const oldTab = sheetTabName(1, 0);
    const keepTab = sheetTabName(2, 0);
    sink.keys.add(`${oldTab}\t2026-08-17T09:15:00`);
    sink.keys.add(`${keepTab}\t2026-08-17T09:15:00`);
    sink.loadedTabs.add(oldTab);
    sink.loadedTabs.add(keepTab);
    sink.dropInstrument({ slot: 1, intervals: ['2m', '3m', '5m'] });
    assert.equal(sink.keys.has(`${oldTab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.keys.has(`${keepTab}\t2026-08-17T09:15:00`), true);
    assert.equal(sink.loadedTabs.has(oldTab), false);
  });

  it('retainSession drops previous-day rows and keeps today on the current schema', async () => {
    const tab = sheetTabName(1, 0);
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

    const dropped = await sink.retainSession(
      { slot: 1, symbol: 'NIFTY-I', id: 'NSE:FUTURE:NIFTY-I', intervals: ['2m'] },
      '2026-08-18',
    );
    assert.equal(dropped, 1);
    assert.equal(calls.clear.length, 1);
    assert.equal(calls.update.length, 1);
    assert.deepEqual(calls.update[0].requestBody.values[0], today);
    assert.equal(sink.keys.has(`${tab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.keys.has(`${tab}\t2026-08-18T09:15:00`), true);
  });

  it('retainSession remaps vwap1 onto vwap while keeping OHLC', async () => {
    const tab = sheetTabName(1, 0);
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

    const dropped = await sink.retainSession(
      { slot: 1, symbol: 'NIFTY-I', id: 'NSE:FUTURE:NIFTY-I', intervals: ['2m'] },
      '2026-08-18',
    );
    assert.equal(dropped, 1);
    assert.equal(calls.clear.length, 1);
    assert.deepEqual(calls.update[0].requestBody.values[0], SHEET_COLUMNS);
    assert.deepEqual(calls.update[1].requestBody.values[0], [
      '2026-08-18T09:15:00', 100, 110, 99, 105, 8, 9, 10, 11, 12, 13, 14, 20.2,
    ]);
    assert.equal(sink.keys.has(`${tab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.keys.has(`${tab}\t2026-08-18T09:15:00`), true);
  });

  it('overwrites a static tab when the symbol or timeframe changes', async () => {
    const tab = sheetTabName(1, 0);
    const calls = { get: [], update: [], clear: [], batchUpdate: [] };
    const titles = new Set(['1A', '1B', '1C']);
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
                  identityHeader('1|2m|NSE:FUTURE:NIFTY-I'),
                  ['2026-08-17T09:15:00', 90, 95, 88, 92, 1, 2, 3, 4, 5, 6, 7, 10.1],
                ],
              },
            };
          },
          update: async (req) => { calls.update.push(req); return {}; },
          clear: async (req) => { calls.clear.push(req); return {}; },
        },
      },
    };

    await sink.ensureInstrument({
      slot: 1,
      symbol: 'NIFTY2681824300CE',
      id: 'NSE:OPTIONS:NIFTY2681824300CE',
      intervals: ['5m'],
    });
    assert.equal(calls.clear.length > 0, true);
    assert.equal(
      calls.update.some((req) => req.range === sheetA1(tab, 'AA1')
        && req.requestBody.values[0][0] === '1|5m|NSE:OPTIONS:NIFTY2681824300CE'),
      true,
    );
    assert.equal(sink.keys.has(`${tab}\t2026-08-17T09:15:00`), false);
    assert.equal(calls.batchUpdate.length, 0);
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
    slot: 1,
    intervals: ['5m'],
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
    assert.equal(rows[0].slot, 1);
    assert.deepEqual(rows[0].intervals, ['5m']);
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

describe('ConfigSheet', () => {
  it('reads timeframe columns C onward from the config tab', async () => {
    const ranges = [];
    const sheet = new ConfigSheet({
      spreadsheetId: 'sheet',
      tab: 'config',
      sheetsApi: {
        spreadsheets: {
          values: {
            get: async (req) => {
              ranges.push(req.range);
              return {
                data: {
                  values: [
                    ['email', 'trader@example.com'],
                    ['password', 'secret'],
                    ['Instrument1', 'NSE:FUTURE:NIFTY-I', '2m', '3m', '5m'],
                    ['Instrument2', 'NSE:OPTIONS:NIFTY2681824100CE', '5m', '10m'],
                    ['Instrument3', 'NSE:OPTIONS:NIFTY2681824300CE'],
                  ],
                },
              };
            },
          },
        },
      },
    });
    const cfg = await sheet.read();
    assert.equal(ranges[0], sheetA1('config', 'A1:Z100'));
    assert.deepEqual(
      cfg.instruments.map((i) => ({ slot: i.slot, id: i.id, intervals: i.intervals })),
      [
        { slot: 1, id: 'NSE:FUTURE:NIFTY-I', intervals: ['2m', '3m', '5m'] },
        { slot: 2, id: 'NSE:OPTIONS:NIFTY2681824100CE', intervals: ['5m', '10m'] },
      ],
    );
    assert.equal(cfg.warnings.length, 1);
  });
});
