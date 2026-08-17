export const TZ = 'Asia/Kolkata';

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function parseHHmm(value, fallback) {
  const raw = String(value || fallback || '').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`invalid HH:MM value: ${value}`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

export function zonedParts(date, timeZone = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return {
    year: g('year'),
    month: g('month'),
    day: g('day'),
    hour: g('hour'),
    minute: g('minute'),
    second: g('second'),
  };
}

export function istDateString(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatIst(date) {
  const p = zonedParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+05:30`;
}

export function istNow(date = new Date()) {
  return formatIst(date);
}

export function intervalMinutes(interval) {
  const m = String(interval || '').trim().match(/^(\d+)\s*m$/i);
  if (!m) throw new Error(`unsupported interval: ${interval}`);
  return Number(m[1]);
}

export function istInstant(dateStr, h, m, s = 0) {
  return Date.parse(`${dateStr}T${pad2(h)}:${pad2(m)}:${pad2(s)}+05:30`);
}

export function marketWindowMs(dateStr, open = '09:15', close = '15:40') {
  const o = parseHHmm(open, '09:15');
  const c = parseHHmm(close, '15:40');
  return {
    openMs: istInstant(dateStr, o.h, o.m),
    closeMs: istInstant(dateStr, c.h, c.m),
  };
}

export function inSession(candleTimeIso, { open = '09:15', close = '15:40' } = {}) {
  const start = Date.parse(candleTimeIso);
  if (!Number.isFinite(start)) return false;
  const dateStr = istDateString(new Date(start));
  const { openMs, closeMs } = marketWindowMs(dateStr, open, close);
  return start >= openMs && start < closeMs;
}

export function isCandleClosed(candleTimeIso, interval, nowMs, {
  open = '09:15',
  close = '15:40',
  graceMs = 2000,
} = {}) {
  const start = Date.parse(candleTimeIso);
  if (!Number.isFinite(start)) return false;
  const dateStr = istDateString(new Date(start));
  const { closeMs } = marketWindowMs(dateStr, open, close);
  const naturalClose = start + intervalMinutes(interval) * 60_000;
  const closeAt = Math.min(naturalClose, closeMs);
  return nowMs >= closeAt + Number(graceMs || 0);
}

export function isBeforeOpen(nowMs, { open = '09:15', close = '15:40' } = {}) {
  const dateStr = istDateString(new Date(nowMs));
  const { openMs } = marketWindowMs(dateStr, open, close);
  return nowMs < openMs;
}

export function isAfterClose(nowMs, { open = '09:15', close = '15:40' } = {}) {
  const dateStr = istDateString(new Date(nowMs));
  const { closeMs } = marketWindowMs(dateStr, open, close);
  return nowMs >= closeMs;
}

export function sessionDatesFor(nowMs, { open = '09:15' } = {}) {
  const persist = persistSessionDate(nowMs, { open });
  const today = istDateString(new Date(nowMs));
  const yesterday = istDateString(new Date(nowMs - 12 * 3_600_000));
  const dayBefore = istDateString(new Date(nowMs - 36 * 3_600_000));
  return [...new Set([persist, today, yesterday, dayBefore])];
}

export function weekdayShortIst(nowMs) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
  }).format(new Date(nowMs));
}

export function isWeekendIst(nowMs) {
  const d = weekdayShortIst(nowMs);
  return d === 'Sat' || d === 'Sun';
}

export function persistSessionDate(nowMs, { open = '09:15' } = {}) {
  let t = nowMs;
  for (let i = 0; i < 10; i += 1) {
    if (isWeekendIst(t) || isBeforeOpen(t, { open })) {
      t -= 12 * 3_600_000;
      continue;
    }
    return istDateString(new Date(t));
  }
  return istDateString(new Date(nowMs));
}

export function isPersistableCandle(candleTimeIso, nowMs, {
  open = '09:15',
  close = '15:40',
} = {}) {
  if (!inSession(candleTimeIso, { open, close })) return false;
  const start = Date.parse(candleTimeIso);
  const candleDate = istDateString(new Date(start));
  return candleDate === persistSessionDate(nowMs, { open });
}
