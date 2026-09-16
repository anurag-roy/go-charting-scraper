import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  allocOhlcIdx,
  FootprintClient,
  isFatalFootprintError,
  loadProtos,
  notificationMessage,
  notificationSymbolKey,
  stripHtml,
} from './gocharting.js';
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

describe('GoCharting footprint notifications', () => {
  const mcxNote = {
    command: 'NOTIFICATION',
    in: {
      exchange: 'MCX',
      segment: 'FUTURE',
      symbol: 'CRUDEOIL-I',
      interval: '5m',
      dates: ['2026-09-16'],
      session: 'RTH',
    },
    out: {
      message: 'Orderflow on MCX:CRUDEOIL-I is available when you purchase the "MCX Premium" or "India All Premium" plan, see <a target="_blank" href="/pricing">pricing</a> for details.',
      message_type: 'html',
      dismissable: true,
    },
  };

  function openClient() {
    const sent = [];
    const client = new FootprintClient({ FP: {}, OHLC: {} });
    client.ws = {
      readyState: WebSocket.OPEN,
      send(json) { sent.push(JSON.parse(json)); },
    };
    return { client, sent };
  }

  it('strips HTML from plan notifications', () => {
    const msg = notificationMessage(mcxNote);
    assert.match(msg, /MCX Premium/);
    assert.match(msg, /India All Premium/);
    assert.doesNotMatch(msg, /<a /);
    assert.equal(notificationSymbolKey(mcxNote), 'MCX:FUTURE:CRUDEOIL-I');
    assert.equal(isFatalFootprintError(msg), true);
    assert.equal(isFatalFootprintError('no candles'), false);
    assert.equal(stripHtml('see <a href="/pricing">pricing</a> now'), 'see pricing now');
  });

  it('fails the matching footprint request immediately', async () => {
    const { client, sent } = openClient();
    const crude = { exchange: 'MCX', segment: 'FUTURE', symbol: 'CRUDEOIL-I' };
    const nifty = { exchange: 'NSE', segment: 'FUTURE', symbol: 'NIFTY-I' };
    const crudeP = client.requestOne(crude, '5m', ['2026-09-16'], 30_000);
    const niftyP = client.requestOne(nifty, '5m', ['2026-09-16'], 30_000);
    client.handleText(JSON.stringify(mcxNote));
    const crudeRes = await crudeP;
    assert.equal(crudeRes.ok, false);
    assert.equal(crudeRes.candles.length, 0);
    assert.match(crudeRes.error, /MCX Premium/);
    assert.equal(client.pending.size, 1);
    const niftyId = String(sent.find((m) => m.payload?.symbol === 'NIFTY-I').request_id);
    client.finish(niftyId);
    const niftyRes = await niftyP;
    assert.equal(niftyRes.ok, false);
    assert.equal(niftyRes.error, 'no candles');
  });

  it('does not retry later dates after a premium rejection', async () => {
    const { client, sent } = openClient();
    const crude = { exchange: 'MCX', segment: 'FUTURE', symbol: 'CRUDEOIL-I' };
    const p = client.requestInterval(crude, '5m', ['2026-09-16', '2026-09-15', '2026-09-14'], 30_000);
    assert.equal(sent.filter((m) => m.command === 'FOOTPRINT/V2').length, 1);
    client.handleText(JSON.stringify(mcxNote));
    const res = await p;
    assert.equal(res.ok, false);
    assert.match(res.error, /MCX Premium/);
    assert.equal(sent.filter((m) => m.command === 'FOOTPRINT/V2' && !m.payload?.ref).length, 1);
  });
});
