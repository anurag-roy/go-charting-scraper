This directory holds runtime logs on the VPS. Contents are gitignored.

- `error.log` — errors (credentials and tokens redacted). Rotates at 5 MB.
- `status.json` — last applied config summary, last attempt, last successful
  sample, error, next retry time, and websocket state. `state` is `starting`,
  `monitoring`, `idle`, `degraded`, or `stopped`. A successful config poll updates
  the heartbeat but does not prove market data is arriving; inspect `lastSampleAt`
  and `lastError` too. Failed data responses do not advance `lastSampleAt`.

Do not commit these files. They can still contain instrument names and emails.
