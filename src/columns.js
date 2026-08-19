/** Slim schema written to Google Sheets. */
export const SHEET_COLUMNS = [
  'symbol',
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

/** GoCharting stores prices as integer ticks; sheet OHLC/VWAP are ticks / 100. */
export const SHEET_PRICE_SCALE = 100;
const SHEET_PRICE_COLUMNS = new Set(['open', 'high', 'low', 'close', 'vwap']);

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

/** Contract code only (`NIFTY26AUG24050CE`), not `NSE:OPTIONS:…`. */
export function sheetDisplaySymbol(rowOrId) {
  if (rowOrId && typeof rowOrId === 'object') {
    const contract = String(rowOrId.contract || '').trim();
    if (contract) return contract;
    return sheetDisplaySymbol(rowOrId.symbol);
  }
  const id = String(rowOrId || '').trim();
  const parts = id.split(':').map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? parts.slice(2).join(':') : id;
}

export function sheetDisplaySymbolFromIdentity(identity) {
  const parts = String(identity || '').split('|');
  return sheetDisplaySymbol(parts[2] || '');
}

export function scaleSheetPrice(v, { decimals = 2 } = {}) {
  if (!isFilledOhlcValue(v)) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return Number((n / SHEET_PRICE_SCALE).toFixed(decimals));
}

export function sheetMaxDelta(v) {
  if (!isFilledOhlcValue(v)) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function isLegacyUnprefixedSheetHeader(header, columns = SHEET_COLUMNS) {
  const data = Array.isArray(header) ? headerWithoutIdentity(header) : [];
  if (!data.length || columns[0] !== 'symbol' || data[0] === 'symbol') return false;
  const rest = columns.slice(1);
  return headersMatch(data, rest)
    || isPrefixHeader(data, rest)
    || isLegacyVwapHeader(data, rest);
}

export function sheetCandleTimeFromValues(values, columns = SHEET_COLUMNS) {
  const i = columns.indexOf('candle_time');
  return formatSheetCandleTime(i >= 0 ? values?.[i] : '');
}

export function rowToSheetValues(row) {
  return SHEET_COLUMNS.map((c) => {
    if (c === 'symbol') return sheetDisplaySymbol(row);
    if (c === 'candle_time') return formatSheetCandleTime(row.candle_time);
    if (SHEET_PRICE_COLUMNS.has(c)) return scaleSheetPrice(row[c]);
    if (c === 'max_delta') return sheetMaxDelta(row.max_delta);
    const v = row[c];
    return v == null ? '' : v;
  });
}

export function isFilledOhlcValue(v) {
  if (v == null) return false;
  return String(v).trim() !== '';
}

export function rowHasOhlc(row) {
  return isFilledOhlcValue(row?.open) && isFilledOhlcValue(row?.close);
}

/** True when a stored sheet row is missing open or close (footprint-only fallback). */
export function sheetRowMissingOhlc(header, values) {
  const cols = Array.isArray(header) && header.length ? header : SHEET_COLUMNS;
  const iOpen = cols.indexOf('open');
  const iClose = cols.indexOf('close');
  const open = iOpen >= 0 ? values?.[iOpen] : values?.[cols.indexOf('open')];
  const close = iClose >= 0 ? values?.[iClose] : values?.[cols.indexOf('close')];
  return !isFilledOhlcValue(open) || !isFilledOhlcValue(close);
}

export function sheetRowMissingMaxDelta(header, values) {
  const cols = Array.isArray(header) && header.length ? header : SHEET_COLUMNS;
  const i = cols.indexOf('max_delta');
  if (i < 0) return false;
  return !isFilledOhlcValue(values?.[i]);
}

/** Rows that should be rewritten on a later sample (blank OHLC and/or blank max_delta). */
export function sheetRowNeedsPatch(header, values) {
  return sheetRowMissingOhlc(header, values) || sheetRowMissingMaxDelta(header, values);
}

export function selectSheetWrites(keys, incompleteKeys, rows, tabForRow) {
  const append = [];
  const patch = [];
  for (const row of rows || []) {
    if (!row?.ok || !row.candle_time) continue;
    const tab = tabForRow(row);
    if (!tab) continue;
    const k = sheetRowKey(tab, row.candle_time);
    if (!keys.has(k)) append.push(row);
    else if (incompleteKeys?.has(k) && rowHasOhlc(row)) patch.push(row);
  }
  return { append, patch };
}

export function selectNewSheetRows(keys, rows, tabForRow) {
  return selectSheetWrites(keys, null, rows, tabForRow).append;
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
  return isPrefixHeader(data, columns)
    || isLegacyVwapHeader(data, columns)
    || isLegacyUnprefixedSheetHeader(data, columns);
}

/** IST calendar date (`YYYY-MM-DD`) from a sheet `candle_time` value. */
export function sheetCandleDate(iso) {
  return formatSheetCandleTime(iso).slice(0, 10);
}

/**
 * Project a stored sheet row onto the current column list.
 * `vwap1` is copied into `vwap` when the live header is the old split schema.
 * Pre-symbol tabs (OHLC in integer ticks) are scaled for display.
 */
export function mapSheetRow(header, row, columns = SHEET_COLUMNS, { symbol } = {}) {
  const dataHeader = headerWithoutIdentity(header);
  const get = (name) => {
    const i = (header || []).indexOf(name);
    return i >= 0 ? (row?.[i] ?? '') : '';
  };
  const legacyPrices = isLegacyUnprefixedSheetHeader(dataHeader, columns);
  return columns.map((col) => {
    if (col === 'symbol') return symbol || get('symbol') || '';
    if (col === 'candle_time') return formatSheetCandleTime(get('candle_time'));
    if (col === 'vwap') {
      const raw = get('vwap') || get('vwap1') || '';
      return legacyPrices ? scaleSheetPrice(raw) : raw;
    }
    if (SHEET_PRICE_COLUMNS.has(col)) {
      const raw = get(col);
      return legacyPrices ? scaleSheetPrice(raw) : raw;
    }
    if (col === 'max_delta') return sheetMaxDelta(get('max_delta'));
    return get(col);
  });
}
