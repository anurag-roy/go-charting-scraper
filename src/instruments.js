const ALLOWED_EXCHANGES = new Set(['NSE', 'BSE', 'MCX']);

/** Config tab slots `Instrument1` … `InstrumentN` (same A/B vertical layout). */
export const MAX_INSTRUMENTS = 6;

export function instrumentConfigKeys(max = MAX_INSTRUMENTS) {
  return Array.from({ length: max }, (_, i) => `instrument${i + 1}`);
}

export function normalizeConfigKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function symbolId(instrument) {
  return `${instrument.exchange}:${instrument.segment}:${instrument.symbol}`;
}

export function parseInstrumentId(raw) {
  const s = String(raw || '').trim().replace(/\//g, ':');
  if (!s) throw new Error('empty instrument');
  const parts = s.split(':').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) {
    throw new Error(`invalid instrument "${raw}" (expected EXCHANGE:CATEGORY:SYMBOL)`);
  }
  const exchange = parts[0].toUpperCase();
  const segment = parts[1].toUpperCase();
  const symbol = parts.slice(2).join(':');
  if (!ALLOWED_EXCHANGES.has(exchange)) {
    throw new Error(`unsupported exchange "${parts[0]}" in "${raw}" (use NSE, BSE, or MCX)`);
  }
  if (!segment || !symbol) {
    throw new Error(`invalid instrument "${raw}" (expected EXCHANGE:CATEGORY:SYMBOL)`);
  }
  return { exchange, segment, symbol, id: `${exchange}:${segment}:${symbol}` };
}

/** GoCharting minute interval, e.g. `2m`, `10m`. Empty string if the cell is blank. */
export function parseIntervalToken(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d+)\s*m(?:in(?:ute)?s?)?$/i) || s.match(/^(\d+)$/);
  if (!m) {
    throw new Error(`unsupported interval "${raw}" (use minute bars such as 2m, 5m, 10m)`);
  }
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 1440) {
    throw new Error(`unsupported interval "${raw}" (use 1m–1440m)`);
  }
  return `${n}m`;
}

/**
 * Timeframe cells from a config row (columns C–E). Blank cells are ignored.
 * There is no default list — an empty result means generate nothing.
 */
export function parseIntervalCells(cells) {
  const intervals = [];
  const seen = new Set();
  const errors = [];
  for (const cell of cells || []) {
    const parts = String(cell ?? '').split(/[,;]+/);
    for (const part of parts) {
      try {
        const iv = parseIntervalToken(part);
        if (!iv || seen.has(iv)) continue;
        seen.add(iv);
        intervals.push(iv);
      } catch (err) {
        errors.push(err.message || String(err));
      }
    }
  }
  return { intervals, errors };
}

export function instrumentIntervals(instrument) {
  return Array.isArray(instrument?.intervals)
    ? instrument.intervals.map((iv) => String(iv || '').trim()).filter(Boolean)
    : [];
}

export function sameIntervals(a, b) {
  const x = instrumentIntervals({ intervals: a });
  const y = instrumentIntervals({ intervals: b });
  return x.length === y.length && x.every((iv, i) => iv === y[i]);
}

function cellValue(row, index) {
  if (!row || row[index] == null) return '';
  return String(row[index]);
}

export function parseConfigRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || row[0] == null || String(row[0]).trim() === '') continue;
    map.set(normalizeConfigKey(row[0]), {
      value: cellValue(row, 1),
      extra: Array.isArray(row) ? row.slice(2, 5) : [],
    });
  }

  const email = String(map.get('email')?.value || '').trim();
  const password = String(map.get('password')?.value ?? '');
  const instruments = [];
  const seen = new Set();
  const errors = [];
  const warnings = [];

  instrumentConfigKeys().forEach((key, idx) => {
    const slot = `Instrument${idx + 1}`;
    const entry = map.get(key);
    const raw = String(entry?.value || '').trim();
    if (!raw) return;
    try {
      const inst = parseInstrumentId(raw);
      const parsed = parseIntervalCells(entry?.extra || []);
      for (const err of parsed.errors) errors.push(`${slot}: ${err}`);
      if (!parsed.intervals.length) {
        warnings.push(`${slot} (${inst.id}) has no candle timeframes; skipping`);
        return;
      }
      if (seen.has(inst.id)) return;
      seen.add(inst.id);
      instruments.push({ ...inst, slot: idx + 1, intervals: parsed.intervals });
    } catch (err) {
      errors.push(err.message || String(err));
    }
  });

  return { email, password, instruments, errors, warnings };
}

export function configFingerprint(cfg) {
  return JSON.stringify({
    email: cfg?.email || '',
    password: cfg?.password || '',
    instruments: (cfg?.instruments || []).map((i) => ({
      slot: i.slot,
      id: i.id,
      intervals: instrumentIntervals(i),
    })),
  });
}

export function configSummary(cfg) {
  return {
    email: cfg?.email || '',
    passwordSet: Boolean(cfg?.password),
    instruments: (cfg?.instruments || []).map((i) => ({
      slot: i.slot,
      id: i.id,
      intervals: instrumentIntervals(i),
    })),
  };
}

export function instrumentSlot(instrument, fallbackIndex = 0) {
  const n = Number(instrument?.slot);
  if (Number.isInteger(n) && n >= 1) return n;
  return fallbackIndex + 1;
}

export function reconcileInstruments(prev, next) {
  const prevList = prev || [];
  const nextList = next || [];
  const prevBySlot = new Map(prevList.map((i, idx) => [instrumentSlot(i, idx), i]));
  const nextBySlot = new Map(nextList.map((i, idx) => [instrumentSlot(i, idx), i]));
  const slots = [...new Set([...prevBySlot.keys(), ...nextBySlot.keys()])].sort((a, b) => a - b);
  const added = [];
  const removed = [];
  const replaced = [];
  const kept = [];
  const updated = [];
  for (const slot of slots) {
    const a = prevBySlot.get(slot);
    const b = nextBySlot.get(slot);
    if (!a && b) added.push(b);
    else if (a && !b) removed.push(a);
    else if (a.id !== b.id) replaced.push({ from: a, to: b });
    else {
      kept.push(b);
      if (!sameIntervals(a.intervals, b.intervals)) updated.push(b);
    }
  }
  return { added, removed, replaced, kept, updated };
}

export function isUsableConfig(cfg) {
  return Boolean(
    cfg?.email
    && cfg?.password
    && cfg.instruments?.some((i) => instrumentIntervals(i).length),
  );
}
