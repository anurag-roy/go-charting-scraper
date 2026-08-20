import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHEET_COLUMNS,
  formatSheetCandleTime,
  isFilledOhlcValue,
  isLegacyVwapHeader,
  mapSheetRow,
  rowHasOhlc,
  rowToSheetValues,
  scaleSheetPrice,
  selectSheetWrites,
  sheetCandleDate,
  sheetDisplaySymbol,
  sheetMaxDelta,
  sheetRowMissingOhlc,
  sheetRowNeedsPatch,
  sheetTabName,
  allStaticTabNames,
  tabIdentity,
  TAB_IDENTITY_CELL,
  TAB_IDENTITY_INDEX,
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
    assert.equal(TAB_IDENTITY_CELL, 'Z1');
    assert.equal(TAB_IDENTITY_INDEX, 25);
  });

  it('strips a trailing timezone offset from candle_time', () => {
    assert.equal(formatSheetCandleTime('2026-08-17T09:15:00+05:30'), '2026-08-17T09:15:00');
  });

  it('writes a leading contract symbol, scaled OHLC/VWAP, and clamped max_delta', () => {
    const values = rowToSheetValues({
      contract: 'NIFTY26AUG24050CE',
      symbol: 'NSE:OPTIONS:NIFTY26AUG24050CE',
      candle_time: '2026-08-17T09:15:00+05:30',
      open: 17250,
      high: 17300,
      low: 17100,
      close: 17250,
      delta: 40,
      max_delta: -80,
      max_vol_b: 50,
      max_vol_s: 30,
      poc: 24300,
      volume: 150,
      oi_change: 12,
      vwap: 17249.6,
    });
    assert.deepEqual(values, [
      'NIFTY26AUG24050CE',
      '2026-08-17T09:15:00',
      172.5, 173, 171, 172.5,
      40, 0, 50, 30, 24300, 150, 12, 172.5,
    ]);
    assert.equal(sheetDisplaySymbol('NSE:OPTIONS:NIFTY26AUG24050CE'), 'NIFTY26AUG24050CE');
    assert.equal(sheetMaxDelta(''), 0);
    assert.equal(sheetMaxDelta(-5), 0);
    assert.equal(sheetMaxDelta(12), 12);
    assert.equal(scaleSheetPrice(17250), 172.5);
    assert.deepEqual(SHEET_COLUMNS, [
      'symbol', 'candle_time', 'open', 'high', 'low', 'close',
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
    assert.equal(isLegacyVwapHeader(legacy, SHEET_COLUMNS.slice(1)), true);
    assert.equal(shouldRewriteHeader(legacy, SHEET_COLUMNS), true);
    assert.equal(shouldRewriteHeader(SHEET_COLUMNS, SHEET_COLUMNS), false);
    assert.deepEqual(
      mapSheetRow(
        legacy,
        ['2026-08-17T09:15:00+05:30', 17250, 17300, 17100, 17250, 1, 2, 3, 4, 5, 6, 7, 8010, 99],
        SHEET_COLUMNS,
        { symbol: 'NIFTY-I' },
      ),
      ['NIFTY-I', '2026-08-17T09:15:00', 172.5, 173, 171, 172.5, 1, 2, 3, 4, 5, 6, 7, 80.1],
    );
    assert.equal(sheetCandleDate('2026-08-17T09:15:00+05:30'), '2026-08-17');
  });

  it('detects rows that still need an OHLC bar and selects them for patch', () => {
    assert.equal(rowHasOhlc({ open: 1, close: 2 }), true);
    assert.equal(rowHasOhlc({ open: '', close: 2 }), false);
    assert.equal(sheetRowMissingOhlc(SHEET_COLUMNS, [
      'NIFTY-I', '2026-08-17T09:15:00', '', 1.1, 0.99, '', 1, 2, 3, 4, 5, 6, '', '',
    ]), true);
    const tab = '1A';
    const keys = new Set([`${tab}\t2026-08-17T09:15:00`, `${tab}\t2026-08-17T09:17:00`]);
    const incomplete = new Set([`${tab}\t2026-08-17T09:15:00`]);
    const { append, patch } = selectSheetWrites(
      keys,
      incomplete,
      [
        { ok: true, slot: 1, intervals: ['2m'], interval: '2m', candle_time: '2026-08-17T09:15:00+05:30', open: 100, close: 105 },
        { ok: true, slot: 1, intervals: ['2m'], interval: '2m', candle_time: '2026-08-17T09:17:00+05:30', open: 106, close: 107 },
        { ok: true, slot: 1, intervals: ['2m'], interval: '2m', candle_time: '2026-08-17T09:19:00+05:30', open: 108, close: 109 },
      ],
      () => tab,
    );
    assert.deepEqual(append.map((r) => r.candle_time), ['2026-08-17T09:19:00+05:30']);
    assert.deepEqual(patch.map((r) => r.candle_time), ['2026-08-17T09:15:00+05:30']);
  });

  it('treats a blank max_delta as incomplete even when OHLC is filled', () => {
    const row = [
      'NIFTY-I', '2026-08-19T10:25:00', 2412.8, 2412.8, 2412.1, 2412.14, -3770, '', 1560, 4745, 241250, 12610, -2145, 2414.67,
    ];
    assert.equal(sheetRowMissingOhlc(SHEET_COLUMNS, row), false);
    assert.equal(sheetRowNeedsPatch(SHEET_COLUMNS, row), true);
    assert.equal(isFilledOhlcValue(0), true);
  });
});

