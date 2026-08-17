import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SheetsSink, sheetA1 } from './sheets-sink.js';

describe('SheetsSink.writeRows', () => {
  it('appends only unseen closed rows grouped by interval tab', async () => {
    const appended = [];
    const sink = new SheetsSink({
      sheetId: 'sheet',
      googleClientEmail: 'sa@example.com',
      googlePrivateKey: 'fake',
    });
    sink.keys.add('2m\tt1');
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
      { ok: true, interval: '2m', candle_time: 't1', open: 1 },
      { ok: true, interval: '2m', candle_time: 't2', open: 2 },
      { ok: true, interval: '5m', candle_time: 't2', open: 3 },
    ]);
    assert.equal(n, 2);
    assert.equal(appended.length, 2);
    assert.equal(appended[0].range, sheetA1('2m', 'A1'));
    assert.equal(appended[1].range, sheetA1('5m', 'A1'));
    assert.equal(appended[0].spreadsheetId, 'sheet');
    assert.equal(sink.keys.has('2m\tt2'), true);
    assert.equal(sink.keys.has('5m\tt2'), true);
  });
});
