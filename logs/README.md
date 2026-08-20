This directory holds runtime logs on the VPS. Contents are gitignored.

- `error.log` — errors (credentials and tokens redacted). Rotates at 5 MB.
- `status.json` — last applied config summary, last sample, websocket state.

Stdout / journal also includes `timing …` INFO lines for Google Sheets, GoCharting, and Cognito (grep `timing`).

Do not commit these files. They can still contain instrument names and emails.
