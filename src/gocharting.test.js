import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { allocOhlcIdx, FootprintClient, loadProtos } from './gocharting.js';
import { loadConfig } from './env.js';

describe('loadProtos', () => {
  it('loads footprint and OHLC types from src/proto', async () => {
    const { FP, OHLC } = await loadProtos(loadConfig().protoDir);
    assert.equal(FP.name, 'FootPrintForDateResponse');
    assert.equal(OHLC.name, 'OHLCBarResult');
  });
});

describe('allocOhlcIdx', () => {
  it('gives each in-flight request a distinct pane index and reuses freed slots', () => {
    const inUse = new Set();
    assert.equal(allocOhlcIdx(inUse), 0);
    assert.equal(allocOhlcIdx(inUse), 1);
    assert.equal(allocOhlcIdx(inUse), 2);
    inUse.delete(1);
    assert.equal(allocOhlcIdx(inUse), 1);
  });
});

describe('FootprintClient OHLC idxs', () => {
  function openClient() {
    const sent = [];
    const client = new FootprintClient({ FP: {}, OHLC: {} });
    client.ws = {
      readyState: WebSocket.OPEN,
      send(json) { sent.push(JSON.parse(json)); },
    };
    return { client, sent };
  }

  function completeOhlc(client, requestId) {
    const p = client.pending.get(String(requestId));
    if (p) p.bars.push({ time: 't', open: 1, close: 1 });
    client.finish(String(requestId));
  }

  it('does not reuse idxs across concurrent TS/V2 adds for the same interval', async () => {
    const { client, sent } = openClient();
    const nifty = { exchange: 'NSE', segment: 'FUTURE', symbol: 'NIFTY-I' };
    const bank = { exchange: 'NSE', segment: 'FUTURE', symbol: 'BANKNIFTY-I' };
    const p1 = client.requestOhlc(nifty, '2m', 30_000);
    const p2 = client.requestOhlc(bank, '2m', 30_000);
    const p3 = client.requestOhlc(nifty, '3m', 30_000);

    const adds = sent.filter((m) => m.action === 'add');
    const idxs = adds.map((m) => m.payload.idxs[0]).sort((a, b) => a - b);
    assert.equal(adds.length, 3);
    assert.deepEqual(idxs, [0, 1, 2]);
    assert.equal(new Set(adds.map((m) => m.payload.symbol)).size, 2);

    for (const msg of adds) completeOhlc(client, msg.request_id);
    await Promise.all([p1, p2, p3]);

    const removes = sent.filter((m) => m.action === 'remove');
    assert.equal(removes.length, 3);

    const p4 = client.requestOhlc(nifty, '5m', 30_000);
    const lastAdd = sent.filter((m) => m.action === 'add').at(-1);
    assert.equal(lastAdd.payload.idxs[0], 0);
    completeOhlc(client, lastAdd.request_id);
    await p4;
  });
});
