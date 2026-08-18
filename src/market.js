import {
  formatIst,
  isAfterClose,
  isBeforeOpen,
  isWeekendIst,
  istDateString,
  marketWindowMs,
  nowInSession,
  persistSessionDate,
} from './session.js';

export const NSE_BSE_HOURS = { open: '09:15', close: '15:40' };

/** True when America/New_York is on daylight saving (EDT). */
export function isUsEasternDst(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
    hour: 'numeric',
  }).formatToParts(new Date(nowMs));
  return parts.find((p) => p.type === 'timeZoneName')?.value === 'EDT';
}

/**
 * Exchange session used to keep / close bars.
 *
 * NSE / BSE: 09:15–15:40 IST (equity derivatives).
 * MCX energy/bullion/metals: official 09:00–23:30 IST, extended to 23:55
 * while US Eastern is on daylight saving. Agri products close earlier; this
 * default matches CRUDEOIL / GOLD-style contracts.
 */
export function hoursForExchange(exchange, nowMs = Date.now()) {
  const ex = String(exchange || '').toUpperCase();
  if (ex === 'MCX') {
    return {
      open: '09:00',
      close: isUsEasternDst(nowMs) ? '23:55' : '23:30',
    };
  }
  return { ...NSE_BSE_HOURS };
}

export function sessionOptsFor(exchange, nowMs, extra = {}) {
  return { ...hoursForExchange(exchange, nowMs), ...extra };
}

export function nextOpenMs(exchange, nowMs) {
  for (let day = 0; day < 10; day += 1) {
    const probe = nowMs + day * 24 * 3_600_000;
    if (isWeekendIst(probe)) continue;
    const dateStr = istDateString(new Date(probe));
    const hours = hoursForExchange(exchange, probe);
    const { openMs, closeMs } = marketWindowMs(dateStr, hours.open, hours.close);
    if (nowMs >= openMs && nowMs < closeMs) return nowMs;
    if (openMs > nowMs) return openMs;
  }
  return nowMs + 60 * 60_000;
}

export function earliestOpenMs(instruments, nowMs) {
  let min = Infinity;
  for (const inst of instruments || []) {
    const t = nextOpenMs(inst.exchange, nowMs);
    if (t < min) min = t;
  }
  return Number.isFinite(min) ? min : nowMs + 30_000;
}

/**
 * Decide whether this instrument should be sampled now.
 *
 * - `sample`: live session (or just after close, to catch the last bars)
 * - `backfill`: today's closed session not yet persisted in this process
 * - `idle`: overnight, weekend, or a previous weekday (sheets keep only today)
 */
export function workForInstrument(instrument, nowMs, state, {
  afterCloseBufferMs = 60_000,
  graceMs = 2000,
} = {}) {
  const hours = sessionOptsFor(instrument.exchange, nowMs, { graceMs });
  const persistDate = persistSessionDate(nowMs, hours);
  const weekend = isWeekendIst(nowMs);
  const live = !weekend && nowInSession(nowMs, hours);
  let inCloseBuffer = false;
  if (!weekend && isAfterClose(nowMs, hours)) {
    const today = istDateString(new Date(nowMs));
    const { closeMs } = marketWindowMs(today, hours.open, hours.close);
    inCloseBuffer = nowMs < closeMs + Number(afterCloseBufferMs || 0);
  }
  if (live || inCloseBuffer) {
    return { action: 'sample', persistDate, hours };
  }
  const today = istDateString(new Date(nowMs));
  if (persistDate === today && state?.backfilledSessionDate !== persistDate) {
    return { action: 'backfill', persistDate, hours };
  }
  return { action: 'idle', persistDate, hours };
}

export function isoNowIst(nowMs) {
  return formatIst(new Date(nowMs));
}

export function anyLive(instruments, nowMs, extra = {}) {
  return (instruments || []).some((inst) => {
    const work = workForInstrument(inst, nowMs, { backfilledSessionDate: persistSessionDate(nowMs, hoursForExchange(inst.exchange, nowMs)) }, extra);
    return work.action === 'sample';
  });
}

export function isBeforeAnyOpen(instruments, nowMs) {
  const list = instruments || [];
  if (!list.length) return false;
  return list.every((inst) => {
    const hours = hoursForExchange(inst.exchange, nowMs);
    return isWeekendIst(nowMs) || isBeforeOpen(nowMs, hours) || isAfterClose(nowMs, hours);
  });
}
