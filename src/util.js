export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function num(v) {
  if (v && typeof v === 'object' && 'toNumber' in v) return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function isRetryableGoogleError(err) {
  const code = Number(err?.code || err?.response?.status || 0);
  if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504) return true;
  const msg = String(err?.message || '');
  return /rate limit|quota|too many requests|backend error|econnreset|etimedout|socket hang up/i.test(msg);
}

export async function withRetry(fn, {
  retries = 5,
  baseMs = 1000,
  maxMs = 32_000,
  label = 'request',
  onRetry,
} = {}) {
  let delay = baseMs;
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableGoogleError(err) || i === retries) throw err;
      const wait = Math.min(maxMs, delay) + Math.floor(Math.random() * 400);
      if (onRetry) onRetry({ err, attempt: i + 1, wait, label });
      await sleep(wait);
      delay *= 2;
    }
  }
  throw lastErr;
}

export function interruptibleSleep(ms, { isStopped, onRegister } = {}) {
  return new Promise((resolve) => {
    if (isStopped?.()) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    const cancel = () => {
      clearTimeout(timer);
      resolve();
    };
    onRegister?.(cancel);
  });
}
