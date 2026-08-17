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
  // Appended so existing CSV rows keep their column positions.
  'delta',
  'max_delta',
  'min_delta',
  'poc',
  'poc_volume',
  'volume',
  'oi',
  'oi_change',
  'vwap1',
  'vwap2',
];

/** Slim schema written to Google Sheets (CSV keeps the wider debug columns). */
export const SHEET_COLUMNS = [
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
];

export function rowKey(interval, candleTime) {
  return `${interval}\t${candleTime}`;
}

/** Drop a trailing numeric offset (`+05:30` / `-04:00`). Times are already IST. */
export function formatSheetCandleTime(iso) {
  return String(iso || '').replace(/[+-]\d{2}:\d{2}$/, '');
}

/** Tab title: contract id + interval, e.g. `NIFTY2681824300CE 5m`. */
export function sheetTabName(symbol, interval) {
  const sym = String(symbol || '').trim();
  const iv = String(interval || '').trim();
  if (sym && iv) return `${sym} ${iv}`;
  return sym || iv;
}

export function sheetRowKey(tab, candleTime) {
  return `${tab}\t${formatSheetCandleTime(candleTime)}`;
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

export function rowToSheetValues(row) {
  return SHEET_COLUMNS.map((c) => {
    if (c === 'candle_time') return formatSheetCandleTime(row.candle_time);
    const v = row[c];
    return v == null ? '' : v;
  });
}

export function selectNewSheetRows(keys, rows, tabForRow) {
  const out = [];
  for (const row of rows || []) {
    if (!row?.ok || !row.candle_time) continue;
    const tab = tabForRow(row);
    if (!tab) continue;
    const k = sheetRowKey(tab, row.candle_time);
    if (keys.has(k)) continue;
    out.push(row);
  }
  return out;
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

export function isPrefixHeader(header, columns) {
  return Array.isArray(header)
    && header.length > 0
    && header.length < columns.length
    && header.every((h, i) => h === columns[i]);
}

/** Previous schema ended in `vwap` before it was split into vwap1 / vwap2. */
export function isLegacyVwapHeader(header, columns) {
  if (!Array.isArray(header) || header.length !== columns.length - 1) return false;
  const legacy = columns.slice(0, -2).concat(['vwap']);
  return header.every((h, i) => h === legacy[i]);
}

export function symbolId(symbol) {
  return `${symbol.exchange}:${symbol.segment}:${symbol.symbol}`;
}
