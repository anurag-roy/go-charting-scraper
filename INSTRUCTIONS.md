# GoCharting scraper — full setup & run instructions

This document is the end-to-end guide for cloning this repo and starting a live
scrape of **Max Vol B** / **Max Vol S** from
[gocharting.com](https://gocharting.com). Follow it in order the first time.

Related reading (not required to start scraping):

- [`README.md`](README.md) — one-page summary
- [`investigation/FINDINGS.md`](investigation/FINDINGS.md) — how the data is
  sourced and calculated (WebSocket + Protobuf)

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [How the scraper works](#2-how-the-scraper-works)
3. [What you need before cloning](#3-what-you-need-before-cloning)
4. [Clone the repository](#4-clone-the-repository)
5. [Install Node.js](#5-install-nodejs)
6. [Install project dependencies](#6-install-project-dependencies)
7. [Configure credentials](#7-configure-credentials)
8. [First successful scrape](#8-first-successful-scrape)
9. [Environment variables](#9-environment-variables)
10. [CSV output](#10-csv-output)
11. [Common recipes](#11-common-recipes)
12. [Linux server / unattended deploy](#12-linux-server--unattended-deploy)
13. [Docker](#13-docker)
14. [What the scraper does *not* do](#14-what-the-scraper-does-not-do)
15. [Hardcoded target (symbol / intervals)](#15-hardcoded-target-symbol--intervals)
16. [Troubleshooting](#16-troubleshooting)
17. [Investigation / debug scripts](#17-investigation--debug-scripts)
18. [Security, git, and ToS](#18-security-git-and-tos)

---

## 1. What you get

The live scraper is `investigation/poc-log-maxvol.js`.

It signs in to GoCharting with AWS Cognito over HTTPS (no browser), then every
sample interval requests footprint **and OHLC** data for **5m**, **10m**, and
**15m** candles of `MCX:FUTURE:CRUDEOIL-I` and writes:

| Field | Meaning |
| --- | --- |
| **OHLC** | Open / high / low / close of that candle (`TS/V2` `OHLCV/V2` bars) |
| **Max Vol B** | Largest **buy** volume at any single price level in that candle (`max.buy.volume`) |
| **Max Vol S** | Largest **sell** volume at any single price level in that candle (`max.sell.volume`) |

Default behaviour: sample every **30 seconds** for **5 minutes** (11 samples ×
3 intervals = 33 CSV rows), then exit.

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
4. It sends JSON `FOOTPRINT/V2` commands for intervals `5m`, `10m`, `15m`, and
   `TS/V2` `OHLCV/V2` for the same symbol/intervals.
5. The server replies with **binary Protobuf** frames (sometimes
   deflate-compressed). The script decodes them with
   `investigation/evidence/footprint.proto` and
   `investigation/evidence/ohlc_bars.proto`.
6. For each interval it keeps the **latest candle** (newest `candle.date`,
   Asia/Kolkata session) and writes OHLC plus `max.buy.volume` /
   `max.sell.volume` to CSV.
7. It also recomputes `max(level.buy.volume)` / `max(level.sell.volume)` and
   records `values_match=true` when they agree with the server. OHLC bars are
   matched to the footprint candle by timestamp (`start + offset` minutes).

There is **no REST/JSON endpoint** for these numbers. Do not try to scrape
them out of the DOM; the chart canvas does not expose them as text. A headless
browser is also unnecessary: login is a single Cognito HTTP call.

Cognito id tokens from this client currently last **8 hours** (`ExpiresIn`
28800). The scraper refreshes with `REFRESH_TOKEN_AUTH` (or re-logins) when
less than five minutes remain, so a multi-hour sampler can stay in one process.

---

## 3. What you need before cloning

### Account

- A working [GoCharting](https://gocharting.com) login that can access
  `MCX:FUTURE:CRUDEOIL-I` footprint data (the same account that can open
  `https://gocharting.com/terminal/chart/kd5OXEIXs`).

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

The investigation / capture scripts (not the live scraper) also need
`gocharting.com` and `cdn.playwright.dev` if you re-run Playwright captures.

### Software you must have (or will install below)

- `git`
- **Node.js 20 or 22** (22 is what this was developed on)
- `npm` (comes with Node)

Optional:

- Playwright Chromium — **only** for `investigate.js` / `capture-frames.js`
  (protocol re-capture). The live scraper does not use it.
- `docker` — see [§13](#13-docker)

### Market hours (so “empty” values make sense)

MCX crude oil is typically **09:00–23:30 IST**. After the close, the latest
candle is often a thin 23:30 bar (for example Max Vol B `0` / Max Vol S `10`).
That is real data, not a scraper bug. Historical candles from the same
session are still returned (`LAST_N=5` is useful after the close).

---

## 4. Clone the repository

```bash
git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
```

If you are deploying a specific branch:

```bash
git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
git checkout <branch>   # or main
```

Layout you will use:

```
go-charting-scraper/
  INSTRUCTIONS.md          ← this file
  README.md
  investigation/
    poc-log-maxvol.js      ← the scraper
    package.json
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

This installs `protobufjs`, `pako`, `ws`, and `playwright` into
`investigation/node_modules/` (gitignored). Playwright is only used by the
optional capture scripts in [§17](#17-investigation--debug-scripts). The live
scraper does **not** launch a browser and does **not** need
`npx playwright install`.

---

## 7. Configure credentials

The scraper **refuses to start** without both variables:

```text
missing GOCHARTING_EMAIL / GOCHARTING_PASSWORD
```

(exit code `2`).

Values are read from the environment only. They are **redacted** from
`investigation/out/` debug logs (email, password, JWTs, `token=` query
params).

### Interactive session (laptop or first SSH)

```bash
export GOCHARTING_EMAIL='you@example.com'
export GOCHARTING_PASSWORD='your-password'
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
CSV_PATH=/var/lib/gocharting/maxvol.csv
OUT_DIR=/var/lib/gocharting/out
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

Do **not** commit this file. Do **not** put it inside the git checkout.

A local `.env` in the repo is also fine if you keep it gitignored; this
script does **not** auto-load `.env` — you must `export` / `source` it.

---

## 8. First successful scrape

From `investigation/` with credentials exported:

```bash
cd /path/to/go-charting-scraper/investigation

# One snapshot of the latest candle on 5m / 10m / 15m (~5–15 seconds)
RUN_MS=0 node poc-log-maxvol.js
```

`RUN_MS=0` means “take the sample at t=0 and exit” (Cognito + one
`FOOTPRINT/V2` round-trip). Default without `RUN_MS` is a **5-minute** run.

### Success looks like

```text
cognito login (USER_PASSWORD_AUTH, no browser)
cognito ok expiresIn= 28800 s
session dates (IST): 2026-08-14, 2026-08-13, 2026-08-12
sampling 5m, 10m, 15m every 30s for 0s
ws wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws
csv -> .../evidence/maxvol-poc.csv

--- sample 1 @ 2026-08-14T18:20:00.000Z ---
  5m: ok=true candle=2026-08-14T23:30:00+05:30  OHLC=7945/7945/7945/7945 MaxVolB=0 MaxVolS=10 match=true n=172
  10m: ok=true ...
  15m: ok=true ...
DONE samples= 1 csv= ...
```

Checklist:

| Check | Meaning |
| --- | --- |
| `cognito ok` | `InitiateAuth` returned an id token |
| `ok=true` | At least one footprint candle decoded |
| `match=true` | Server max equals recomputed per-level max |
| `n=` large (tens–hundreds) | Full session history came back, not an empty payload |

Also written:

- CSV: `investigation/evidence/maxvol-poc.csv` unless `CSV_PATH` is set
- Debug JSONL: `investigation/out/poc/debug.jsonl` (tokens redacted)

If Cognito fails, see [§16](#16-troubleshooting).

---

## 9. Environment variables

All are optional except the two credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOCHARTING_EMAIL` | *(required)* | Login email |
| `GOCHARTING_PASSWORD` | *(required)* | Login password |
| `RUN_MS` | `300000` (5 min) | How long to keep sampling after the first sample. `0` = one shot. |
| `SAMPLE_MS` | `30000` | Delay between samples. |
| `LAST_N` | `0` (off) | If `> 0`, print the last N candles per interval to stdout (CSV still stores the **latest** candle only). |
| `CSV_PATH` | `investigation/evidence/maxvol-poc.csv` | Destination CSV (overwritten each run). |
| `OUT_DIR` | `investigation/out/poc` | `debug.jsonl`. |
| `WS_DC` | `blr1` | Market-data datacenter (`blr1` or `nyc1`). MCX crude uses `blr1`. |
| `WS_TAG` | `go-charting-scraper` | `tag=` query param on the WebSocket URL (device id). |

`HEADLESS` and `PW_CHANNEL` are unused by the live scraper (kept as no-ops if
your old systemd unit still sets them).

Sampling math: samples are taken at `t = 0, SAMPLE_MS, 2*SAMPLE_MS, …`
while `t ≤ RUN_MS`.

- `RUN_MS=300000`, `SAMPLE_MS=30000` → **11** samples
- `RUN_MS=0` → **1** sample

`LAST_N` does not change the CSV schema; it only adds extra stdout lines
like:

```text
  5m last 5/172:
    2026-08-13T23:10:00+05:30  OHLC=7931/7938/7916/7920  MaxVolB=20 MaxVolS=15 totals=88/35 ...
```

---

## 10. CSV output

Default path: `investigation/evidence/maxvol-poc.csv`.

**The file is overwritten at the start of each run** (header + new rows).
If you need a history, point `CSV_PATH` at a timestamped file or copy the
CSV after each job.

### Columns

| Column | Description |
| --- | --- |
| `sampled_at_utc` | When this sample was taken (ISO UTC) |
| `sampled_at_ist` | Same instant, Asia/Kolkata |
| `sample_n` | 1-based sample index in this process |
| `interval` | `5m`, `10m`, or `15m` |
| `symbol` | `MCX:FUTURE:CRUDEOIL-I` |
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
| `ok` | `true` if a latest candle was written |
| `error` | Empty on success |

Price `level` values are **integer ticks** as sent by the feed (for crude,
e.g. `7811` ≈ 7811.00 display depending on instrument precision).

Example committed run: [`investigation/evidence/maxvol-poc.csv`](investigation/evidence/maxvol-poc.csv).

---

## 11. Common recipes

All commands assume you are in `investigation/` and credentials are
exported.

### One-shot, latest candle only (cron-friendly)

```bash
RUN_MS=0 CSV_PATH=/var/lib/gocharting/maxvol-$(date -u +%Y%m%dT%H%M%SZ).csv \
  node poc-log-maxvol.js
```

### Last 5 completed/forming candles (stdout)

```bash
RUN_MS=0 LAST_N=5 node poc-log-maxvol.js
```

CSV still has one row per interval (the latest candle). Read the `last 5`
block in the log for the rest.

### Live 5-minute sampler (repo default)

```bash
node poc-log-maxvol.js
```

### Live 1-hour sampler, one row every 30s

```bash
RUN_MS=3600000 SAMPLE_MS=30000 \
  CSV_PATH=/var/lib/gocharting/maxvol-hour.csv \
  node poc-log-maxvol.js
```

The process refreshes the Cognito JWT when less than five minutes of
lifetime remain, so a multi-hour run does not need a restart for auth.

---

## 12. Linux server / unattended deploy

### 12.1 Dedicated user and directories

```bash
sudo useradd --system --home /var/lib/gocharting --shell /usr/sbin/nologin gocharting || true
sudo mkdir -p /opt/go-charting-scraper /var/lib/gocharting/out
sudo chown -R gocharting:gocharting /var/lib/gocharting

sudo git clone https://github.com/anurag-roy/go-charting-scraper.git /opt/go-charting-scraper
cd /opt/go-charting-scraper/investigation
sudo -H -u gocharting bash -lc 'cd /opt/go-charting-scraper/investigation && npm ci'
sudo chown -R gocharting:gocharting /opt/go-charting-scraper
```

### 12.2 systemd — one-shot on a timer (recommended)

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

With `CSV_PATH=/var/lib/gocharting/maxvol.csv` each shot **overwrites** the
file. For an append-only archive, use a timestamped `CSV_PATH` in a small
wrapper script as `ExecStart`.

### 12.3 systemd — long-running process

Set `RUN_MS` to the window you want. The scraper refreshes the JWT in
process; `Restart=on-failure` with `RestartSec=30` is still a good idea.

### 12.4 cron alternative

`/etc/cron.d/gocharting`:

```cron
*/5 * * * * gocharting bash -lc 'set -a; source /etc/gocharting/env; set +a; cd /opt/go-charting-scraper/investigation && RUN_MS=0 /usr/bin/node poc-log-maxvol.js >> /var/lib/gocharting/run.log 2>&1'
```

---

## 13. Docker

A plain Node image is enough (no Playwright/Chromium):

```dockerfile
FROM node:22-bookworm-slim

WORKDIR /app
COPY investigation/package.json investigation/package-lock.json ./
RUN npm ci --omit=dev
COPY investigation/ ./

ENV RUN_MS=0
# credentials at runtime, not in the image:
#   -e GOCHARTING_EMAIL -e GOCHARTING_PASSWORD

CMD ["node", "poc-log-maxvol.js"]
```

Build and run:

```bash
docker build -t gocharting-scraper .
docker run --rm \
  -e GOCHARTING_EMAIL \
  -e GOCHARTING_PASSWORD \
  -e RUN_MS=0 \
  -e CSV_PATH=/data/maxvol.csv \
  -v /var/lib/gocharting:/data \
  gocharting-scraper
```

Do not bake passwords into the image.

---

## 14. What the scraper does *not* do

By design, matching the original investigation constraints:

- It does **not** open gocharting.com in a browser.
- It does **not** change GoCharting profile or chart settings.
- It does **not** click timeframe / layout / indicator buttons.
- 5m / 10m / 15m are requested as `FOOTPRINT/V2` and `TS/V2` `OHLCV/V2`
  WebSocket commands.
- It does **not** persist cookies between process starts (each run logs in
  via Cognito again).
- It does **not** subscribe to the live `trade` tape for incremental
  updates; it re-fetches footprint snapshots. That is enough for 30s
  polling.

---

## 15. Hardcoded target (symbol / intervals)

Edit `investigation/poc-log-maxvol.js` if you need a different contract.
Constants at the top:

```js
const WS_DC = process.env.WS_DC || 'blr1';
const SYMBOL = { exchange: 'MCX', segment: 'FUTURE', symbol: 'CRUDEOIL-I' };
const INTERVALS = ['5m', '10m', '15m'];
const SESSION = 'RTH';
```

Notes:

- The footprint **payload** uses `SYMBOL` + `INTERVALS`. The saved chart
  URL is not loaded.
- Interval strings must be what the API expects (`5m`, `10m`, `15m` are
  confirmed).
- `SESSION` is `RTH` as sent by the official client for this contract.
- WebSocket host is `wss://origin.ws.prodb.${WS_DC}.gocharting.com/${WS_DC}/ws`.
- Session calendar dates are computed in **Asia/Kolkata** (today,
  yesterday, day before) and requested newest-first.

---

## 16. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `missing GOCHARTING_EMAIL / GOCHARTING_PASSWORD` | Env not exported in that shell / service | `echo ${#GOCHARTING_EMAIL}` (length only). systemd: `EnvironmentFile=` path and `chmod 600`. |
| `cognito auth failed` | Bad password, user not confirmed, or Cognito throttling | Confirm the email/password work on gocharting.com. Check `debug.jsonl` for `cognito-ok` vs the error string (no secrets). |
| `cognito extra challenge` | MFA / new-password / custom challenge | This client uses `USER_PASSWORD_AUTH` only. Accounts that need MFA cannot be scraped this way without extra challenge handling. |
| `ws connect timeout` / `ws unexpected HTTP` | Egress blocked, wrong DC, or TLS intercept | Confirm outbound `443` to `origin.ws.prodb.blr1.gocharting.com`. Try `WS_DC=nyc1` only for US-sited symbols. |
| `ok=false` / `no candles` | Weekend/holiday, wrong symbol, or closed session with no history | Check `OUT_DIR/debug.jsonl` for `poc-ws-open`, `footprint`, `decode-err`. Confirm the contract is trading / has a session date. |
| All Max Vol B/S are `0` / tiny at 23:30 IST | Session closed | Expected. Use `LAST_N=5` to see the last full bars. |
| `values_match=false` | Decoder/schema drift | Re-fetch `footprint.proto` from `https://gocharting.com/assets/proto/1.1/footprint.proto` into `evidence/`. Open an issue with a redacted debug line. |
| Empty `open` / `close` | `TS/V2` OHLC bar not matched | Check `OUT_DIR/debug.jsonl` for `ohlc`, `ohlc-miss`, `ohlc-decode-err`. Re-fetch `ohlc_bars.proto`. `high`/`low` may still come from the footprint `ending_summary`. |
| CSV missing / empty | Wrong cwd or `CSV_PATH` not writable | Run from `investigation/`, or set an absolute `CSV_PATH`. |
| Works on SSH but not systemd | Different user / no env | See [§12.1](#121-dedicated-user-and-directories). `journalctl -u gocharting-maxvol.service`. |

Enable a one-off verbose look without extra flags: `OUT_DIR` +
`debug.jsonl` are enough. Never paste `debug.jsonl` in public tickets
without checking — redaction is best-effort.

### Quick self-test

```bash
RUN_MS=0 LAST_N=5 node poc-log-maxvol.js
```

---

## 17. Investigation / debug scripts

You do **not** need these to scrape. They were used to reverse-engineer
the protocol (`FINDINGS.md`) and still drive a real browser.

| Script | Role |
| --- | --- |
| `poc-log-maxvol.js` | **Production scraper** (this guide) — no browser |
| `investigate.js` | Login + dump HTTP / WS / console (bodies under `out/`) |
| `capture-frames.js` | Save full binary WS frames |
| `decode-frames.js` | Decode saved frames with `footprint.proto` |
| `recon.js` / `recon-login.js` | Page-structure probes |
| `analyze-ws.js` / `extract.js` | Offline helpers |

`investigation/out/` is gitignored because captures can contain JWTs and
cookies even after redaction attempts. Never commit it.

To re-run a protocol capture (this **does** need Playwright Chromium):

```bash
cd investigation
npx playwright install --with-deps chromium
export GOCHARTING_EMAIL=... GOCHARTING_PASSWORD=...
HEADLESS=1 node investigate.js          # or PW_CHANNEL=chrome xvfb-run -a
```

---

## 18. Security, git, and ToS

- Treat `GOCHARTING_PASSWORD` and the JWT as secrets. Rotate the password
  if it ever landed in a log, screenshot, or ticket.
- Do not commit `/etc/gocharting/env`, `.env`, `investigation/out/`, or
  raw `debug.jsonl` from a failed redaction.
- CSV files contain **volumes and prices only** and are safe to keep.
- This automation uses **your** account against GoCharting’s Cognito pool
  and WebSocket. Confirm their terms of use allow it. The usual breakage
  mode is a Cognito client-id or `FOOTPRINT/V2` schema change, not login
  markup.
- Be polite with polling. The official UI already streams this data;
  30s `FOOTPRINT/V2` snapshots are what the POC used. Sub-second loops
  are unnecessary for Max Vol B/S on 5m+ candles.

---

## Minimal copy-paste (Ubuntu, first time)

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper/investigation
npm ci

export GOCHARTING_EMAIL='you@example.com'
read -s GOCHARTING_PASSWORD && export GOCHARTING_PASSWORD

RUN_MS=0 LAST_N=5 node poc-log-maxvol.js
```

When that prints `cognito ok` and `ok=true` for `5m` / `10m` / `15m`,
scraping is working. Point `CSV_PATH` where you want the file, then add
the systemd timer in [§12](#12-linux-server--unattended-deploy).
