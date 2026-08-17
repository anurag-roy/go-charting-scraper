# GoCharting scraper — full setup & run instructions

This document is the end-to-end guide for cloning this repo and starting a live
scrape of **Max Vol B** / **Max Vol S** from
[gocharting.com](https://gocharting.com). Follow it in order the first time.

Related reading (not required to start scraping):

- [`README.md`](README.md) — one-page summary
- [`investigation/FINDINGS.md`](investigation/FINDINGS.md) — how the data is
  sourced and calculated (WebSocket + Protobuf)
- [`.env.example`](.env.example) — credentials, Nifty symbol, Google Sheet, CSV

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [How the scraper works](#2-how-the-scraper-works)
3. [What you need before cloning](#3-what-you-need-before-cloning)
4. [Clone the repository](#4-clone-the-repository)
5. [Install Node.js](#5-install-nodejs)
6. [Install project dependencies](#6-install-project-dependencies)
7. [Optional: Playwright for capture scripts](#7-optional-playwright-for-capture-scripts)
8. [Configure credentials](#8-configure-credentials)
9. [First successful scrape](#9-first-successful-scrape)
10. [Environment variables](#10-environment-variables)
11. [CSV output](#11-csv-output)
12. [Google Sheets](#12-google-sheets)
13. [Common recipes](#13-common-recipes)
14. [Linux server / unattended deploy](#14-linux-server--unattended-deploy)
15. [Docker](#15-docker)
16. [What the scraper does *not* do](#16-what-the-scraper-does-not-do)
17. [Target (symbol / intervals)](#17-target-symbol--intervals)
18. [Troubleshooting](#18-troubleshooting)
19. [Investigation / debug scripts](#19-investigation--debug-scripts)
20. [Security, git, and ToS](#20-security-git-and-tos)

---

## 1. What you get

The live scraper is `investigation/poc-log-maxvol.js`.

It signs in with AWS Cognito over HTTPS (no browser), then requests footprint
**and OHLC** data for **2m**, **3m**, and **5m** candles of
`NSE:FUTURE:NIFTY-I` and writes every **closed** bar in the **09:15–15:30 IST**
session:

| Field | Meaning |
| --- | --- |
| **OHLC** | Open / high / low / close of that candle (`TS/V2` `OHLCV/V2` bars) |
| **Max Vol B** | Largest **buy** volume at any single price level in that candle (`max.buy.volume`) |
| **Max Vol S** | Largest **sell** volume at any single price level in that candle (`max.sell.volume`) |

The in-progress (forming) candle is **not** written. After a bar's end time the
scraper waits `CLOSE_GRACE_MS` (default 2s) so the server can finalize the print,
then appends the row. Restarts skip candles already stored (by `interval` +
`candle_time`).

Default behaviour: on a weekday during market hours, sample every **15 seconds**
until shortly after **15:30 IST**. `RUN_MS=0` is a one-shot backfill (cron-friendly).
Weekends backfill the last weekday session and exit.

At least one sink is required:

- **Google Sheet** when `GOOGLE_SHEET_ID` is set (tabs `2m`, `3m`, `5m`)
- **Local CSV** when `WRITE_CSV=1`

Verified on Linux: Node 22, outbound HTTPS + WSS only (no Chromium, no Xvfb,
no display).

---

## 2. How the scraper works

You do **not** need to understand this to run it. It is here so the setup
choices (outbound hosts, secrets) make sense.

1. `POST` AWS Cognito `InitiateAuth` (`USER_PASSWORD_AUTH`) with
   `GOCHARTING_EMAIL` / `GOCHARTING_PASSWORD` using the same public web client
   id the website ships (`3fqhvm22ea8pjsr2spbnv484pr`, pool
   `ap-south-1_uuM8MRslb`).
2. Cognito returns a JWT **id token**. The market-data WebSocket is
   `wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws?token=<JWT>&tag=…`.
3. The Node process opens that WebSocket (Origin `https://gocharting.com`).
4. It sends JSON `FOOTPRINT/V2` commands for intervals `2m`, `3m`, `5m`, and
   `TS/V2` `OHLCV/V2` for the same symbol/intervals.
5. The server replies with **binary Protobuf** frames (sometimes
   deflate-compressed). The script decodes them with
   `investigation/evidence/footprint.proto` and
   `investigation/evidence/ohlc_bars.proto`.
6. For each interval it keeps every **closed** candle whose open time is in the
   09:15–15:30 IST window for the current (or last weekday) session, and writes
   OHLC plus `max.buy.volume` / `max.sell.volume` to Google Sheets and/or CSV.
7. It also recomputes `max(level.buy.volume)` / `max(level.sell.volume)` and
   records `values_match=true` when they agree with the server. OHLC bars are
   matched to the footprint candle by timestamp (`start + offset` minutes).

There is **no REST/JSON endpoint** for these numbers. Do not try to scrape
them out of the DOM; the chart canvas does not expose them as text. A headless
browser is also unnecessary: login is a single Cognito HTTP call.

Cognito id tokens from this client currently last **8 hours** (`ExpiresIn`
28800). The scraper refreshes with `REFRESH_TOKEN_AUTH` (or re-logins) when
the JWT is near expiry or `TOKEN_REFRESH_MS` elapses (default 45 minutes).

---

## 3. What you need before cloning

### Account

- A working [GoCharting](https://gocharting.com) login that can access
  `NSE:FUTURE:NIFTY-I` footprint data.

### Machine

| Item | Recommendation |
| --- | --- |
| OS | Ubuntu 22.04 / 24.04 (Debian 12 is fine). macOS / any Node 20+ host. |
| CPU / RAM | Tiny: **~128–256 MB** is enough. No Chrome. |
| Disk | ~50 MB for Node deps; plus CSV growth. |
| Display | **Not required.** |
| Privileges | A normal user is enough. |

### Network (outbound)

The host must reach at least:

| Host | Why |
| --- | --- |
| `cognito-idp.ap-south-1.amazonaws.com` (HTTPS) | Auth / JWT |
| `origin.ws.prodb.blr1.gocharting.com` (WSS `443`) | Market data |
| `sheets.googleapis.com` (HTTPS) | Only if using Google Sheets |

The investigation / capture scripts (not the live scraper) also need
`gocharting.com` and `cdn.playwright.dev` if you re-run Playwright captures.

### Software you must have (or will install below)

- `git`
- **Node.js 20 or 22** (22 is what this was developed on)
- `npm` (comes with Node)

Optional:

- Playwright Chromium — **only** for `investigate.js` / `capture-frames.js`
  (protocol re-capture). The live scraper does not use it.
- `docker` — see [§15](#15-docker)

### Market hours (so “empty” values make sense)

NSE / Nifty futures **RTH** is **09:15–15:30 IST**, Monday–Friday. The scraper
only persists candles that open in that window. A 2-minute last bar may be
shorter than 2 minutes (session length is 375 minutes); it is treated as closed
at 15:30. After the close, or on a weekend, a one-shot run backfills the last
completed session. That is real data, not a scraper bug.

---

## 4. Clone the repository

```bash
git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
```

If you are deploying a specific branch (for example the Max Vol POC branch):

```bash
git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
git checkout cursor/maxvol-poc-csv-c8af   # or main, once merged
```

Layout you will use:

```
go-charting-scraper/
  .env.example             ← copy to .env (gitignored)
  INSTRUCTIONS.md          ← this file
  README.md
  investigation/
    poc-log-maxvol.js      ← the scraper
    package.json
    lib/                   ← .env, session window, CSV + Sheets sinks
    evidence/
      footprint.proto      ← Protobuf schema used to decode footprint frames
      ohlc_bars.proto      ← Protobuf schema used to decode OHLC bars
      maxvol-poc.csv       ← example scrape (includes OHLC)
    out/                   ← gitignored; debug logs
```

---

## 5. Install Node.js

Check first:

```bash
node -v    # want v20.x or v22.x
npm -v
```

If Node is missing, on Ubuntu/Debian (Node 22):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

Alternatives: [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`) or
your distro’s `nodejs` package if it is ≥ 20.

---

## 6. Install project dependencies

Always from the **`investigation/`** directory (that is where `package.json`
lives):

```bash
cd investigation
npm ci          # preferred: exact lockfile versions
# if npm ci fails (no lock / dirty tree): npm install
```

This installs `dotenv`, `googleapis`, `protobufjs`, `pako`, `ws`, and
`playwright` into `investigation/node_modules/` (gitignored). Playwright is
only used by the optional capture scripts in
[§19](#19-investigation--debug-scripts). The live scraper does **not** launch
a browser and does **not** need `npx playwright install`.

---

## 7. Optional: Playwright for capture scripts

Skip this for the live scraper. Only if you re-run `investigate.js` /
`capture-frames.js`:

```bash
npx playwright install --with-deps chromium
```

---

## 8. Configure credentials

The scraper **refuses to start** without GoCharting credentials **and** at least
one output sink (`GOOGLE_SHEET_ID` and/or `WRITE_CSV=1`):

```text
missing GOCHARTING_EMAIL / GOCHARTING_PASSWORD
set GOOGLE_SHEET_ID (spreadsheet id or URL) and/or WRITE_CSV=1
```

(exit code `2`).

Values are read from the environment and from a gitignored `.env` file (repo
root or `investigation/`). They are **redacted** from `investigation/out/`
debug logs (email, password, JWTs, `token=` query params).

### Recommended: `.env` in the repo (gitignored)

```bash
cp .env.example .env
# edit .env — at minimum:
#   GOCHARTING_EMAIL
#   GOCHARTING_PASSWORD
#   WRITE_CSV=1
#   and/or GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON
```

The scraper auto-loads `.env` via `dotenv` (`investigation/.env` overrides the
repo-root file).

### Interactive session (laptop or first SSH)

```bash
export GOCHARTING_EMAIL='you@example.com'
export GOCHARTING_PASSWORD='your-password'
export WRITE_CSV=1
```

Avoid putting the password in shell history:

```bash
read -s GOCHARTING_PASSWORD
export GOCHARTING_PASSWORD
```

### Durable env file (server)

```bash
sudo mkdir -p /etc/gocharting
sudo tee /etc/gocharting/env >/dev/null <<'EOF'
GOCHARTING_EMAIL=you@example.com
GOCHARTING_PASSWORD=your-password
WRITE_CSV=1
CSV_PATH=/var/lib/gocharting/maxvol.csv
OUT_DIR=/var/lib/gocharting/out
GOOGLE_SHEET_ID=your-spreadsheet-id
GOOGLE_SERVICE_ACCOUNT_JSON=/etc/gocharting/google-service-account.json
EOF
sudo chmod 600 /etc/gocharting/env
sudo mkdir -p /var/lib/gocharting/out
```

Load it:

```bash
set -a
source /etc/gocharting/env
set +a
```

Do **not** commit this file, `.env`, or the Google JSON key.

---

## 9. First successful scrape

From the repo root, with `.env` filled in (`WRITE_CSV=1` is the easiest first run):

```bash
cd /path/to/go-charting-scraper/investigation

# One-shot: persist every already-closed 2m/3m/5m candle for the session
RUN_MS=0 WRITE_CSV=1 node poc-log-maxvol.js
```

`RUN_MS=0` means “take one sample and exit” (Cognito + one `FOOTPRINT/V2` /
`TS/V2` round-trip per interval). Omit `RUN_MS` on a weekday to poll until
15:30 IST.

### Success looks like

```text
cognito login (USER_PASSWORD_AUTH, no browser)
symbol NSE:FUTURE:NIFTY-I intervals 2m, 3m, 5m session 09:15–15:30 IST
ws wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws
outputs { csv: '.../maxvol.csv', sheet: false }
cognito ok expiresIn= 28800 s

--- sample 1 @ 2026-08-17T05:25:00.000Z ---
session dates (IST): 2026-08-17, ...
  2m: closed=22/23 forming=2026-08-17T10:54:00+05:30
    last closed 2026-08-17T10:52:00+05:30  OHLC=...  MaxVolB=... MaxVolS=... match=true
  3m: closed=...
  5m: closed=...
  wrote 60 new closed-candle row(s)
DONE samples= 1 ...
```

Checklist:

| Check | Meaning |
| --- | --- |
| `cognito ok` | `InitiateAuth` returned an id token |
| `closed=` > 0 during/after the session | Closed bars decoded and eligible to write |
| `match=true` on last closed | Server max equals recomputed per-level max |
| `wrote N new closed-candle row(s)` | Rows appended to CSV and/or Sheets |

Also written:

- CSV (if `WRITE_CSV=1`): `investigation/evidence/maxvol.csv` unless `CSV_PATH` is set
- Google Sheet tabs `2m` / `3m` / `5m` (if `GOOGLE_SHEET_ID` is set)
- Debug JSONL: `investigation/out/poc/debug.jsonl` (tokens redacted)

If Cognito fails, see [§18](#18-troubleshooting).

---

## 10. Environment variables

GoCharting credentials plus **one output sink** are required. Everything else
is optional. Copy [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOCHARTING_EMAIL` | *(required)* | Login email |
| `GOCHARTING_PASSWORD` | *(required)* | Login password |
| `GOCHARTING_EXCHANGE` | `NSE` | Footprint exchange |
| `GOCHARTING_SEGMENT` | `FUTURE` | Footprint segment |
| `GOCHARTING_SYMBOL` | `NIFTY-I` | Current-month Nifty futures continuous contract |
| `INTERVALS` | `2m,3m,5m` | Comma-separated GoCharting interval strings |
| `MARKET_OPEN` / `MARKET_CLOSE` | `09:15` / `15:30` | IST session used to keep / close bars |
| `CLOSE_GRACE_MS` | `2000` | Wait after a bar’s end before treating it as closed |
| `RUN_MS` | *(unset = until close)* | Sampling window in ms. `0` = one shot. Omit to poll until 15:30 IST. |
| `SAMPLE_MS` | `15000` | Delay between samples |
| `TOKEN_REFRESH_MS` | `2700000` (45 min) | Refresh Cognito JWT and reconnect the WebSocket |
| `LAST_N` | `0` (off) | If `> 0`, print the last N candles per interval to stdout |
| `WRITE_CSV` | unset / false | `1` / `true` / `yes` → append closed bars to a local CSV |
| `CSV_PATH` | `investigation/evidence/maxvol.csv` | CSV destination (created if missing; **appended**, not overwritten) |
| `GOOGLE_SHEET_ID` | unset | Spreadsheet id **or** full Google Sheets URL |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | unset | Path to the service-account JSON key, or the JSON itself |
| `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` | unset | Alternative to the JSON file |
| `OUT_DIR` | `investigation/out/poc` | `debug.jsonl` |
| `WS_DC` | `blr1` | Market-data datacenter (`blr1` or `nyc1`) |
| `WS_TAG` | `go-charting-scraper` | `tag=` query param on the WebSocket URL |

`HEADLESS`, `PW_CHANNEL`, and `CHART_URL` are unused by the live scraper.

- Omit `RUN_MS` on a weekday → poll until `MARKET_CLOSE` + 1 minute
- `RUN_MS=0` → **1** sample (backfill every already-closed bar)
- Weekend / after hours with `RUN_MS` unset → one-shot of the last weekday session

`LAST_N` does not change the output schema; it only adds extra stdout lines.

---

## 11. CSV output

CSV is **opt-in**: set `WRITE_CSV=1`. Default path:
`investigation/evidence/maxvol.csv`.

**Rows are appended.** The file is not overwritten. On startup the scraper
reads existing `interval` + `candle_time` keys and skips duplicates, so it is
safe to re-run.

### Columns

| Column | Description |
| --- | --- |
| `sampled_at_utc` | When this closed bar was first persisted (ISO UTC) |
| `sampled_at_ist` | Same instant, Asia/Kolkata |
| `sample_n` | 1-based sample index in this process |
| `interval` | `2m`, `3m`, or `5m` |
| `symbol` | `NSE:FUTURE:NIFTY-I` (or whatever you configured) |
| `candle_time` | Footprint candle open time (`FootPrintCandle.date`) |
| `open` / `high` / `low` / `close` | OHLC of that candle from `TS/V2` `OHLCV/V2` (`protobars.Candle`). Prices are integer ticks, same as `max_vol_*_level`. If the OHLC bar is missing, `high`/`low` fall back to the footprint `ending_summary` (or min/max traded price level). |
| `ohlc_volume` | Total volume on the OHLC bar (`Candle.volume`). Empty if no matching `TS/V2` bar. |
| `max_vol_b` | Server **Max Vol B** (`max.buy.volume`) |
| `max_vol_s` | Server **Max Vol S** (`max.sell.volume`) |
| `max_vol_b_level` | Price level where recomputed max buy occurred |
| `max_vol_s_level` | Price level where recomputed max sell occurred |
| `totals_buy` / `totals_sell` | Sum of buy/sell volume across all levels in the candle |
| `price_levels` | Number of footprint price rows |
| `recomputed_max_b` / `recomputed_max_s` | `max` over per-level volumes |
| `values_match` | `true` if server max equals recomputed max |
| `candles_in_response` | How many candles were in the decoded payload(s) |
| `ok` | `true` if a closed candle was written |
| `error` | Empty on success |

Price `level` values are **integer ticks** as sent by the feed.

An older crude-oil POC run is committed at
[`investigation/evidence/maxvol-poc.csv`](investigation/evidence/maxvol-poc.csv).

---

## 12. Google Sheets

When `GOOGLE_SHEET_ID` is set, each closed candle is appended to a tab named
after its interval (`2m`, `3m`, `5m`). The same columns as the CSV are used.
Existing `candle_time` values are not duplicated.

### One-time Google Cloud setup

1. Create a Google Cloud project (or reuse one).
2. Enable the **Google Sheets API**.
3. Create a **service account**, download its JSON key, and store it outside
   git (for example `google-service-account.json` next to `.env`, which is
   gitignored).
4. Create a spreadsheet (or use one you already have). Copy the id from the
   URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
5. Share that spreadsheet with the service account’s `client_email` as
   **Editor**.
6. In `.env`:

```bash
GOOGLE_SHEET_ID=your-spreadsheet-id-or-full-url
GOOGLE_SERVICE_ACCOUNT_JSON=./google-service-account.json
```

You can set **both** `GOOGLE_SHEET_ID` and `WRITE_CSV=1`; each sink tracks its
own duplicates independently.

---

## 13. Common recipes

All commands assume you are in `investigation/` and `.env` is filled in.

### One-shot backfill of closed candles (cron-friendly)

```bash
RUN_MS=0 WRITE_CSV=1 node poc-log-maxvol.js
```

### Last 5 candles to stdout (including the forming bar)

```bash
RUN_MS=0 WRITE_CSV=1 LAST_N=5 node poc-log-maxvol.js
```

CSV/Sheets still store **closed** bars only.

### Live session (poll until 15:30 IST)

```bash
WRITE_CSV=1 node poc-log-maxvol.js
```

### Google Sheets only

```bash
RUN_MS=0 node poc-log-maxvol.js
# requires GOOGLE_SHEET_ID + service-account JSON in .env
```

---

## 14. Linux server / unattended deploy

### 14.1 Dedicated user and directories

```bash
sudo useradd --system --home /var/lib/gocharting --shell /usr/sbin/nologin gocharting || true
sudo mkdir -p /opt/go-charting-scraper /var/lib/gocharting/out
sudo chown -R gocharting:gocharting /var/lib/gocharting

sudo git clone https://github.com/anurag-roy/go-charting-scraper.git /opt/go-charting-scraper
cd /opt/go-charting-scraper/investigation
sudo -H -u gocharting bash -lc 'cd /opt/go-charting-scraper/investigation && npm ci'
sudo chown -R gocharting:gocharting /opt/go-charting-scraper
```

### 14.2 systemd — one-shot on a timer (recommended)

`/etc/systemd/system/gocharting-maxvol.service`:

```ini
[Unit]
Description=GoCharting Max Vol one-shot scrape
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=gocharting
Group=gocharting
WorkingDirectory=/opt/go-charting-scraper/investigation
EnvironmentFile=/etc/gocharting/env
Environment=RUN_MS=0
ExecStart=/usr/bin/node poc-log-maxvol.js
Nice=10
```

`/etc/systemd/system/gocharting-maxvol.timer`:

```ini
[Unit]
Description=Run GoCharting Max Vol scrape every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=15s
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gocharting-maxvol.timer
sudo systemctl list-timers | grep gocharting
sudo journalctl -u gocharting-maxvol.service -e
```

With `WRITE_CSV=1` and `CSV_PATH=/var/lib/gocharting/maxvol.csv` each shot
**appends** newly closed candles and skips rows already in the file.

### 14.3 systemd — long-running process

Omit `RUN_MS` so the process polls until 15:30 IST. It refreshes the JWT
about every 45 minutes. Use `Restart=on-failure` with `RestartSec=30`.

A weekday timer that starts the service at 09:10 IST is simpler than
keeping a process running overnight.

### 14.4 cron alternative

`/etc/cron.d/gocharting`:

```cron
*/5 * * * * gocharting bash -lc 'set -a; source /etc/gocharting/env; set +a; cd /opt/go-charting-scraper/investigation && /usr/bin/node poc-log-maxvol.js >> /var/lib/gocharting/run.log 2>&1'
```

Ensure `/etc/gocharting/env` contains `RUN_MS=0` and `WRITE_CSV=1` (or sheet id).

---

## 15. Docker

A plain Node image is enough (no Playwright/Chromium):

```dockerfile
FROM node:22-bookworm-slim

WORKDIR /app
COPY investigation/package.json investigation/package-lock.json ./
RUN npm ci --omit=dev
COPY investigation/ ./

ENV RUN_MS=0
ENV WRITE_CSV=1
# credentials at runtime, not in the image:
#   -e GOCHARTING_EMAIL -e GOCHARTING_PASSWORD
#   -e GOOGLE_SHEET_ID -e GOOGLE_SERVICE_ACCOUNT_JSON

CMD ["node", "poc-log-maxvol.js"]
```

Build and run:

```bash
docker build -t gocharting-scraper .
docker run --rm \
  -e GOCHARTING_EMAIL \
  -e GOCHARTING_PASSWORD \
  -e RUN_MS=0 \
  -e WRITE_CSV=1 \
  -e CSV_PATH=/data/maxvol.csv \
  -v /var/lib/gocharting:/data \
  gocharting-scraper
```

Do not bake passwords into the image.

---

## 16. What the scraper does *not* do

By design, matching the original investigation constraints:

- It does **not** open a browser or drive the terminal UI.
- It does **not** change GoCharting profile or chart settings.
- It does **not** click timeframe / layout / indicator buttons.
- 2m / 3m / 5m are requested as `FOOTPRINT/V2` and `TS/V2` `OHLCV/V2`
  WebSocket commands.
- It does **not** persist cookies between process starts (each run
  authenticates with Cognito again).
- It does **not** write the currently forming candle; only closed bars.
- It does **not** subscribe to the live `trade` tape for incremental
  updates; it re-fetches footprint snapshots. That is enough for 15s
  polling.

---

## 17. Target (symbol / intervals)

Defaults live in `.env` / [`.env.example`](.env.example), not hardcoded
constants:

```bash
GOCHARTING_EXCHANGE=NSE
GOCHARTING_SEGMENT=FUTURE
GOCHARTING_SYMBOL=NIFTY-I
INTERVALS=2m,3m,5m
GOCHARTING_SESSION=RTH
```

Notes:

- Login is Cognito HTTPS only. `CHART_URL` is unused by the live scraper
  (optional for Playwright capture scripts).
- Interval strings must be what the API expects (`2m`, `3m`, `5m`).
- `NIFTY-I` is the current-month Nifty futures continuous contract. For the
  cash index, try `GOCHARTING_SEGMENT=INDEX` and `GOCHARTING_SYMBOL=NIFTY`
  (confirm the exact instrument string in the GoCharting UI).
- `SESSION` is `RTH` as sent by the official client.
- Session calendar dates are computed in **Asia/Kolkata**. Only bars that
  open inside `MARKET_OPEN`–`MARKET_CLOSE` are persisted.

---

## 18. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `missing GOCHARTING_EMAIL / GOCHARTING_PASSWORD` | Env not exported / `.env` missing | Copy `.env.example`. systemd: `EnvironmentFile=` path and `chmod 600`. |
| `set GOOGLE_SHEET_ID ... and/or WRITE_CSV=1` | No output sink | Set `WRITE_CSV=1` and/or `GOOGLE_SHEET_ID`. |
| Google credentials missing / file not found | JSON key path wrong | Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the service-account file and share the sheet with its `client_email`. |
| `cognito auth failed` / `NotAuthorizedException` | Bad email/password | Confirm credentials. Cognito does not open a login UI. |
| `cognito extra challenge` | MFA / extra Cognito step | This client only supports `USER_PASSWORD_AUTH` with no challenge. |
| `ws unexpected HTTP 401` / `poc ws connect timeout` | JWT rejected or WSS blocked | Confirm egress to `origin.ws.prodb.blr1.gocharting.com`. Check `OUT_DIR/debug.jsonl` for `poc-ws-open` / `poc-ws-unexpected`. |
| `cognito ok` but `closed=0` / `no candles` | Weekend/holiday, wrong symbol, or before first bar | Check `OUT_DIR/debug.jsonl` for `poc-ws-open`, `footprint`, `decode-err`. Confirm `NSE:FUTURE:NIFTY-I` is the instrument string your account sees. |
| No new rows near 15:30 IST | Last bars not closed yet | Wait until 15:30 + `CLOSE_GRACE_MS`, or run `RUN_MS=0` after the close. |
| `values_match=false` | Decoder/schema drift | Re-fetch `footprint.proto` from `https://gocharting.com/assets/proto/1.1/footprint.proto` into `evidence/`. Open an issue with a redacted debug line. |
| Empty `open` / `close` | `TS/V2` OHLC bar not matched | Check `OUT_DIR/debug.jsonl` for `ohlc`, `ohlc-miss`, `ohlc-decode-err`. Re-fetch `ohlc_bars.proto`. `high`/`low` may still come from the footprint `ending_summary`. |
| CSV missing / empty | `WRITE_CSV` unset, wrong cwd, or path not writable | Set `WRITE_CSV=1`. Run from `investigation/`, or set an absolute `CSV_PATH`. |
| Process killed (137) | OOM | Unusual for this scraper (~128–256 MB). Check the host, not Chromium. |
| Works on SSH but not systemd | Different user / no env | See [§14.1](#141-dedicated-user-and-directories). `journalctl -u gocharting-maxvol.service`. |

Enable a one-off verbose look without extra flags: `OUT_DIR` +
`debug.jsonl` are enough. Never paste `debug.jsonl` in public tickets
without checking — redaction is best-effort.

### Quick self-test

```bash
RUN_MS=0 WRITE_CSV=1 node poc-log-maxvol.js
```

---

## 19. Investigation / debug scripts

You do **not** need these to scrape. They were used to reverse-engineer
the protocol (`FINDINGS.md`).

| Script | Role |
| --- | --- |
| `poc-log-maxvol.js` | **Production scraper** (this guide) |
| `investigate.js` | Login + dump HTTP / WS / console (bodies under `out/`) |
| `capture-frames.js` | Save full binary WS frames |
| `decode-frames.js` | Decode saved frames with `footprint.proto` |
| `recon.js` / `recon-login.js` | Page-structure probes |
| `analyze-ws.js` / `extract.js` | Offline helpers |

`investigation/out/` is gitignored because captures can contain JWTs and
cookies even after redaction attempts. Never commit it.

To re-run a protocol capture:

```bash
cd investigation
export GOCHARTING_EMAIL=... GOCHARTING_PASSWORD=...
HEADLESS=1 node investigate.js          # or PW_CHANNEL=chrome xvfb-run -a
```

---

## 20. Security, git, and ToS

- Treat `GOCHARTING_PASSWORD` and the JWT as secrets. Rotate the password
  if it ever landed in a log, screenshot, or ticket.
- Do not commit `/etc/gocharting/env`, `.env`, `google-service-account.json`,
  `investigation/out/`, or raw `debug.jsonl` from a failed redaction.
- CSV files contain **volumes and prices only** and are safe to keep.
- This automation uses **your** account against GoCharting’s Cognito pool
  and WebSocket. Confirm their terms of use allow it. The usual breakage
  mode is Cognito client-id / metadata drift or WS command schema changes.
- Be polite with polling. The official UI already streams this data;
  15s `FOOTPRINT/V2` snapshots are enough for closed 2m/3m/5m bars.

---

## Minimal copy-paste (Ubuntu, first time)

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
cp .env.example .env
# edit .env: GOCHARTING_EMAIL, GOCHARTING_PASSWORD, WRITE_CSV=1
# and/or GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON

cd investigation
npm ci

RUN_MS=0 LAST_N=5 node poc-log-maxvol.js
```

When that prints `cognito ok` and `wrote N new closed-candle row(s)` for
`2m` / `3m` / `5m`, scraping is working. Add Google Sheets credentials
when you want the spreadsheet sink, then add the systemd timer in
[§14](#14-linux-server--unattended-deploy).
