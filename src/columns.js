/** Slim schema written to Google Sheets. */
export const SHEET_COLUMNS = [
  'candle_time',
  'open',
  'high',
  'low',
  'close',
  'delta',
  'max_delta',
  'max_vol_b',
  'max_vol_s',
  'poc',
  'volume',
  'oi_change',
  'vwap',
];

const VWAP_HEADER_ALIASES = ['vwap', 'vwap1', 'vwap2'];

/** Wider debug schema for optional local CSV. */
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
  'delta',
  'max_delta',
  'min_delta',
  'poc',
  'poc_volume',
  'volume',
  'oi',
  'oi_change',
  'vwap',
];

export function csvRowKey(symbol, interval, candleTime) {
  return `${symbol}\t${interval}\t${candleTime}`;
}

/** Drop a trailing numeric offset (`+05:30` / `-04:00`). Times are already IST. */
export function formatSheetCandleTime(iso) {
  return String(iso || '').replace(/[+-]\d{2}:\d{2}$/, '');
}

/** Always-present letters per instrument slot (`1A`, `1B`, `1C`). */
export const STATIC_INTERVAL_LETTERS = 3;

/**
 * Column Z on each data tab stores `slot|interval|instrumentId`.
 * New Google sheets are 26 columns wide (A–Z); AA is out of range.
 */
export const TAB_IDENTITY_INDEX = 25;
export const TAB_IDENTITY_CELL = 'Z1';

export function intervalLetter(index) {
  if (!Number.isInteger(index) || index < 0 || index > 25) return '';
  return String.fromCharCode(65 + index);
}

/**
 * Static tab title: Instrument1’s first timeframe → `1A`, second → `1B`, etc.
 * `intervalIndex` is 0-based (`0` → A).
 */
export function sheetTabName(slot, intervalIndex) {
  const n = Number(slot);
  const letter = intervalLetter(intervalIndex);
  if (!Number.isInteger(n) || n < 1 || !letter) return '';
  return sanitizeTabName(`${n}${letter}`);
}

export function sheetTabNamesFor(instrument, minLetters = STATIC_INTERVAL_LETTERS) {
  const nIvs = Array.isArray(instrument?.intervals) ? instrument.intervals.length : 0;
  const count = Math.max(minLetters, nIvs);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const name = sheetTabName(instrument?.slot, i);
    if (name) out.push(name);
  }
  return out;
}

export function allStaticTabNames(slotCount, letterCount = STATIC_INTERVAL_LETTERS) {
  const out = [];
  for (let slot = 1; slot <= slotCount; slot += 1) {
    for (let i = 0; i < letterCount; i += 1) out.push(sheetTabName(slot, i));
  }
  return out;
}

export function tabIdentity(slot, interval, instrumentId) {
  const iv = String(interval || '').trim();
  if (!iv) return '';
  return `${slot}|${iv}|${instrumentId || ''}`;
}

export function identityFromHeader(header) {
  return String(header?.[TAB_IDENTITY_INDEX] ?? '').trim();
}

/** Header cells used for schema checks, ignoring the Z identity cell. */
export function headerWithoutIdentity(header) {
  const copy = Array.isArray(header) ? header.slice() : [];
  if (copy.length > TAB_IDENTITY_INDEX) copy.splice(TAB_IDENTITY_INDEX, 1);
  while (copy.length && String(copy[copy.length - 1] ?? '') === '') copy.pop();
  return copy;
}

export function sanitizeTabName(name) {
  return String(name || '')
    .replace(/[\[\]:*?/\\]/g, '_')
    .slice(0, 100);
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

export function selectNewCsvRows(keys, rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row?.ok || !row.candle_time) continue;
    const k = csvRowKey(row.symbol, row.interval, row.candle_time);
    if (keys.has(k)) continue;
    out.push(row);
  }
  return out;
}

export function headersMatch(header, columns) {
  return Array.isArray(header)
    && Array.isArray(columns)
    && header.length === columns.length
    && header.every((h, i) => h === columns[i]);
}

export function isPrefixHeader(header, columns) {
  return Array.isArray(header)
    && header.length > 0
    && header.length < columns.length
    && header.every((h, i) => h === columns[i]);
}

function vwapLegacyHeaders(columns) {
  const base = (columns || []).filter((c) => !VWAP_HEADER_ALIASES.includes(c));
  return [
    [...base, 'vwap'],
    [...base, 'vwap1'],
    [...base, 'vwap1', 'vwap2'],
  ];
}

/** Previous schemas used a trailing `vwap`, `vwap1`, or `vwap1`+`vwap2`. */
export function isLegacyVwapHeader(header, columns) {
  if (!Array.isArray(header) || !header.length) return false;
  if (headersMatch(header, columns)) return false;
  return vwapLegacyHeaders(columns).some((legacy) => headersMatch(header, legacy));
}

export function shouldRewriteHeader(header, columns) {
  const data = headerWithoutIdentity(header);
  if (!Array.isArray(data) || !data.length) return true;
  if (headersMatch(data, columns)) return false;
  return isPrefixHeader(data, columns) || isLegacyVwapHeader(data, columns);
}

/** IST calendar date (`YYYY-MM-DD`) from a sheet `candle_time` value. */
export function sheetCandleDate(iso) {
  return formatSheetCandleTime(iso).slice(0, 10);
}

/**
 * Project a stored sheet row onto the current column list.
 * `vwap1` is copied into `vwap` when the live header is the old split schema.
 */
export function mapSheetRow(header, row, columns = SHEET_COLUMNS) {
  const get = (name) => {
    const i = (header || []).indexOf(name);
    return i >= 0 ? (row?.[i] ?? '') : '';
  };
  return columns.map((col) => {
    if (col === 'candle_time') return formatSheetCandleTime(get('candle_time'));
    if (col === 'vwap') return get('vwap') || get('vwap1') || '';
    return get(col);
  });
}
