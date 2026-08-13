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
7. [Install a browser for Playwright](#7-install-a-browser-for-playwright)
8. [Configure credentials](#8-configure-credentials)
9. [First successful scrape](#9-first-successful-scrape)
10. [Environment variables](#10-environment-variables)
11. [CSV output](#11-csv-output)
12. [Common recipes](#12-common-recipes)
13. [Linux server / unattended deploy](#13-linux-server--unattended-deploy)
14. [Docker](#14-docker)
15. [Headed Chrome + Xvfb fallback](#15-headed-chrome--xvfb-fallback)
16. [What the scraper does *not* do](#16-what-the-scraper-does-not-do)
17. [Hardcoded target (chart / symbol / intervals)](#17-hardcoded-target-chart--symbol--intervals)
18. [Troubleshooting](#18-troubleshooting)
19. [Investigation / debug scripts](#19-investigation--debug-scripts)
20. [Security, git, and ToS](#20-security-git-and-tos)

---

## 1. What you get

The live scraper is `investigation/poc-log-maxvol.js`.

It logs into the saved chart
`https://gocharting.com/terminal/chart/kd5OXEIXs`, then every sample interval
requests footprint data for **5m**, **10m**, and **15m** candles of
`MCX:FUTURE:CRUDEOIL-I` and writes:

| Field | Meaning |
| --- | --- |
| **Max Vol B** | Largest **buy** volume at any single price level in that candle (`max.buy.volume`) |
| **Max Vol S** | Largest **sell** volume at any single price level in that candle (`max.sell.volume`) |

Default behaviour: sample every **30 seconds** for **5 minutes** (11 samples ×
3 intervals = 33 CSV rows), then exit.

Verified on Linux:

- Headless Playwright Chromium (**no display, no Xvfb**)
- Headless system Google Chrome (`PW_CHANNEL=chrome`)
- Headed Chrome under Xvfb (`xvfb-run -a`)

---

## 2. How the scraper works

You do **not** need to understand this to run it. It is here so the setup
choices (browser, outbound hosts, secrets) make sense.

1. Playwright opens the saved-chart URL and signs in with
   `GOCHARTING_EMAIL` / `GOCHARTING_PASSWORD` (AWS Cognito).
2. Cognito issues a JWT. The market-data WebSocket is
   `wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws?token=<JWT>`.
3. The Node process opens **its own** WebSocket (the browser is only needed
   for login / token).
4. It sends JSON `FOOTPRINT/V2` commands for intervals `5m`, `10m`, `15m`.
5. The server replies with **binary Protobuf** frames (sometimes
   deflate-compressed). The script decodes them with
   `investigation/evidence/footprint.proto`.
6. For each interval it keeps the **latest candle** (newest `candle.date`,
   Asia/Kolkata session) and writes `max.buy.volume` / `max.sell.volume` to CSV.
7. It also recomputes `max(level.buy.volume)` / `max(level.sell.volume)` and
   records `values_match=true` when they agree with the server.

There is **no REST/JSON endpoint** for these numbers. Do not try to scrape
them out of the DOM; the chart canvas does not expose them as text.

Cognito id tokens typically last about **one hour**. Each process currently
logs in once at start, then re-requests footprint data for the whole run.
A 5-minute default run is well inside that window. For a multi-hour sampler,
restart the process (or re-login) at least hourly.

---

## 3. What you need before cloning

### Account

- A working [GoCharting](https://gocharting.com) login that can open
  `https://gocharting.com/terminal/chart/kd5OXEIXs`.
- That saved layout is a 3×3 of `MCX:FUTURE:CRUDEOIL-I` footprint charts.
  If the chart id is deleted or made private, login will still work but
  you should update `CHART_URL` in the script (see [§17](#17-hardcoded-target-chart--symbol--intervals)).

### Machine

| Item | Recommendation |
| --- | --- |
| OS | Ubuntu 22.04 / 24.04 (Debian 12 is fine). macOS also works with headless Chromium. |
| CPU / RAM | 1 vCPU is enough; **≥ 2 GB RAM** (Chrome is the heavy part). Add swap on a 1 GB VPS. |
| Disk | ~500 MB for Node + Playwright Chromium; plus CSV growth. |
| Display | **Not required** if you use `HEADLESS=1`. |
| Privileges | A normal user is enough. `--no-sandbox` is already passed (needed in many containers / as root). |

### Network (outbound)

The host must reach at least:

| Host | Why |
| --- | --- |
| `gocharting.com` (HTTPS) | Chart UI, login page, APIs, `footprint.proto` |
| `cognito-idp.ap-south-1.amazonaws.com` (HTTPS) | Auth / JWT |
| `origin.ws.prodb.blr1.gocharting.com` (WSS `443`) | Market data |
| `cdn.playwright.dev` (HTTPS) | First-time Chromium download |

If you use a firewall / egress allowlist, also allow typical CDNs used by
the chart page (CloudFront / similar). A first run with `HEADLESS=1` will
fail fast if login or the WebSocket is blocked.

### Software you must have (or will install below)

- `git`
- **Node.js 20 or 22** (22 is what this was developed on)
- `npm` (comes with Node)
- A Chromium/Chrome that Playwright can launch (installed in [§7](#7-install-a-browser-for-playwright))

Optional:

- `xvfb` + Google Chrome — only if headless login is blocked (see [§15](#15-headed-chrome--xvfb-fallback))
- `docker` — see [§14](#14-docker)

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

If you are deploying a specific branch (for example the Max Vol POC branch):

```bash
git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
git checkout cursor/maxvol-poc-csv-c8af   # or main, once merged
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
      footprint.proto      ← Protobuf schema used to decode frames
      maxvol-poc.csv       ← example 5-minute run
    out/                   ← gitignored; screenshots + debug logs
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

This installs `playwright`, `protobufjs`, `pako`, and `ws` into
`investigation/node_modules/` (gitignored).

`npm ci` / `npm install` does **not** download a browser binary by itself.
Do the next section.

---

## 7. Install a browser for Playwright

### Recommended: Playwright Chromium (headless, no Google Chrome package)

Still inside `investigation/`:

```bash
npx playwright install --with-deps chromium
```

- `install chromium` downloads Playwright’s Chromium into
  `~/.cache/ms-playwright/`.
- `--with-deps` installs Ubuntu/Debian system libraries (fonts, `libnss3`,
  `libgbm1`, etc.) via `apt`. Needs `sudo` on a fresh server.

Confirm:

```bash
ls ~/.cache/ms-playwright | head
npx playwright --version    # should report 1.62.x to match package.json
```

### Alternative: system Google Chrome

If you already have Chrome:

```bash
google-chrome --version    # or google-chrome-stable --version
```

Then pass `PW_CHANNEL=chrome` on every run. You still want the OS libraries
Playwright expects (`npx playwright install --with-deps chrome` can install
Chrome + deps).

---

## 8. Configure credentials

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
HEADLESS=1
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

## 9. First successful scrape

From `investigation/` with credentials exported:

```bash
cd /path/to/go-charting-scraper/investigation

# One snapshot of the latest candle on 5m / 10m / 15m (~30–45 seconds)
HEADLESS=1 RUN_MS=0 node poc-log-maxvol.js
```

`RUN_MS=0` means “take the sample at t=0 and exit” (login + one
`FOOTPRINT/V2` round-trip). Default without `RUN_MS` is a **5-minute** run.

### Success looks like

```text
browser launch { headless: true, channel: 'playwright-chromium' }
goto https://gocharting.com/terminal/chart/kd5OXEIXs
login
loginModalGone= true url= https://gocharting.com/terminal/chart/kd5OXEIXs
session dates (IST): 2026-08-14, 2026-08-13, 2026-08-12
sampling 5m, 10m, 15m every 30s for 0s
csv -> .../evidence/maxvol-poc.csv

--- sample 1 @ 2026-08-13T18:41:57.875Z ---
  5m: ok=true candle=2026-08-13T23:30:00+05:30  MaxVolB=0 MaxVolS=10 match=true n=172
  10m: ok=true ...
  15m: ok=true ...
DONE samples= 1 csv= ...
```

Checklist:

| Check | Meaning |
| --- | --- |
| `loginModalGone= true` | Cognito login succeeded |
| `ok=true` | At least one footprint candle decoded |
| `match=true` | Server max equals recomputed per-level max |
| `n=` large (tens–hundreds) | Full session history came back, not an empty payload |

Also written:

- CSV: `investigation/evidence/maxvol-poc.csv` unless `CSV_PATH` is set
- Screenshot: `investigation/out/poc/after-login.png` (or `OUT_DIR`)
- Debug JSONL: `investigation/out/poc/debug.jsonl` (tokens redacted)

If `loginModalGone= false`, see [§18](#18-troubleshooting). A
`login-failed.png` is saved in `OUT_DIR`.

---

## 10. Environment variables

All are optional except the two credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOCHARTING_EMAIL` | *(required)* | Login email |
| `GOCHARTING_PASSWORD` | *(required)* | Login password |
| `HEADLESS` | unset / false | `1`, `true`, or `yes` → Playwright `headless: true`. **Use this on servers.** |
| `PW_CHANNEL` | unset | `chrome` = system Google Chrome. Unset = Playwright’s Chromium. |
| `RUN_MS` | `300000` (5 min) | How long to keep sampling after the first sample. `0` = one shot. |
| `SAMPLE_MS` | `30000` | Delay between samples. |
| `LAST_N` | `0` (off) | If `> 0`, print the last N candles per interval to stdout (CSV still stores the **latest** candle only). |
| `CSV_PATH` | `investigation/evidence/maxvol-poc.csv` | Destination CSV (overwritten each run). |
| `OUT_DIR` | `investigation/out/poc` | Screenshots + `debug.jsonl`. |

Launch args always include `--no-sandbox` and `--disable-dev-shm-usage`.

Sampling math: samples are taken at `t = 0, SAMPLE_MS, 2*SAMPLE_MS, …`
while `t ≤ RUN_MS`.

- `RUN_MS=300000`, `SAMPLE_MS=30000` → **11** samples
- `RUN_MS=0` → **1** sample

`LAST_N` does not change the CSV schema; it only adds extra stdout lines
like:

```text
  5m last 5/172:
    2026-08-13T23:10:00+05:30  MaxVolB=20 MaxVolS=15 totals=88/35 ...
```

---

## 11. CSV output

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

## 12. Common recipes

All commands assume you are in `investigation/` and credentials are
exported.

### One-shot, latest candle only (cron-friendly)

```bash
HEADLESS=1 RUN_MS=0 CSV_PATH=/var/lib/gocharting/maxvol-$(date -u +%Y%m%dT%H%M%SZ).csv \
  node poc-log-maxvol.js
```

### Last 5 completed/forming candles (stdout)

```bash
HEADLESS=1 RUN_MS=0 LAST_N=5 node poc-log-maxvol.js
```

CSV still has one row per interval (the latest candle). Read the `last 5`
block in the log for the rest.

### Live 5-minute sampler (repo default)

```bash
HEADLESS=1 node poc-log-maxvol.js
```

### Live 1-hour sampler, one row every 30s

```bash
HEADLESS=1 RUN_MS=3600000 SAMPLE_MS=30000 \
  CSV_PATH=/var/lib/gocharting/maxvol-hour.csv \
  node poc-log-maxvol.js
```

Restart before the JWT expires (~1 hour) or accept a reconnect/login on
the next process start.

### System Chrome instead of Playwright Chromium

```bash
HEADLESS=1 PW_CHANNEL=chrome RUN_MS=0 node poc-log-maxvol.js
```

---

## 13. Linux server / unattended deploy

### 13.1 Dedicated user and directories

```bash
sudo useradd --system --home /var/lib/gocharting --shell /usr/sbin/nologin gocharting || true
sudo mkdir -p /opt/go-charting-scraper /var/lib/gocharting/out
sudo chown -R gocharting:gocharting /var/lib/gocharting

# clone as that user, or clone then chown
sudo git clone https://github.com/anurag-roy/go-charting-scraper.git /opt/go-charting-scraper
cd /opt/go-charting-scraper/investigation
sudo -H -u gocharting bash -lc 'cd /opt/go-charting-scraper/investigation && npm ci && npx playwright install chromium'
# --with-deps must run as root once:
sudo /opt/go-charting-scraper/investigation/node_modules/.bin/playwright install --with-deps chromium
sudo chown -R gocharting:gocharting /opt/go-charting-scraper
```

Playwright browsers downloaded as `root` land in `/root/.cache/ms-playwright`.
Either run `npx playwright install chromium` **as `gocharting`** (shown
above) or set `PLAYWRIGHT_BROWSERS_PATH` to a shared directory both the
install and the service use, for example `/var/lib/gocharting/ms-playwright`.

```bash
# optional: shared browser cache
sudo mkdir -p /var/lib/gocharting/ms-playwright
sudo chown gocharting:gocharting /var/lib/gocharting/ms-playwright
# add to /etc/gocharting/env:
# PLAYWRIGHT_BROWSERS_PATH=/var/lib/gocharting/ms-playwright
```

Then as `gocharting`:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/var/lib/gocharting/ms-playwright
cd /opt/go-charting-scraper/investigation
npx playwright install chromium
```

### 13.2 systemd — one-shot on a timer (recommended)

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
Environment=HEADLESS=1
Environment=RUN_MS=0
# Uncomment if using system Chrome:
# Environment=PW_CHANNEL=chrome
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

### 13.3 systemd — long-running process

Set `RUN_MS` to the window you want (keep it under ~50 minutes so the JWT
does not expire mid-run), and `Restart=on-failure` with `RestartSec=30`.

For a process that should sample forever, a timer that starts a 30–45
minute `RUN_MS` job is simpler than an infinite loop: each job logs in
fresh.

### 13.4 cron alternative

`/etc/cron.d/gocharting`:

```cron
*/5 * * * * gocharting bash -lc 'set -a; source /etc/gocharting/env; set +a; cd /opt/go-charting-scraper/investigation && /usr/bin/node poc-log-maxvol.js >> /var/lib/gocharting/run.log 2>&1'
```

Ensure `/etc/gocharting/env` contains `HEADLESS=1` and `RUN_MS=0`.

---

## 14. Docker

Playwright publishes images that already contain Chromium and OS deps.
Tag should match `package.json` (`playwright` `^1.62.1`):

```dockerfile
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app
COPY investigation/package.json investigation/package-lock.json ./
RUN npm ci --omit=dev
COPY investigation/ ./

ENV HEADLESS=1
ENV RUN_MS=0
# credentials at runtime, not in the image:
#   -e GOCHARTING_EMAIL -e GOCHARTING_PASSWORD

CMD ["node", "poc-log-maxvol.js"]
```

Build and run:

```bash
docker build -t gocharting-scraper .
docker run --rm \
  --ipc=host \
  -e GOCHARTING_EMAIL \
  -e GOCHARTING_PASSWORD \
  -e HEADLESS=1 \
  -e RUN_MS=0 \
  -e CSV_PATH=/data/maxvol.csv \
  -v /var/lib/gocharting:/data \
  gocharting-scraper
```

`--ipc=host` (or the script’s `--disable-dev-shm-usage`, already set)
avoids Chromium crashing on a tiny `/dev/shm` in Docker.

Do not bake passwords into the image.

---

## 15. Headed Chrome + Xvfb fallback

Use this only if `HEADLESS=1` fails login (modal stays up, captcha, or
empty screenshot). This is how the original capture tooling ran.

```bash
sudo apt-get install -y xvfb google-chrome-stable
cd investigation
export GOCHARTING_EMAIL=...
export GOCHARTING_PASSWORD=...
PW_CHANNEL=chrome xvfb-run -a node poc-log-maxvol.js
```

Leave `HEADLESS` unset so the script launches `headless: false` inside the
virtual framebuffer.

systemd `ExecStart` becomes:

```ini
Environment=PW_CHANNEL=chrome
ExecStart=/usr/bin/xvfb-run -a /usr/bin/node poc-log-maxvol.js
```

On this project, **headless was verified to work**, so you should not need
Xvfb unless GoCharting starts blocking headless Chrome.

---

## 16. What the scraper does *not* do

By design, matching the original investigation constraints:

- It does **not** change GoCharting profile or chart settings.
- It does **not** click timeframe / layout / indicator buttons.
- 5m / 10m / 15m are requested as `FOOTPRINT/V2` WebSocket commands.
- It only clicks **Dismiss** (promo), **login avatar**, and **Sign In**.
- It does **not** persist cookies between process starts (each run logs in
  again).
- It does **not** subscribe to the live `trade` tape for incremental
  updates; it re-fetches footprint snapshots. That is enough for 30s
  polling.

---

## 17. Hardcoded target (chart / symbol / intervals)

Edit `investigation/poc-log-maxvol.js` if you need a different layout or
contract. Constants at the top:

```js
const CHART_URL = 'https://gocharting.com/terminal/chart/kd5OXEIXs';
const DEFAULT_WS_HOST = 'wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws';
const SYMBOL = { exchange: 'MCX', segment: 'FUTURE', symbol: 'CRUDEOIL-I' };
const INTERVALS = ['5m', '10m', '15m'];
const SESSION = 'RTH';
```

Notes:

- `CHART_URL` is used so login happens on a real terminal page (Cognito +
  WS token). The footprint **payload** uses `SYMBOL` + `INTERVALS`, not
  whatever panes happen to be visible.
- Interval strings must be what the API expects (`5m`, `10m`, `15m` are
  confirmed).
- `SESSION` is `RTH` as sent by the official client for this contract.
- `DEFAULT_WS_HOST` is a fallback if the page’s WS URL is not observed;
  the live host is taken from the browser after login when possible.
- Session calendar dates are computed in **Asia/Kolkata** (today,
  yesterday, day before) and requested newest-first.

---

## 18. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `missing GOCHARTING_EMAIL / GOCHARTING_PASSWORD` | Env not exported in that shell / service | `echo ${#GOCHARTING_EMAIL}` (length only). systemd: `EnvironmentFile=` path and `chmod 600`. |
| `browserType.launch: Executable doesn't exist` | Chromium not installed for this user | `npx playwright install chromium` as the **same user** that runs the service. Or set `PLAYWRIGHT_BROWSERS_PATH`. |
| `TargetClosedError` / sandbox errors | Restricted container | Script already uses `--no-sandbox`. Install `--with-deps`. Give the cgroup enough memory. |
| `login modal still present` | Bad password, captcha, headless blocked, slow UI | Open `OUT_DIR/login-failed.png`. Retry headed+Xvfb ([§15](#15-headed-chrome--xvfb-fallback)). Wait: login currently sleeps 8s after submit. |
| `loginModalGone= true` but `ok=false` / `no candles` | WS token missing, weekend/holiday, wrong symbol | Check `OUT_DIR/debug.jsonl` for `poc-ws-open`, `footprint`, `decode-err`. Confirm the contract is trading / has a session date. |
| `could not obtain market-data websocket URL` | Chart page never opened WS | Screenshot `after-login.png`. Confirm egress to `origin.ws.prodb.blr1.gocharting.com`. |
| All Max Vol B/S are `0` / tiny at 23:30 IST | Session closed | Expected. Use `LAST_N=5` to see the last full bars. |
| `values_match=false` | Decoder/schema drift | Re-fetch `footprint.proto` from `https://gocharting.com/assets/proto/1.1/footprint.proto` into `evidence/`. Open an issue with a redacted debug line. |
| CSV missing / empty | Wrong cwd or `CSV_PATH` not writable | Run from `investigation/`, or set an absolute `CSV_PATH`. |
| Process killed (137) | OOM | 2 GB RAM or swap; do not run many Chromes in parallel. |
| Works on SSH but not systemd | Different user / no env / no browser cache | See [§13.1](#131-dedicated-user-and-directories). `journalctl -u gocharting-maxvol.service`. |

Enable a one-off verbose look without extra flags: `OUT_DIR` +
`debug.jsonl` + the after-login PNG are enough. Never paste
`debug.jsonl` in public tickets without checking — redaction is best-effort.

### Quick self-test matrix

```bash
# 1) Playwright Chromium, headless (should be your default)
HEADLESS=1 RUN_MS=0 node poc-log-maxvol.js

# 2) System Chrome, headless
HEADLESS=1 PW_CHANNEL=chrome RUN_MS=0 node poc-log-maxvol.js

# 3) Fallback
PW_CHANNEL=chrome xvfb-run -a node poc-log-maxvol.js
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
- Do not commit `/etc/gocharting/env`, `.env`, `investigation/out/`, or
  raw `debug.jsonl` from a failed redaction.
- CSV files contain **volumes and prices only** and are safe to keep.
- This automation uses **your** account against GoCharting’s site and
  WebSocket. Confirm their terms of use allow it. Expect login markup
  (`#email_field`, `#login-avatar`) to change; that is the usual breakage
  mode.
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
npx playwright install --with-deps chromium

export GOCHARTING_EMAIL='you@example.com'
read -s GOCHARTING_PASSWORD && export GOCHARTING_PASSWORD

HEADLESS=1 RUN_MS=0 LAST_N=5 node poc-log-maxvol.js
```

When that prints `loginModalGone= true` and `ok=true` for `5m` / `10m` /
`15m`, scraping is working. Point `CSV_PATH` where you want the file, then
add the systemd timer in [§13](#13-linux-server--unattended-deploy).
