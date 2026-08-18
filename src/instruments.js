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

export function parseConfigRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || row[0] == null || String(row[0]).trim() === '') continue;
    map.set(normalizeConfigKey(row[0]), row[1] == null ? '' : String(row[1]));
  }

  const email = String(map.get('email') || '').trim();
  const password = String(map.get('password') ?? '');
  const instruments = [];
  const seen = new Set();
  const errors = [];

  for (const key of instrumentConfigKeys()) {
    const raw = String(map.get(key) || '').trim();
    if (!raw) continue;
    try {
      const inst = parseInstrumentId(raw);
      if (seen.has(inst.id)) continue;
      seen.add(inst.id);
      instruments.push(inst);
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }

  return { email, password, instruments, errors };
}

export function configFingerprint(cfg) {
  return JSON.stringify({
    email: cfg?.email || '',
    password: cfg?.password || '',
    instruments: (cfg?.instruments || []).map((i) => i.id),
  });
}

export function configSummary(cfg) {
  return {
    email: cfg?.email || '',
    passwordSet: Boolean(cfg?.password),
    instruments: (cfg?.instruments || []).map((i) => i.id),
  };
}

export function reconcileInstruments(prev, next) {
  const prevList = prev || [];
  const nextList = next || [];
  const prevIds = new Set(prevList.map((i) => i.id));
  const nextIds = new Set(nextList.map((i) => i.id));
  return {
    added: nextList.filter((i) => !prevIds.has(i.id)),
    removed: prevList.filter((i) => !nextIds.has(i.id)),
    kept: nextList.filter((i) => prevIds.has(i.id)),
  };
}

export function isUsableConfig(cfg) {
  return Boolean(cfg?.email && cfg?.password && cfg.instruments?.length);
}