describe('SheetsSink', () => {
  function identityHeader(identity) {
    const header = [...SHEET_COLUMNS];
    while (header.length < 25) header.push('');
    header.push(identity);
    return header;
  }

  it('appends unseen rows grouped by static slot tabs', async () => {
    const appended = [];
    const sink = new SheetsSink({
      spreadsheetId: 'sheet',
    });
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
      { ok: true, slot: 1, intervals: ['2m', '3m', '5m'], interval: '2m', contract: 'NIFTY-I', candle_time: '2026-08-17T09:15:00+05:30', open: 17250, high: 17300, low: 17100, close: 17250, delta: 1, max_delta: 80 },
      { ok: true, slot: 1, intervals: ['2m', '3m', '5m'], interval: '2m', candle_time: '2026-08-17T09:17:00+05:30', delta: 2 },
      { ok: true, slot: 2, intervals: ['2m', '3m', '5m'], interval: '5m', contract: 'BANKNIFTY-I', candle_time: '2026-08-17T09:15:00+05:30', delta: 3 },
    ]);
    assert.equal(n, 3);
    assert.equal(tab2, '1A');
    assert.equal(tab5, '2C');
    assert.equal(appended[0].range, sheetA1(tab2, 'A1'));
    assert.deepEqual(appended[0].requestBody.values[0].slice(0, 7), [
      'NIFTY-I', '2026-08-17T09:15:00', 172.5, 173, 171, 172.5, 1,
    ]);
    assert.equal(appended[1].range, sheetA1(tab5, 'A1'));
    assert.equal(sink.incompleteKeys.has(`${tab2}\t2026-08-17T09:17:00`), true);
    assert.equal(sink.incompleteKeys.has(`${tab2}\t2026-08-17T09:15:00`), false);
  });

  it('patches existing rows that were stored without open/close', async () => {
    const tab = sheetTabName(1, 0);
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    sink.loadedTabs.add(tab);
    sink.keys.add(`${tab}\t2026-08-17T09:15:00`);
    sink.incompleteKeys.add(`${tab}\t2026-08-17T09:15:00`);
    const calls = { get: [], batchUpdate: [], append: [] };
    sink.sheetsApi = {
      spreadsheets: {
        values: {
          get: async (req) => {
            calls.get.push(req);
            return {
              data: {
                values: [
                  SHEET_COLUMNS,
                  ['NIFTY-I', '2026-08-17T09:15:00', '', 1.1, 0.99, '', 1, 2, 3, 4, 5, 6, '', ''],
                ],
              },
            };
          },
          batchUpdate: async (req) => {
            calls.batchUpdate.push(req);
            return {};
          },
          append: async (req) => {
            calls.append.push(req);
            return {};
          },
        },
      },
    };

    const n = await sink.writeRows([
      {
        ok: true,
        slot: 1,
        intervals: ['2m', '3m', '5m'],
        interval: '2m',
        contract: 'NIFTY-I',
        candle_time: '2026-08-17T09:15:00+05:30',
        open: 10000,
        high: 11000,
        low: 9900,
        close: 10500,
        delta: 1,
        max_delta: 2,
        oi_change: 12,
        vwap: 10150,
      },
    ]);
    assert.equal(n, 1);
    assert.equal(calls.append.length, 0);
    assert.equal(calls.batchUpdate.length, 1);
    assert.equal(calls.batchUpdate[0].requestBody.data[0].range, sheetA1(tab, 'A2'));
    assert.deepEqual(calls.batchUpdate[0].requestBody.data[0].values[0].slice(0, 6), [
      'NIFTY-I', '2026-08-17T09:15:00', 100, 110, 99, 105,
    ]);
    assert.equal(sink.incompleteKeys.has(`${tab}\t2026-08-17T09:15:00`), false);
  });

  it('patches a stored row whose max_delta was left blank because it was 0', async () => {
    const tab = sheetTabName(1, 2);
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    sink.loadedTabs.add(tab);
    sink.keys.add(`${tab}\t2026-08-19T10:25:00`);
    sink.incompleteKeys.add(`${tab}\t2026-08-19T10:25:00`);
    const calls = { get: [], batchUpdate: [], append: [] };
    sink.sheetsApi = {
      spreadsheets: {
        values: {
          get: async () => {
            calls.get.push(true);
            return {
              data: {
                values: [
                  SHEET_COLUMNS,
                  ['NIFTY-I', '2026-08-19T10:25:00', 2412.8, 2412.8, 2412.1, 2412.14, -3770, '', 1560, 4745, 241250, 12610, -2145, 2414.67],
                ],
              },
            };
          },
          batchUpdate: async (req) => {
            calls.batchUpdate.push(req);
            return {};
          },
          append: async (req) => {
            calls.append.push(req);
            return {};
          },
        },
      },
    };

    const n = await sink.writeRows([
      {
        ok: true,
        slot: 1,
        intervals: ['2m', '3m', '5m'],
        interval: '5m',
        contract: 'NIFTY-I',
        candle_time: '2026-08-19T10:25:00+05:30',
        open: 241280,
        high: 241280,
        low: 241210,
        close: 241214,
        delta: -3770,
        max_delta: 0,
        max_vol_b: 1560,
        max_vol_s: 4745,
        poc: 241250,
        volume: 12610,
        oi_change: -2145,
        vwap: 241467.38,
      },
    ]);
    assert.equal(n, 1);
    assert.equal(calls.append.length, 0);
    assert.equal(calls.batchUpdate.length, 1);
    assert.equal(calls.batchUpdate[0].requestBody.data[0].values[0][7], 0);
    assert.equal(sink.incompleteKeys.has(`${tab}\t2026-08-19T10:25:00`), false);
  });

  it('dropInstrument forgets old keys for that slot and leaves other slots', () => {
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    const oldTab = sheetTabName(1, 0);
    const keepTab = sheetTabName(2, 0);
    sink.keys.add(`${oldTab}\t2026-08-17T09:15:00`);
    sink.keys.add(`${keepTab}\t2026-08-17T09:15:00`);
    sink.incompleteKeys.add(`${oldTab}\t2026-08-17T09:15:00`);
    sink.loadedTabs.add(oldTab);
    sink.loadedTabs.add(keepTab);
    sink.dropInstrument({ slot: 1, intervals: ['2m', '3m', '5m'] });
    assert.equal(sink.keys.has(`${oldTab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.incompleteKeys.has(`${oldTab}\t2026-08-17T09:15:00`), false);
    assert.equal(sink.keys.has(`${keepTab}\t2026-08-17T09:15:00`), true);
    assert.equal(sink.loadedTabs.has(oldTab), false);
  });

  it('retainSession drops previous-day rows and keeps today on the current schema', async () => {
    const tab = sheetTabName(1, 0);
    const today = [
      'NIFTY-I', '2026-08-18T09:15:00', 1, 1.1, 0.99, 1.05, 8, 9, 10, 11, 12, 13, 14, 0.2,
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
                  ['NIFTY-I', '2026-08-17T09:15:00', 0.9, 0.95, 0.88, 0.92, 1, 2, 3, 4, 5, 6, 7, 0.1],
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
      'NIFTY-I', '2026-08-18T09:15:00', 1, 1.1, 0.99, 1.05, 8, 9, 10, 11, 12, 13, 14, 0.2,
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
      calls.update.some((req) => req.range === sheetA1(tab, TAB_IDENTITY_CELL)
        && req.requestBody.values[0][0] === '1|5m|NSE:OPTIONS:NIFTY2681824300CE'),
      true,
    );
    assert.equal(sink.keys.has(`${tab}\t2026-08-17T09:15:00`), false);
    assert.equal(calls.batchUpdate.length, 0);
  });

  it('checks and initializes all static headers with batched calls', async () => {
    const calls = { meta: 0, addTabs: 0, batchGet: 0, batchRanges: 0, writeHeaders: [] };
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    sink.sheetsApi = {
      spreadsheets: {
        get: async () => {
          calls.meta += 1;
          return { data: { sheets: [] } };
        },
        batchUpdate: async () => {
          calls.addTabs += 1;
          return {};
        },
        values: {
          batchGet: async (req) => {
            calls.batchGet += 1;
            calls.batchRanges = req.ranges.length;
            return {
              data: {
                valueRanges: req.ranges.map((range, i) => (
                  i === 0 ? { range, values: [SHEET_COLUMNS] } : { range }
                )),
              },
            };
          },
          batchUpdate: async (req) => {
            calls.writeHeaders.push(req);
            return {};
          },
        },
      },
    };

    await sink.ensureStaticTabs();
    await sink.ensureStaticTabs();

    assert.equal(calls.meta, 1);
    assert.equal(calls.addTabs, 1);
    assert.equal(calls.batchGet, 1);
    assert.equal(calls.writeHeaders.length, 1);
    assert.equal(calls.writeHeaders[0].requestBody.data.length, calls.batchRanges - 1);
  });

  it('appends independent tabs concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const appendRequests = [];
    const sink = new SheetsSink({ spreadsheetId: 'sheet' });
    const intervals = ['2m', '3m', '5m'];
    for (let i = 0; i < intervals.length; i += 1) {
      sink.loadedTabs.add(sheetTabName(1, i));
    }
    sink.sheetsApi = {
      spreadsheets: {
        values: {
          append: async (req) => {
            appendRequests.push(req);
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active -= 1;
            return {};
          },
        },
      },
    };

    const n = await sink.writeRows(intervals.map((interval, i) => ({
      ok: true,
      slot: 1,
      intervals,
      interval,
      contract: 'NIFTY-I',
      candle_time: '2026-08-17T09:' + String(15 + i).padStart(2, '0') + ':00+05:30',
      delta: i,
      max_delta: i,
    })));

    assert.equal(n, 3);
    assert.equal(maxActive, 3);
    assert.equal(appendRequests.length, 3);
    assert.equal(appendRequests.every((req) => req.insertDataOption === 'OVERWRITE'), true);
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
    assert.deepEqual(rowToSheetValues(rows[0]).slice(0, 6), [
      'NIFTY-I', '2026-08-17T09:15:00', 0.01, 0.02, 0.01, 0.02,
    ]);
  });
});

describe('ConfigSheet', () => {
  it('reads timeframe columns C–E from the config tab', async () => {
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
                    ['Instrument1', 'NSE:FUTURE:NIFTY-I', '2m', '3m', '5m', 'personal notes'],
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
    assert.equal(ranges[0], sheetA1('config', 'A1:E8'));
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
