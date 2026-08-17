export const COLUMNS = [
  'sampled_at_utc',
  'sampled_at_ist',
  'sample_n',
  'interval',
  'symbol',
  'candle_time',
  'open',
  'high',
  'low',
  'close',
  'ohlc_volume',
  'max_vol_b',
  'max_vol_s',
  'max_vol_b_level',
  'max_vol_s_level',
  'totals_buy',
  'totals_sell',
  'price_levels',
  'recomputed_max_b',
  'recomputed_max_s',
  'values_match',
  'candles_in_response',
  'ok',
  'error',
];

export function rowKey(interval, candleTime) {
  return `${interval}\t${candleTime}`;
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowToValues(row) {
  return COLUMNS.map((c) => {
    const v = row[c];
    return v == null ? '' : v;
  });
}

export function rowToCsvLine(row) {
  return rowToValues(row).map(csvEscape).join(',');
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  const s = String(line || '').replace(/\r$/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function selectNewRows(keys, rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row?.ok || !row.candle_time) continue;
    const k = rowKey(row.interval, row.candle_time);
    if (keys.has(k)) continue;
    out.push(row);
  }
  return out;
}

export function symbolId(symbol) {
  return `${symbol.exchange}:${symbol.segment}:${symbol.symbol}`;
}
