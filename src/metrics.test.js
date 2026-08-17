import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { footprintMetrics, oiFields, typicalPrice, vwapByCandleTime } from './metrics.js';
import { OhlcCollector } from './gocharting.js';

describe('footprintMetrics', () => {
  const candle = {
    date: '2026-08-17T10:00:00+05:30',
    ending_summary: { close_delta: 40, max_delta: 80, min_delta: -10, high: 101, low: 99 },
    totals: { overall: { volume: 150 }, buy: { volume: 95 }, sell: { volume: 55 } },
    max: { buy: { volume: 50 }, sell: { volume: 30 } },
    footprint: [
      { level: 99, buy: { volume: 10 }, sell: { volume: 5 } },
      { level: 100, buy: { volume: 50 }, sell: { volume: 30 } },
      { level: 101, buy: { volume: 35 }, sell: { volume: 20 } },
    ],
  };

  it('maps delta, max delta, POC, volume, and max buy/sell', () => {
    const m = footprintMetrics(candle);
    assert.equal(m.delta, 40);
    assert.equal(m.volume, 150);
    assert.equal(m.poc, 100);
    assert.equal(m.values_match, true);
    assert.equal(m.vwap2, 100.27);
  });
});

describe('oiFields', () => {
  const bars = [
    { time: '2026-08-17T09:15:00+05:30', oi: 1000 },
    { time: '2026-08-17T09:20:00+05:30', oi: 1250 },
  ];
  it('uses the previous OHLC bar for OI change', () => {
    assert.deepEqual(oiFields(bars[1], bars), { oi: 1250, oi_change: 250 });
  });
});

describe('session VWAP (vwap1)', () => {
  it('uses typical price (H+L+C)/3 and resets daily', () => {
    assert.equal(typicalPrice({ high: 12, low: 6, close: 9 }), 9);
    const map = vwapByCandleTime([
      { time: '2026-08-17T09:15:00+05:30', high: 10, low: 8, close: 9, volume: 100 },
      { time: '2026-08-18T09:15:00+05:30', high: 20, low: 20, close: 20, volume: 50 },
    ]);
    assert.equal(map.get('2026-08-17T09:15:00+05:30'), 9);
    assert.equal(map.get('2026-08-18T09:15:00+05:30'), 20);
  });
});

describe('OhlcCollector bounds', () => {
  it('evicts oldest bars and can drop a symbol', () => {
    const c = new OhlcCollector(null, { maxBars: 3 });
    c.merge('NSE:FUTURE:NIFTY-I', '2m', [
      { time: 't1' }, { time: 't2' }, { time: 't3' }, { time: 't4' },
    ]);
    assert.equal(c.getBars('NSE:FUTURE:NIFTY-I', '2m').length, 3);
    assert.equal(c.getBars('NSE:FUTURE:NIFTY-I', '2m').some((b) => b.time === 't1'), false);
    c.merge('MCX:FUTURE:CRUDEOIL-I', '2m', [{ time: 'c1' }]);
    c.dropSymbol('NSE:FUTURE:NIFTY-I');
    assert.equal(c.getBars('NSE:FUTURE:NIFTY-I', '2m').length, 0);
    assert.equal(c.getBars('MCX:FUTURE:CRUDEOIL-I', '2m').length, 1);
  });
});
