import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SheetsSink, sheetA1 } from './sheets-sink.js';
import {
  SHEET_COLUMNS,
  formatSheetCandleTime,
  rowToSheetValues,
  sheetRowKey,
  sheetTabName,
} from './columns.js';

describe('sheet helpers', () => {
  it('names tabs with the contract id and interval', () => {
    assert.equal(sheetTabName('NIFTY2681824300CE', '5m'), 'NIFTY2681824300CE 5m');
    assert.equal(sheetTabName('NIFTY-I', '2m'), 'NIFTY-I 2m');
  });

  it('strips a trailing timezone offset from candle_time', () => {
    assert.equal(formatSheetCandleTime('2026-08-17T09:15:00+05:30'), '2026-08-17T09:15:00');
    assert.equal(formatSheetCandleTime('2026-08-17T09:15:00'), '2026-08-17T09:15:00');
  });

  it('writes only the slim sheet columns in order', () => {
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
      min_delta: -10,
    });
    assert.deepEqual(values, [
      '2026-08-17T09:15:00',
      40,
      80,
      50,
      30,
      24300,
      150,
      12,
      7800.5,
      7873.38,
    ]);
    assert.deepEqual(SHEET_COLUMNS, [
      'candle_time',
      'delta',
      'max_delta',
      'max_vol_b',
      'max_vol_s',
      'poc',
      'volume',
      'oi_change',
      'vwap1',
      'vwap2',
    ]);
  });
});

describe('SheetsSink.writeRows', () => {
  it('appends only unseen closed rows grouped by symbol+interval tab', async () => {
    const appended = [];
    const sink = new SheetsSink({
      sheetId: 'sheet',
      googleClientEmail: 'sa@example.com',
      googlePrivateKey: 'fake',
    });
    sink.symbol = 'NIFTY2681824300CE';
    const tab2 = sheetTabName('NIFTY2681824300CE', '2m');
    const tab5 = sheetTabName('NIFTY2681824300CE', '5m');
    sink.keys.add(sheetRowKey(tab2, '2026-08-17T09:15:00+05:30'));
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
      {
        ok: true,
        interval: '2m',
        candle_time: '2026-08-17T09:15:00+05:30',
        delta: 1,
      },
      {
        ok: true,
        interval: '2m',
        candle_time: '2026-08-17T09:17:00+05:30',
        delta: 2,
        vwap1: 10.1,
        vwap2: 10.5,
      },
      {
        ok: true,
        interval: '5m',
        candle_time: '2026-08-17T09:15:00+05:30',
        delta: 3,
      },
    ]);
    assert.equal(n, 2);
    assert.equal(appended.length, 2);
    assert.equal(appended[0].range, sheetA1(tab2, 'A1'));
    assert.equal(appended[1].range, sheetA1(tab5, 'A1'));
    assert.equal(appended[0].spreadsheetId, 'sheet');
    assert.deepEqual(appended[0].requestBody.values[0][0], '2026-08-17T09:17:00');
    assert.equal(sink.keys.has(sheetRowKey(tab2, '2026-08-17T09:17:00')), true);
    assert.equal(sink.keys.has(sheetRowKey(tab5, '2026-08-17T09:15:00+05:30')), true);
  });

  it('quotes tab names that contain spaces', () => {
    assert.equal(sheetA1('NIFTY2681824300CE 5m', 'A1'), "'NIFTY2681824300CE 5m'!A1");
  });
});
