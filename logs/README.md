This directory holds runtime logs on the VPS. Contents are gitignored.

- `error.log` — errors (credentials and tokens redacted). Rotates at 5 MB.
- `status.json` — last applied config summary, last sample, websocket state.

Do not commit these files. They can still contain instrument names and emails.
