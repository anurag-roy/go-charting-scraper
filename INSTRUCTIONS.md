# GoCharting scraper — setup and VPS deploy

This is the end-to-end guide for running the **24×7 Google Sheet service**.
The process lives on your VPS, reads GoCharting credentials, instruments, and
candle timeframes from a spreadsheet `config` tab, and writes **closed**
candles back into that same spreadsheet.

Running on the **client’s Windows laptop** instead (powered on each morning,
not a VPS): [`WINDOWS.md`](WINDOWS.md).

Related reading:

- [`README.md`](README.md) — one-page product summary
- [`WINDOWS.md`](WINDOWS.md) — Windows laptop handover (daily start, sleep, gaps)
- [`.env.example`](.env.example) — Google credentials and optional knobs
- [`deploy/gocharting-scraper.service`](deploy/gocharting-scraper.service) — systemd unit
- [`src/proto/`](src/proto/) — WebSocket Protobuf schemas (not required to operate)

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [How the scraper works](#2-how-the-scraper-works)
3. [What you need](#3-what-you-need)
4. [Google Sheet (`config` tab)](#4-google-sheet-config-tab)
5. [Google Cloud service account](#5-google-cloud-service-account)
6. [Clone and install](#6-clone-and-install)
7. [Configure the VPS / laptop env](#7-configure-the-vps--laptop-env)
8. [First successful run](#8-first-successful-run)
9. [Environment variables](#9-environment-variables)
10. [Candle tabs and columns](#10-candle-tabs-and-columns)
11. [Market hours and 24×7 behaviour](#11-market-hours-and-24x7-behaviour)
12. [Changing instruments](#12-changing-instruments)
13. [Linux server (systemd)](#13-linux-server-systemd)
14. [Docker](#14-docker)
15. [Logs](#15-logs)
16. [What the scraper does *not* do](#16-what-the-scraper-does-not-do)
17. [Troubleshooting](#17-troubleshooting)
18. [Security](#18-security)
19. [Shareable zip](#19-shareable-zip)

---

## 1. What you get

Production entrypoint: `src/index.js` (`npm start`).

It signs in to GoCharting with AWS Cognito over HTTPS (**no browser**), opens
the market-data WebSocket, and for each configured instrument persists every
**closed** footprint candle for the timeframes listed on that `config` row:

| Sheet column | Meaning |
| --- | --- |
| `symbol` | Contract code only (`NIFTY26AUG24050CE`), not `NSE:OPTIONS:…` |
| `candle_time` | Candle open time in IST (no `+05:30` suffix) |
| `open` / `high` / `low` / `close` | Matching OHLC bar, ticks ÷ 100 (`high`/`low` fall back to footprint if the bar is missing) |
| `delta` | Buy volume − sell volume |
| `max_delta` | Intra-bar cumulative-delta high (`0` when missing or negative) |
| `max_vol_b` / `max_vol_s` | Largest buy / sell volume at any single price |
| `poc` | Point of control (price with most buy+sell volume) |
| `volume` | Footprint candle volume |
| `oi_change` | This bar’s open interest minus the previous bar’s |
| `vwap` | Session VWAP from typical price `(H+L+C)/3` × OHLC volume, ticks ÷ 100, 2 decimal places |

The in-progress (forming) candle is **not** written. After a bar’s end the
process waits `CLOSE_GRACE_MS` (default 2s) so the server can finalize the
print, then appends the row. Restarts skip `candle_time` values already on
that tab.

Default behaviour: run forever. While an exchange is in session, the scheduler
checks about every **15 seconds**, but only requests a timeframe when its current
candle can have closed. Overnight and on weekends the WebSocket is closed; the
process stays up and keeps polling the `config` tab.

Verified on Linux: Node 22, outbound HTTPS + WSS only (no Chromium, no Xvfb,
no display).

---

## 2. How the scraper works

You do not need this to operate it. It explains outbound hosts and secrets.

1. Every 5 seconds it reads the spreadsheet `config` tab (one Google **read**;
   12/minute, under the Sheets API 60 reads/minute/user quota).
2. It `POST`s AWS Cognito `InitiateAuth` (`USER_PASSWORD_AUTH`) with the
   **email / password from the sheet**, using the same public web client id
   the website ships (`3fqhvm22ea8pjsr2spbnv484pr`).
3. Cognito returns a JWT **id token**. Tokens are kept **in process memory
   only** (never written to disk). The market-data WebSocket is
   `wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws?token=<JWT>&tag=…`.
4. The Node process opens that WebSocket (Origin `https://gocharting.com`).
5. For each active instrument and interval it sends JSON `FOOTPRINT/V2` and
   `TS/V2` `OHLCV/V2`.
6. The server replies with **binary Protobuf** frames (sometimes deflate-
   compressed). They are decoded with
   `src/proto/footprint.proto` and
   `src/proto/ohlc_bars.proto`.
7. Closed candles in that exchange’s session window are written to **static**
   tabs `1A`, `1B`, `1C`, `2A`, … (Instrument1’s first timeframe → `1A`,
   Instrument2’s first timeframe → `2A`). If the symbol or timeframe for a
   slot changes, the data inside that tab is overwritten; the tab name stays
   the same.

There is **no REST/JSON endpoint** for these numbers. Do not scrape the DOM.
A headless browser is unnecessary: login is a single Cognito HTTP call.

Cognito id tokens from this client currently last **8 hours** (`ExpiresIn`
28800). The scraper refreshes with `REFRESH_TOKEN_AUTH` (or re-logins) when
the JWT is near expiry or `TOKEN_REFRESH_MS` elapses (default 45 minutes).
If the sheet password changes, the new credentials are tried first; on
failure the previous working session is kept.

---

## 3. What you need

### Accounts

- A working [GoCharting](https://gocharting.com) login that can see the
  instruments you put on the `config` tab.
- A Google spreadsheet shared with a **service account** as Editor.

### Machine

| Item | Recommendation |
| --- | --- |
| OS | Ubuntu 22.04 / 24.04 (Debian 12 is fine). macOS / any Node 20+ host. |
| CPU / RAM | Tiny: **~128–256 MB**. No Chrome. |
| Disk | ~50 MB for Node deps; plus log growth. |
| Display | **Not required.** |
| Privileges | A normal user is enough to run; systemd install needs root. |

### Network (outbound)

| Host | Why |
| --- | --- |
| `cognito-idp.ap-south-1.amazonaws.com` (HTTPS) | Auth / JWT |
| `origin.ws.prodb.blr1.gocharting.com` (WSS `443`) | Market data |
| `sheets.googleapis.com` (HTTPS) | Read `config`, write candle tabs |

### Software

- `git`
- **Node.js 20 or 22** (22 is what this was developed on)
- `npm` (comes with Node)

Optional: Docker ([§14](#14-docker)). Playwright is **not** used by the live
scraper.

---

## 4. Google Sheet (`config` tab)

Create (or reuse) a spreadsheet. Add a tab named exactly **`config`**.
Put labels in column A, the login / instrument id in column B, and candle
timeframes in columns C–E (order of rows does not matter; keys are
case-insensitive; cells from F onward are ignored):

| A | B (example) | C | D | E |
| --- | --- | --- | --- | --- |
| email | GoCharting login email | | | |
| password | GoCharting password | | | |
| Instrument1 | `NSE:FUTURE:NIFTY-I` | `2m` | `3m` | `5m` |
| Instrument2 | `MCX:FUTURE:CRUDEOIL-I` | `5m` | `10m` | |
| Instrument3 | `NSE:OPTIONS:NIFTY2681824300CE` | `2m` | `3m` | `5m` |
| Instrument4 | *(optional)* | | | |
| Instrument5 | *(optional)* | | | |
| Instrument6 | *(optional)* | | | |

Instrument strings are `EXCHANGE:CATEGORY:SYMBOL` (`NSE`, `BSE`, or `MCX`).
Slashes (`NSE/FUTURE/NIFTY-I`) are also accepted. Blank instrument slots are
ignored. Duplicate instruments are monitored once. At most six instruments
(`Instrument1`–`Instrument6`) are read; extra slots are ignored.

Timeframes are minute bars such as `2m`, `5m`, `10m`. Each instrument uses
**only** the timeframes written in columns C, D, and E — there is no default
list. If a row has a symbol but no timeframes in those three cells, that
instrument is skipped. Other content from column F onward is ignored.

The password is **plaintext in the spreadsheet**. Share the file only with
people who should have that GoCharting login, plus the service account.
Do not make the sheet public.

Copy the spreadsheet id from the URL:

```text
https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
```

---

## 5. Google Cloud service account

One-time:

1. Create a Google Cloud project (or reuse one).
2. Enable the **Google Sheets API**.
3. Create a **service account** and download its JSON key. Keep it **out of
   git** (for example `/etc/gocharting/google-service-account.json`).
4. Share the spreadsheet with the service account’s `client_email` as
   **Editor**.

You can authenticate the scraper either with that JSON file
(`GOOGLE_SERVICE_ACCOUNT_JSON`) or with `GOOGLE_CLIENT_EMAIL` +
`GOOGLE_PRIVATE_KEY`. On systemd, the **JSON file is easier** because PEM
newlines are awkward in `EnvironmentFile=`.

---

## 6. Clone and install

```bash
git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
node -v    # want v20.x or v22.x
npm ci     # from the repo root — that is where package.json lives
```

If Node is missing, on Ubuntu/Debian (Node 22):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Layout you will use:

```
go-charting-scraper/
  package.json                 ← production app
  src/index.js                 ← 24×7 entrypoint
  src/proto/                   ← Protobuf schemas the decoder needs
  .env.example                 ← copy to .env (gitignored)
  deploy/gocharting-scraper.service
  logs/                        ← error.log + status.json at runtime
```

---

## 7. Configure the VPS / laptop env

The scraper **refuses to start** without a spreadsheet id and Google
credentials (exit code `2`):

```text
set GOOGLE_SHEET_ID (spreadsheet id or URL)
Google credentials are missing (GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)
```

GoCharting email/password are **not** env vars. They come from the `config`
tab.

### Laptop / first SSH: `.env` (gitignored)

```bash
cp .env.example .env
# edit .env — at minimum:
#   GOOGLE_SHEET_ID=your-spreadsheet-id-or-full-url
#   GOOGLE_SERVICE_ACCOUNT_JSON=./google-service-account.json
#     or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
```

The process auto-loads `.env` from the repo root via `dotenv`.

### Durable env on the server

```bash
sudo mkdir -p /etc/gocharting
sudo cp /path/to/google-service-account.json /etc/gocharting/google-service-account.json
sudo chmod 600 /etc/gocharting/google-service-account.json

sudo tee /etc/gocharting/env >/dev/null <<'EOF'
GOOGLE_SHEET_ID=your-spreadsheet-id
GOOGLE_SERVICE_ACCOUNT_JSON=/etc/gocharting/google-service-account.json
EOF
sudo chmod 600 /etc/gocharting/env
```

Do **not** commit `.env`, `/etc/gocharting/env`, or the JSON key.

---

## 8. First successful run

From the **repo root**, with `.env` filled in:

```bash
ONCE=1 npm start
```

`ONCE=1` means: read `config`, authenticate, create any missing static tabs
(`1A`, `1B`, `1C`, …), drop rows that are not from **today’s IST date**,
backfill already-closed candles for today’s session (if the market is open
or already closed today), then exit. Use this as a smoke test before systemd.

### Success looks like

```text
INFO go-charting-scraper { once: true, sheet: '…' }
INFO config applied { email: '…', passwordSet: true, instruments: [ { slot: 1, id: 'NSE:FUTURE:NIFTY-I', intervals: [ '2m', '3m', '5m' ] }, … ] }
INFO start monitoring slot 1 NSE:FUTURE:NIFTY-I 2m, 3m, 5m
INFO connecting websocket not open
INFO sample 1 NSE:FUTURE:NIFTY-I/backfill, …
INFO   NSE:FUTURE:NIFTY-I 2m: closed=193/193
INFO   NSE:FUTURE:NIFTY-I 3m: closed=129/129
INFO   NSE:FUTURE:NIFTY-I 5m: closed=77/77
INFO wrote 399 new closed-candle row(s)
INFO shutting down
```

A second `ONCE=1 npm start` should print `wrote 0 new closed-candle row(s)`
(duplicates are skipped). Email, password, and JWTs are redacted in logs.

Checklist:

| Check | Meaning |
| --- | --- |
| `config applied` with `passwordSet: true` | `config` tab parsed |
| `start monitoring …` | Static tabs `1A` / `1B` / `1C` (etc.) ensured |
| `closed=` > 0 during/after the session | Closed bars decoded |
| `wrote N new closed-candle row(s)` | Rows appended to the spreadsheet |
| Second run writes `0` | Dedup by tab + `candle_time` |

Then leave it running:

```bash
npm start
```

If Cognito or Sheets fails, see [§17](#17-troubleshooting).

---

## 9. Environment variables

Copy [`.env.example`](.env.example). Only Google credentials plus the
spreadsheet id are required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_SHEET_ID` | *(required)* | Spreadsheet id **or** full Google Sheets URL |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | unset | Path to the service-account JSON key, or the JSON itself |
| `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` | unset | Alternative to the JSON file (`\n` in the PEM is unescaped) |
| `CONFIG_TAB` | `config` | Name of the config worksheet |
| `CONFIG_POLL_MS` | `5000` | How often to re-read `config` (min 1000) |
| `SAMPLE_MS` | `15000` | Maximum start-to-start polling cadence while in session; candle-close deadlines can wake it sooner |
| `CLOSE_GRACE_MS` | `2000` | Wait after a bar’s end before treating it as closed |
| `AFTER_CLOSE_BUFFER_MS` | `60000` | Extra sampling after the session close to catch last bars |
| `TOKEN_REFRESH_MS` | `2700000` (45 min) | Refresh Cognito JWT / reconnect WebSocket |
| `GOCHARTING_SESSION` | `RTH` | Session type sent on WS payloads |
| `WS_DC` | `blr1` | Market-data datacenter (`blr1` or `nyc1`) |
| `WS_TAG` | `go-charting-scraper` | `tag=` query param on the WebSocket URL |
| `WS_HOST` | derived from `WS_DC` | Full `wss://…` override |
| `ONCE` | unset / false | `1` → one sample then exit |
| `WRITE_CSV` | unset / false | Also append a wide debug CSV |
| `CSV_PATH` | `logs/maxvol.csv` | CSV destination |
| `ERROR_LOG_PATH` | `logs/error.log` | Rotating error log |
| `STATUS_PATH` | `logs/status.json` | Heartbeat (instruments, last sample, WS state) |
| `PROTO_DIR` | `src/proto` | Directory with `footprint.proto` and `ohlc_bars.proto` |

---

## 10. Candle tabs and columns

Tabs are named from the **config slot** and the **timeframe letter**, not from
the symbol. `Instrument1` always writes `1A`, `1B`, `1C`; `Instrument2` writes
`2A`, `2B`, `2C`; and so on. Column C is letter A, D is B, E is C. Extra
timeframes in F onward become `1D`, `1E`, …

| Config row | Example timeframes | Tabs |
| --- | --- | --- |
| Instrument1 `NSE:FUTURE:NIFTY-I` | `2m`, `3m`, `5m` | `1A`, `1B`, `1C` |
| Instrument2 `MCX:FUTURE:CRUDEOIL-I` | `5m`, `10m` | `2A`, `2B` (`2C` stays empty) |
| Instrument3 `NSE:OPTIONS:NIFTY2681824300CE` | `15m` | `3A` |

The eighteen tabs `1A`–`6C` are created if missing and **never deleted**.
Point VLOOKUP / INDEX formulas at those names; they stay stable when you
change a symbol or timeframe. Column Z on each data tab records which
instrument and interval currently occupy it (`1|2m|NSE:FUTURE:NIFTY-I`).
Leave A:N for your formulas (column A is the contract `symbol`).

If you change the symbol or a timeframe cell while the market is open, the
scraper **overwrites the rows inside** that slot’s tabs and backfills today.
Existing `candle_time` values on an unchanged tab are not duplicated. Each
data tab still keeps **only the current IST day’s rows**.

Older spreadsheets may still have leftover `{symbol} {interval}` tabs from
earlier versions; those are left in place and no longer written.

Sheet schema is listed in [§1](#1-what-you-get). Optional CSV
(`WRITE_CSV=1`) keeps a wider debug schema including raw ticks.

---

## 11. Market hours and 24×7 behaviour

Times are **Asia/Kolkata**. Only bars that **open** inside the exchange
window are persisted. Last bars shorter than the interval are closed at the
session close + `CLOSE_GRACE_MS`.

| Exchange | Open | Close |
| --- | --- | --- |
| NSE, BSE | 09:15 | 15:40 |
| MCX (energy / bullion / metals, e.g. CRUDEOIL) | 09:00 | 23:30, or **23:55** while US Eastern is on daylight saving |

MCX agri products close earlier; the default matches CRUDEOIL/GOLD-style
contracts.

NSE last bars: **5m 15:35**, **3m 15:39**, **2m 15:39**. A 2-minute last bar
may be shorter than 2 minutes (NSE session is 385 minutes).

The process does **not** exit at 15:40 or on weekends:

- During session: sample ~every 15s; keep the WebSocket open.
- Shortly after close: one more sample to catch the last bars, then backfill
  is marked done.
- Overnight / weekend: close the WebSocket, keep polling `config` every 5s,
  reconnect at the next weekday open. Previous-day sheet rows are cleared
  when the IST calendar date changes.
- Process start after hours on a **trading day**: backfill that same day’s
  session once, then idle. Previous weekdays are not backfilled.

Empty `closed=0` on a holiday is expected.

---

## 12. Changing instruments

Edit `Instrument1` … `Instrument6` on the `config` tab, including the
timeframe cells on each row. Within about 5 seconds the process:

1. Stops requesting the old symbol (X), or old timeframes if only those changed.
2. **Overwrites** the data inside that slot’s static tabs (`1A` / `1B` / `1C`
   for Instrument1, and so on). Tab names do not change. Sheets are never
   deleted.
3. Backfills the new symbol (or the newly listed timeframes) for **today’s**
   session (if today is a trading day).
4. Starts live monitoring of the new configuration.

Point VLOOKUP formulas at `1A`, `1B`, `1C`, … so they keep working after a
symbol or timeframe change.

If the email/password cells change, the new login is attempted first. A bad
password is logged and the previous Cognito session is kept.

---

## 13. Linux server (systemd)

Recommended: one long-running process with `Restart=always`.

### 13.1 User, clone, dependencies

```bash
sudo useradd --system --home /var/lib/gocharting --shell /usr/sbin/nologin gocharting || true
sudo mkdir -p /opt/go-charting-scraper
sudo git clone https://github.com/anurag-roy/go-charting-scraper.git /opt/go-charting-scraper
cd /opt/go-charting-scraper
sudo npm ci
sudo chown -R gocharting:gocharting /opt/go-charting-scraper
```

Create `/etc/gocharting/env` as in [§7](#7-configure-the-vps--laptop-env).

### 13.2 Install the unit

The repo ships [`deploy/gocharting-scraper.service`](deploy/gocharting-scraper.service):

```ini
[Unit]
Description=GoCharting Google Sheets scraper (24x7)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gocharting
Group=gocharting
WorkingDirectory=/opt/go-charting-scraper
EnvironmentFile=/etc/gocharting/env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
Nice=10
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp /opt/go-charting-scraper/deploy/gocharting-scraper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gocharting-scraper.service
sudo journalctl -u gocharting-scraper.service -f
```

Smoke-test as the service user before enabling, if you want:

```bash
sudo -u gocharting bash -lc 'set -a; source /etc/gocharting/env; set +a; cd /opt/go-charting-scraper && ONCE=1 /usr/bin/node src/index.js'
```

### 13.3 Updates

```bash
cd /opt/go-charting-scraper
sudo -u gocharting git pull --ff-only
sudo npm ci
sudo systemctl restart gocharting-scraper.service
```

---

## 14. Docker

A root [`Dockerfile`](Dockerfile) is included (plain Node 22, no Playwright):

```bash
docker build -t gocharting-scraper .
docker run --rm \
  -e GOOGLE_SHEET_ID \
  -e GOOGLE_CLIENT_EMAIL \
  -e GOOGLE_PRIVATE_KEY \
  -e ONCE=1 \
  gocharting-scraper
```

For 24×7, omit `ONCE=1` and use `--restart unless-stopped`. Prefer mounting a
JSON key over putting a PEM in `-e`:

```bash
docker run -d --name gocharting-scraper --restart unless-stopped \
  -e GOOGLE_SHEET_ID=your-spreadsheet-id \
  -e GOOGLE_SERVICE_ACCOUNT_JSON=/secrets/google-service-account.json \
  -v /etc/gocharting/google-service-account.json:/secrets/google-service-account.json:ro \
  gocharting-scraper
```

Do not bake keys or the sheet password into the image. The sheet password
still lives on the `config` tab.

---

## 15. Logs

Written under `logs/` in the working directory (gitignored except
[`logs/README.md`](logs/README.md)):

| File | Purpose |
| --- | --- |
| `logs/error.log` | Errors only. Credentials and JWTs redacted. Rotates at 5 MB (keeps 3 backups). |
| `logs/status.json` | Last config summary (no password), last sample time, websocket `open`/`closed`. |
| stdout / `journalctl` | Routine `INFO` / `WARN` lines. |

The `gocharting` user must be able to write `logs/` (the `chown` in §13.1
covers that).

---

## 16. What the scraper does *not* do

- It does **not** open a browser or drive the GoCharting UI.
- It does **not** change profile, chart, or indicator settings.
- Configured timeframes are requested as `FOOTPRINT/V2` and `TS/V2` `OHLCV/V2`.
- It does **not** write the forming candle; only closed bars.
- It does **not** subscribe to the live `trade` tape; it re-fetches footprint
  snapshots. That is enough for 15s polling of closed bars.
- It does **not** rename or delete data tabs. `1A`–`6C` stay in place; only
  the rows inside them change.
- It **does** overwrite a slot’s tabs when you change that row’s symbol or
  timeframes, then backfill today.
- It **does** delete previous-day candle rows each IST morning so tabs hold
  only the current day.
- It does **not** take GoCharting credentials from `.env`.

---

## 17. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `set GOOGLE_SHEET_ID …` (exit 2) | Env not loaded | Copy `.env.example`. systemd: `EnvironmentFile=` exists and `chmod 600`. |
| `Google credentials are missing` / file not found | JSON path or PEM wrong | Set `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`. Share the sheet with the service account as Editor. |
| `config sheet is missing email, password, or instruments with candle timeframes` | Tab name / cells | Tab must be `config`. Labels in A, symbol in B, timeframes in C–E. |
| `unsupported exchange` / `invalid instrument` | Bad `InstrumentN` | Use `NSE\|BSE\|MCX:CATEGORY:SYMBOL`. Check `logs/error.log`. |
| `cognito auth failed` / `NotAuthorizedException` | Bad sheet password | Confirm the `config` email/password. Cognito does not open a login UI. |
| `cognito extra challenge` | MFA | Only `USER_PASSWORD_AUTH` with no challenge is supported. |
| `ws unexpected HTTP 401` / connect timeout | JWT rejected or WSS blocked | Egress to `origin.ws.prodb.blr1.gocharting.com`. Watch journal for `connecting websocket`. |
| `closed=0` / `no candles` | Holiday, wrong symbol, or before first bar | Confirm the instrument string in the GoCharting UI. After hours **today**, a backfill of today’s session is expected; previous weekdays are not rewritten. |
| No new NSE rows after 15:40 | Last bars already flushed | Wait until 15:40 + `CLOSE_GRACE_MS`. MCX may still be live. |
| Duplicate worry on restart | — | Keys are reloaded from each tab; a second `ONCE=1` should write 0. |
| Static tabs `1A`–`6C` missing / not writable | Service account cannot write | Re-share the spreadsheet as Editor. `journalctl` / `logs/error.log`. |
| Process killed (137) | OOM | Unusual (~128–256 MB). Check the host. |
| Works on SSH but not systemd | Different user / no env | See [§13](#13-linux-server-systemd). `journalctl -u gocharting-scraper.service`. |

Never paste `logs/error.log` or `status.json` in public tickets without
checking — redaction is best-effort and the status file includes the
GoCharting email.

### Quick self-test

```bash
ONCE=1 npm start
```

---

## 18. Security

- Treat the `config` tab password and the JWT as secrets. Restrict spreadsheet
  sharing. Rotate the GoCharting password if it ever landed in a screenshot,
  ticket, or log.
- Do not commit `/etc/gocharting/env`, `.env`, `google-service-account.json`,
  `logs/error.log`, or `logs/status.json`.
- This automation uses **your** GoCharting account against their Cognito pool
  and WebSocket. Confirm their terms of use allow it. Typical breakage is
  Cognito client-id drift or WS command schema changes.
- Be polite with polling. 5s config reads and 15s `FOOTPRINT/V2` snapshots are
  enough for closed bars.

---

## 19. Shareable zip

To hand someone a runnable copy **without git or the source tree**:

```bash
npm ci
npm run pack
```

That writes `dist/go-charting-scraper-<version>.zip`. esbuild bundles the
`npm start` graph (no `*.test.js`) into one `index.js`. The zip also includes
`package.json`, a production `package-lock.json`, `start.bat` /
`start-once.bat`, `.env.example`, `WINDOWS.md`, `proto/`, and — if they exist
in the current working tree — `.env` and `google-service-account.json`.

The recipient unzips, runs `npm ci --omit=dev` (or double-clicks `start.bat`),
then `npm start`. Treat that zip as secret if it contains `.env`.

---

## Minimal copy-paste (Ubuntu VPS)

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
npm ci
cp .env.example .env
# edit .env: GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON
# (or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY)
# Share the spreadsheet with the service account as Editor.
# Fill the config tab: email, password, Instrument1..6 plus timeframes in C–E.

ONCE=1 npm start
```

When that prints `config applied` and `wrote N new closed-candle row(s)`,
scraping is working. Then `npm start` or install the systemd unit in
[§13](#13-linux-server-systemd).
