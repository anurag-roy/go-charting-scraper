export function redactText(text, secrets = []) {
  let out = String(text ?? '');
  const extra = [];
  for (const sec of secrets) {
    if (!sec) continue;
    extra.push(String(sec));
    try { extra.push(encodeURIComponent(String(sec))); } catch { /* ignore */ }
  }
  const unique = [...new Set(extra.filter((s) => s && s.length > 2))];
  unique.sort((a, b) => b.length - a.length);
  for (const sec of unique) {
    out = out.split(sec).join('[REDACTED]');
  }
  out = out.replace(/token=[^&"'\s]+/gi, 'token=[REDACTED]');
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]');
  out = out.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[PRIVATE_KEY]');
  return out;
}

export function redactValue(value, secrets = []) {
  if (value instanceof Error) {
    return redactText(value.stack || value.message, secrets);
  }
  if (typeof value === 'string') return redactText(value, secrets);
  try {
    return redactText(JSON.stringify(value), secrets);
  } catch {
    return redactText(String(value), secrets);
  }
}
