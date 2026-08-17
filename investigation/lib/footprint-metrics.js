const num = (v) => {
  if (v && typeof v === 'object' && 'toNumber' in v) return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return undefined;
}

function hasOwn(obj, ...keys) {
  if (!obj) return false;
  return keys.some((k) => obj[k] != null);
}

/**
 * Order-flow stats for one footprint candle.
 *
 * Delta is buy volume minus sell volume (not options-Greeks delta).
 * Max/min delta are the server's intra-bar cumulative-delta extremes.
 * POC is the price level with the most total (buy+sell) volume.
 */
export function footprintMetrics(candle) {
  const levels = candle?.footprint || [];
  const es = candle?.endingSummary || candle?.ending_summary || {};
  const totals = candle?.totals || {};

  let maxBuy = 0;
  let maxSell = 0;
  let maxBuyLevel = '';
  let maxSellLevel = '';
  let poc = '';
  let pocVolume = -1;
  let fpHigh = -Infinity;
  let fpLow = Infinity;
  let vwapPv = 0;
  let vwapVol = 0;

  for (const l of levels) {
    const b = num(l.buy?.volume);
    const s = num(l.sell?.volume);
    const px = num(l.level);
    const tot = b + s;
    if (b > maxBuy) {
      maxBuy = b;
      maxBuyLevel = px;
    }
    if (s > maxSell) {
      maxSell = s;
      maxSellLevel = px;
    }
    if (tot > pocVolume) {
      pocVolume = tot;
      poc = px;
    }
    if (tot > 0) {
      vwapPv += px * tot;
      vwapVol += tot;
      if (px > fpHigh) fpHigh = px;
      if (px < fpLow) fpLow = px;
    }
  }

  const totalsBuy = num(totals.buy?.volume);
  const totalsSell = num(totals.sell?.volume);
  const overall = num(totals.overall?.volume);
  const volume = overall || totalsBuy + totalsSell;
  const deltaRecomputed = totalsBuy - totalsSell;
  const delta = hasOwn(es, 'closeDelta', 'close_delta')
    ? num(pick(es, 'closeDelta', 'close_delta'))
    : deltaRecomputed;
  const maxDelta = hasOwn(es, 'maxDelta', 'max_delta')
    ? num(pick(es, 'maxDelta', 'max_delta'))
    : '';
  const minDelta = hasOwn(es, 'minDelta', 'min_delta')
    ? num(pick(es, 'minDelta', 'min_delta'))
    : '';

  const esHigh = num(es.high);
  const esLow = num(es.low);
  const serverBuy = num(candle?.max?.buy?.volume);
  const serverSell = num(candle?.max?.sell?.volume);

  return {
    candle_time: candle?.date || '',
    max_vol_b: serverBuy,
    max_vol_s: serverSell,
    totals_buy: totalsBuy,
    totals_sell: totalsSell,
    volume,
    delta,
    max_delta: maxDelta,
    min_delta: minDelta,
    delta_recomputed: deltaRecomputed,
    poc: pocVolume >= 0 ? poc : '',
    poc_volume: pocVolume >= 0 ? pocVolume : '',
    price_levels: levels.length,
    recomputed_max_b: maxBuy,
    recomputed_max_s: maxSell,
    max_vol_b_level: maxBuyLevel,
    max_vol_s_level: maxSellLevel,
    values_match: serverBuy === maxBuy && serverSell === maxSell,
    delta_match: delta === deltaRecomputed,
    fp_high: esHigh || (Number.isFinite(fpHigh) ? fpHigh : ''),
    fp_low: esLow || (Number.isFinite(fpLow) ? fpLow : ''),
    // Per-bar VWAP from footprint levels (GoCharting bar statistics). Ticks.
    vwap: vwapVol > 0 ? Number((vwapPv / vwapVol).toFixed(2)) : '',
  };
}

export function previousOhlcBar(bars, candleTime) {
  const sorted = [...(bars || [])]
    .filter((b) => b?.time)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const exact = sorted.findIndex((b) => b.time === candleTime);
  if (exact > 0) return sorted[exact - 1];
  const t = Date.parse(candleTime);
  if (!Number.isFinite(t)) return null;
  let prev = null;
  for (const b of sorted) {
    const bt = Date.parse(b.time);
    if (Number.isFinite(bt) && bt < t) prev = b;
    if (Number.isFinite(bt) && bt >= t) break;
  }
  return prev;
}

export function oiFields(bar, bars) {
  if (!bar || bar.oi == null || bar.oi === '') {
    return { oi: '', oi_change: '' };
  }
  const oi = num(bar.oi);
  const prev = previousOhlcBar(bars, bar.time);
  if (!prev || prev.oi == null || prev.oi === '') {
    return { oi, oi_change: '' };
  }
  return { oi, oi_change: oi - num(prev.oi) };
}
