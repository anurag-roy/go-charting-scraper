import { instrumentIntervals, symbolId } from './instruments.js';
import { footprintMetrics, oiFields, vwapByCandleTime } from './metrics.js';
import { candleCloseMs, isCandleClosed, isPersistableCandle, marketWindowMs, persistSessionDate } from './session.js';
import { dedupeOhlcBars, findOhlcBar } from './gocharting.js';

function indexOhlcBars(bars) {
  const sorted = (bars || [])
    .filter((bar) => bar?.time)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const byTime = new Map();
  const byInstant = new Map();
  const previous = new Map();
  let prior = null;
  for (const bar of sorted) {
    byTime.set(bar.time, bar);
    const instant = Date.parse(bar.time);
    if (Number.isFinite(instant)) byInstant.set(instant, bar);
    previous.set(bar, prior);
    prior = bar;
  }
  return { byTime, byInstant, previous };
}

export function candleToRow({
  instrument,
  interval,
  candle,
  ohlcBars,
  vwapMap,
  ohlcIndex,
  sampled_at_utc,
  sampled_at_ist,
  sample_n,
  candlesInResponse,
  error,
}) {
  const stats = candle ? footprintMetrics(candle) : {};
  const candleInstant = Date.parse(stats.candle_time);
  const bar = candle && ohlcIndex
    ? (ohlcIndex.byTime.get(stats.candle_time) || ohlcIndex.byInstant.get(candleInstant) || null)
    : (candle ? findOhlcBar(ohlcBars, stats.candle_time) : null);
  const previousBar = bar && ohlcIndex ? (ohlcIndex.previous.get(bar) ?? null) : undefined;
  const high = bar ? bar.high : (candle ? stats.fp_high : '');
  const low = bar ? bar.low : (candle ? stats.fp_low : '');
  const oi = bar
    ? (ohlcIndex ? oiFields(bar, ohlcBars, previousBar) : oiFields(bar, ohlcBars))
    : { oi: '', oi_change: '' };
  const vwap = bar && vwapMap ? (vwapMap.get(bar.time) ?? '') : '';
  return {
    sampled_at_utc,
    sampled_at_ist,
    sample_n,
    interval,
    slot: instrument.slot,
    intervals: instrumentIntervals(instrument),
    symbol: symbolId(instrument),
    contract: instrument.symbol,
    candle_time: stats.candle_time || '',
    open: bar ? bar.open : '',
    high: high ?? '',
    low: low ?? '',
    close: bar ? bar.close : '',
    ohlc_volume: bar ? bar.volume : '',
    max_vol_b: candle ? stats.max_vol_b : '',
    max_vol_s: candle ? stats.max_vol_s : '',
    max_vol_b_level: candle ? stats.max_vol_b_level : '',
    max_vol_s_level: candle ? stats.max_vol_s_level : '',
    totals_buy: candle ? stats.totals_buy : '',
    totals_sell: candle ? stats.totals_sell : '',
    price_levels: candle ? stats.price_levels : '',
    recomputed_max_b: candle ? stats.recomputed_max_b : '',
    recomputed_max_s: candle ? stats.recomputed_max_s : '',
    values_match: candle ? stats.values_match : '',
    candles_in_response: candlesInResponse,
    ok: Boolean(candle),
    error: candle ? '' : (error || 'no candle'),
    delta: candle ? stats.delta : '',
    max_delta: candle ? stats.max_delta : '',
    min_delta: candle ? stats.min_delta : '',
    poc: candle ? stats.poc : '',
    poc_volume: candle ? stats.poc_volume : '',
    volume: candle ? stats.volume : '',
    oi: oi.oi,
    oi_change: oi.oi_change,
    vwap,
  };
}

export function closedRowsForInterval({
  instrument,
  interval,
  candles,
  ohlcBars,
  nowMs,
  sessionOpts,
  sampled_at_utc,
  sampled_at_ist,
  sample_n,
  error,
}) {
  const sessionDate = persistSessionDate(nowMs, sessionOpts);
  const { openMs, closeMs } = marketWindowMs(sessionDate, sessionOpts?.open, sessionOpts?.close);
  const sessionBars = (ohlcBars || []).filter((bar) => {
    const t = Date.parse(bar?.time);
    return Number.isFinite(t) && t >= openMs && t < closeMs;
  });
  const vwapMap = vwapByCandleTime(sessionBars);
  const ohlcIndex = indexOhlcBars(ohlcBars);
  const closed = (candles || [])
    .filter((c) => isPersistableCandle(c.date, nowMs, sessionOpts))
    .filter((c) => isCandleClosed(c.date, interval, nowMs, sessionOpts))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  return closed.map((candle) => candleToRow({
    instrument,
    interval,
    candle,
    ohlcBars,
    vwapMap,
    ohlcIndex,
    sampled_at_utc,
    sampled_at_ist,
    sample_n,
    candlesInResponse: (candles || []).length,
    error,
  }));
}

export function nextIntervalFetchAt(candles, interval, sessionOpts = {}) {
  let latest = -Infinity;
  for (const candle of candles || []) {
    const t = Date.parse(candle?.date);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  if (!Number.isFinite(latest)) return null;
  const closeAt = candleCloseMs(new Date(latest).toISOString(), interval, sessionOpts);
  if (!Number.isFinite(closeAt)) return null;
  return closeAt + Number(sessionOpts.graceMs || 0);
}

export async function sampleInstruments({
  client,
  instruments,
  intervalsFor = instrumentIntervals,
  sessionDatesFor,
  sessionOptsFor,
  nowMs,
  sampled_at_utc,
  sampled_at_ist,
  sample_n,
}) {
  const rows = [];
  const summaries = [];
  await Promise.all((instruments || []).map(async (instrument) => {
    const ivs = intervalsFor(instrument) || [];
    if (!ivs.length) return;
    const sessionOpts = sessionOptsFor(instrument, nowMs);
    const dates = sessionDatesFor(nowMs, sessionOpts);
    const results = await Promise.all(ivs.map(async (iv) => {
      const [fp, ohlc] = await Promise.all([
        client.requestInterval(instrument, iv, dates),
        client.requestOhlc(instrument, iv),
      ]);
      return { interval: iv, fp, ohlc };
    }));
    for (const { interval, fp, ohlc } of results) {
      const ohlcBars = dedupeOhlcBars([
        ...(ohlc?.bars || []),
        ...client.ohlcCollector.getBars(symbolId(instrument), interval),
      ]);
      const closed = closedRowsForInterval({
        instrument,
        interval,
        candles: fp?.candles || [],
        ohlcBars,
        nowMs,
        sessionOpts,
        sampled_at_utc,
        sampled_at_ist,
        sample_n,
        error: fp?.error,
      });
      rows.push(...closed);
      const ohlcMiss = closed.filter((r) => r.open === '' || r.close === '').length;
      summaries.push({
        id: instrument.id,
        interval,
        closed: closed.length,
        candles: (fp?.candles || []).length,
        ohlcBars: ohlcBars.length,
        ohlcMiss,
        nextFetchAt: fp?.ok ? nextIntervalFetchAt(fp.candles, interval, sessionOpts) : null,
        error: fp?.ok ? '' : (fp?.error || ''),
      });
    }
  }));
  return { rows, summaries };
}
