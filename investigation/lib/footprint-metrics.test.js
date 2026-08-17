import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { footprintMetrics, oiFields, previousOhlcBar } from './footprint-metrics.js';

describe('footprintMetrics', () => {
  const candle = {
    date: '2026-08-17T10:00:00+05:30',
    ending_summary: {
      close_delta: 40,
      max_delta: 80,
      min_delta: -10,
      high: 101,
      low: 99,
    },
    totals: {
      overall: { volume: 150 },
      buy: { volume: 95 },
      sell: { volume: 55 },
    },
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
    assert.equal(m.delta_recomputed, 40);
    assert.equal(m.delta_match, true);
    assert.equal(m.max_delta, 80);
    assert.equal(m.min_delta, -10);
    assert.equal(m.volume, 150);
    assert.equal(m.max_vol_b, 50);
    assert.equal(m.max_vol_s, 30);
    assert.equal(m.poc, 100);
    assert.equal(m.poc_volume, 80);
    assert.equal(m.values_match, true);
    // (99*15 + 100*80 + 101*55) / 150
    assert.equal(m.vwap, 100.27);
  });

  it('falls back to buy minus sell when close_delta is missing', () => {
    const m = footprintMetrics({
      ...candle,
      ending_summary: {},
    });
    assert.equal(m.delta, 40);
    assert.equal(m.max_delta, '');
  });

  it('treats a zero close_delta as real, not missing', () => {
    const m = footprintMetrics({
      date: 't',
      endingSummary: { closeDelta: 0, maxDelta: 5, minDelta: -3 },
      totals: { buy: { volume: 10 }, sell: { volume: 10 } },
      max: { buy: { volume: 4 }, sell: { volume: 4 } },
      footprint: [{ level: 1, buy: { volume: 4 }, sell: { volume: 4 } }],
    });
    assert.equal(m.delta, 0);
    assert.equal(m.delta_match, true);
  });
});

describe('oiFields', () => {
  const bars = [
    { time: '2026-08-17T09:15:00+05:30', oi: 1000 },
    { time: '2026-08-17T09:20:00+05:30', oi: 1250 },
    { time: '2026-08-17T09:25:00+05:30', oi: 1100 },
  ];

  it('uses the previous OHLC bar for OI change', () => {
    assert.deepEqual(
      oiFields(bars[1], bars),
      { oi: 1250, oi_change: 250 },
    );
    assert.deepEqual(
      oiFields(bars[2], bars),
      { oi: 1100, oi_change: -150 },
    );
  });

  it('leaves oi_change empty on the first bar', () => {
    assert.deepEqual(oiFields(bars[0], bars), { oi: 1000, oi_change: '' });
  });

  it('finds the previous bar when times are not an exact list match', () => {
    const prev = previousOhlcBar(bars, '2026-08-17T09:20:00+05:30');
    assert.equal(prev.oi, 1000);
  });
});

describe('per-bar VWAP', () => {
  it('volume-weights footprint price levels and rounds ticks/100 like the chart', () => {
    const m = footprintMetrics({
      date: '2026-08-17T15:35:00+05:30',
      totals: { overall: { volume: 200 } },
      max: { buy: { volume: 1 }, sell: { volume: 1 } },
      footprint: [
        { level: 7873, buy: { volume: 80 }, sell: { volume: 70 } },
        { level: 7800, buy: { volume: 20 }, sell: { volume: 30 } },
      ],
    });
    // (7873*150 + 7800*50) / 200 = 7854.75
    assert.equal(m.vwap, 7854.75);
    assert.equal(Math.round(m.vwap / 100), 79);
  });
});
