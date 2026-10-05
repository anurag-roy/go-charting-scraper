# Ubuntu VPS setup

Run the GoCharting scraper continuously on your Ubuntu 24.04 VPS alongside
the TradingView scraper. This guide uses your existing `ubuntu` account,
Node.js 24 at `/usr/local/bin/node`, and a separate checkout at
`/opt/go-charting-scraper`. Run commands as `ubuntu`, using sudo where shown.

GoCharting signs in through AWS Cognito and fetches data over a WebSocket.
It does not need Chrome, Xvfb, noVNC, a login portal, Nginx changes, a domain,
or any additional public firewall ports. Keep the TradingView services and
their configuration in place.

The process stays running outside market hours, closes its data connection
when idle, and reconnects for the next configured exchange session. Times are
calculated explicitly in Asia/Kolkata, including when the server uses UTC.

## 1. Check the existing server

```bash
whoami
/usr/local/bin/node --version
/usr/local/bin/npm --version
sudo systemctl status tradingview-monitor.service tradingview-login.service
free -h
df -h /opt
```

The user should be `ubuntu`, and Node should be v24.x. If Node is missing,
complete the Node installation in the TradingView scraper's `SETUP.md`
before continuing. On a fresh server, prepare Ubuntu, SSH access, and Node 24
first; this scraper only additionally needs Git and outbound HTTPS/WSS.

```bash
sudo apt update
sudo apt install -y ca-certificates git
```

Outbound access is needed to AWS Cognito in `ap-south-1`, the GoCharting data
host (`origin.ws.prodb.blr1.gocharting.com` by default), Google Sheets, and
Google authentication endpoints. Do not change the existing inbound firewall
or TradingView Nginx configuration for this app.

## 2. Deploy the checkout

Deploy a revision containing this guide and the updated `deploy/` directory.
If the changes are only on your computer, push that revision to the repository
or upload the checkout first; cloning does not copy uncommitted local changes.

```bash
sudo install -d -m 750 -o ubuntu -g ubuntu /opt/go-charting-scraper
git clone https://github.com/anurag-roy/go-charting-scraper.git /opt/go-charting-scraper
cd /opt/go-charting-scraper
/usr/local/bin/npm ci --omit=dev
install -m 600 .env.example .env
install -d -m 700 .auth
install -d -m 700 logs
```

Reuse an existing checkout instead of cloning into a populated directory.
Do not overwrite an existing `.env`. Install dependencies as `ubuntu` rather
than root; the checkout and runtime files should belong to `ubuntu`.

## 3. Install the Google service-account key

You can reuse the service account used by TradingView. Enable the Google
Sheets API in its Cloud project and share the **GoCharting spreadsheet** with
its email as **Editor**. Reusing a key does not grant access to another Sheet
automatically. The two apps use their own spreadsheet configuration.

If the TradingView key is at the path used in its setup guide:

```bash
install -m 600 /opt/tradingview-scraper/.auth/google-service-account.json \
  /opt/go-charting-scraper/.auth/google-service-account.json
```

Alternatively, upload your service-account JSON from your computer:

```bash
scp /path/to/google-service-account.json ubuntu@YOUR_VPS_IP:/home/ubuntu/gocharting-key.json
```

Then on the VPS:

```bash
install -m 600 /home/ubuntu/gocharting-key.json \
  /opt/go-charting-scraper/.auth/google-service-account.json
rm /home/ubuntu/gocharting-key.json
```

The installed key must be owned by `ubuntu`, with mode `600`; `.auth` must
have mode `700`. A root-owned key with mode `600` is unreadable by the service.
Keep keys and `.env` out of Git and public logs.

## 4. Configure the app and spreadsheet

```bash
nano /opt/go-charting-scraper/.env
```

Set these values, replacing the spreadsheet placeholder:

```dotenv
GOOGLE_SHEET_ID=https://docs.google.com/spreadsheets/d/YOUR_GOCHARTING_SHEET_ID/edit
GOOGLE_SERVICE_ACCOUNT_JSON=./.auth/google-service-account.json
CONFIG_TAB=config
CONFIG_POLL_MS=5000
SAMPLE_MS=15000
HTTP_TIMEOUT_MS=20000
WS_HEARTBEAT_MS=30000
```

Leave `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` blank when using the key
file. Leave `ONCE` and `LAST_WORKING_DAY` unset for normal operation. The
systemd service explicitly fixes both to `0`, even if `.env` contains them.

The `config` tab supplies the **GoCharting email and password**, plus up to
six instruments and their timeframes in columns C–E. Those credentials are
not read from `.env`. Use the existing spreadsheet if it already works on
your computer; see [README.md](README.md#config-sheet) for the exact layout.
Restrict spreadsheet sharing because the GoCharting password is plaintext
there. The current authentication flow supports email/password sign-in
without an additional Cognito challenge; MFA challenges are reported as errors.

The app creates and writes the static candle tabs `1A`–`6C`. It keeps only
the current IST calendar day's rows. Changing an instrument or timeframe
overwrites that slot's data and backfills the current session.

Check permissions without printing credentials:

```bash
chmod 600 /opt/go-charting-scraper/.env
test -r /opt/go-charting-scraper/.auth/google-service-account.json
test -w /opt/go-charting-scraper/logs
```

## 5. Stop the laptop copy and verify a first run

Stop this scraper on your computer before starting it on the VPS against
the same spreadsheet. The instance guard blocks duplicate writers in the
same host network namespace, including one-shot runs and other checkouts.
It cannot block a writer on another computer or in a container with separate
networking. Use only one active writer per spreadsheet.

With the VPS service still stopped:

```bash
cd /opt/go-charting-scraper
ONCE=1 /usr/local/bin/node src/index.js
```

This is a real run: it may create tabs, clear previous-day rows, and write
closed candles to the configured spreadsheet. During or after a trading-day
session, expect decoded candle counts and `wrote N new closed-candle row(s)`.
A second run should skip existing candles; it may still fill missing cells.
Check the actual Sheet for the rows.

Before market opening, on a weekend, or on an NSE/BSE holiday, a normal one-shot
run can finish without fetching market data. To inspect the last trading
session's data instead:

```bash
LAST_WORKING_DAY=1 ONCE=1 /usr/local/bin/node src/index.js
```

That command keeps the previous session's rows for this run. Do not leave
`LAST_WORKING_DAY=1` in production. If either run reports authentication,
network, or Sheets errors, fix them before enabling the service. A failed
one-shot data sample exits with a nonzero status.

## 6. Install and start the service

```bash
sudo install -m 644 /opt/go-charting-scraper/deploy/gocharting-scraper.service \
  /etc/systemd/system/gocharting-scraper.service
sudo systemd-analyze verify /etc/systemd/system/gocharting-scraper.service
sudo systemctl daemon-reload
sudo systemctl enable --now gocharting-scraper.service
sudo systemctl status gocharting-scraper.service
sudo journalctl -u gocharting-scraper.service -f
```

The service runs as `ubuntu`, loads the checkout's `.env`, starts at boot,
and restarts after a process failure. SIGTERM cancels HTTP requests, retry
waits, and pending socket requests. systemd allows 40 seconds for shutdown
and stops the entire process group before a restart.

The instance guard reserves a spreadsheet-specific port on `127.0.0.1` in
the range 20000–29999. It serves no application API and is not reachable on
the public interface. No firewall opening is required. The OS releases it
after exit, a crash, or reboot, so there is no stale lock file to delete.
A collision with another local listener blocks startup and names the port
in the error; inspect its owner before stopping any process.

## 7. Observe continuous operation

```bash
sudo journalctl -u gocharting-scraper.service -n 100 --no-pager
cat /opt/go-charting-scraper/logs/status.json
sudo systemctl status gocharting-scraper.service tradingview-monitor.service tradingview-login.service
free -h
```

`status.json` includes `updatedAt`, `lastConfigAt`, `lastAttemptAt`,
`lastSampleAt`, `lastError`, `retryAt`, `state`, and `ws`.

- `lastSampleAt` advances only when all requested footprint/OHLC responses
  succeed and their writes complete. A config heartbeat alone does not prove
  market data is arriving. A successful sample may append zero rows because
  candles are already present or still forming.
- `idle` and a closed WebSocket are expected outside configured market hours.
- `degraded` records an error. Failed samples retry after 1, 2, 4, … up to
  60 seconds. Failed instruments stay eligible for backfill; already written
  candles are deduplicated from the Sheet.
- Cognito, Google token, and Sheets HTTP requests have a 20-second deadline
  by default. Google quota/server errors have bounded retries too; all retry
  waits cancel during shutdown.
- The WebSocket sends a ping every 30 seconds. A missed pong for two ticks
  or three consecutive unanswered data requests closes the socket so the
  scheduler can reconnect. Explicit empty responses are reported separately
  from missing responses.
- Error logs rotate at 5 MB with three backups. `status.json` contains the
  GoCharting email; keep it private.

Check actual CPU/RAM usage with both scrapers enabled before resizing the
server. After your next scheduled reboot, confirm both scrapers started and
the GoCharting Sheet resumes updating during a session.

## Updates

```bash
sudo systemctl stop gocharting-scraper.service
cd /opt/go-charting-scraper
git pull --ff-only
/usr/local/bin/npm ci --omit=dev
sudo install -m 644 deploy/gocharting-scraper.service /etc/systemd/system/gocharting-scraper.service
sudo systemd-analyze verify /etc/systemd/system/gocharting-scraper.service
sudo systemctl daemon-reload
sudo systemctl restart gocharting-scraper.service
sudo systemctl status gocharting-scraper.service
```

Stop if the Git update, install, or unit validation fails. Inspect VPS-local
changes instead of forcing a reset. Preserve `.env`, `.auth/`, and `logs/`.
Do not run another one-shot sample while the service is active; stop the
service first. Restart only this service after changing its `.env`; instrument
and credential changes in the Sheet are polled automatically.

## Holiday calendar updates

The service reads `.data/nse_holidays.csv` at startup. This is a local copy of
[your NSE calendar](https://github.com/anurag-roy/all-option-chain/blob/main/.data/nse_holidays.csv),
currently covering 2024–2027. Saturdays and Sundays are always closed. NSE/BSE
instruments also skip the CSV dates; MCX keeps its existing weekday schedule.
The service stays active, polls the config Sheet, and resumes market-data
collection automatically at the next trading-day open. Sheet retention still
uses the current IST calendar day in normal operation.

After adding or correcting dates in the source CSV, run these commands as
`ubuntu` on the VPS:

```bash
cd /opt/go-charting-scraper
/usr/local/bin/npm run holidays:update
```

If the update succeeds, reload the calendar by restarting only this service:

```bash
sudo systemctl restart gocharting-scraper.service
sudo journalctl -u gocharting-scraper.service -n 30 --no-pager
```

Look for `NSE/BSE holiday calendar loaded` with the date count and covered
years. The updater validates the downloaded CSV and replaces the file
atomically; a failed download or invalid CSV leaves the old copy in place.
Restart after a successful update. No GitHub connection is needed during
normal operation, and calendar updates require no code change. Preserve the
CSV's `date,holiday` header and `DD-Mmm-YYYY` dates.

Refresh the local copy before trading starts in a year not yet in it. Missing
years only have weekend protection. This calendar lists full-day closures;
special sessions such as Muhurat trading are outside the normal schedule.
`LAST_WORKING_DAY=1` remains a debugging override to backfill the previous
trading session on closed days; leave it unset in production.

## Migrating the older VPS service

If you previously installed this app with the `gocharting` Linux user and
`/etc/gocharting/env`, stop its service first. Copy its Google configuration
values into the checkout's private `.env` without printing secrets. Install
its existing key into `.auth` with `ubuntu` ownership, then fix the checkout:

```bash
sudo systemctl stop gocharting-scraper.service
sudo chown -R ubuntu:ubuntu /opt/go-charting-scraper
sudo chmod 600 /opt/go-charting-scraper/.env
sudo chmod 700 /opt/go-charting-scraper/.auth
sudo chmod 600 /opt/go-charting-scraper/.auth/google-service-account.json
```

Replace the old unit using step 6. The new unit does not load
`/etc/gocharting/env`; its credentials must be in the new `.env`. A Google key
inside `/home/ubuntu` is hidden by `ProtectHome=true`, so use the `.auth` path
under `/opt`. Adjust the unit's user/group explicitly if your VPS account has
a different name.

## Troubleshooting

- **Service cannot execute Node:** check `/usr/local/bin/node --version` and
  the installed unit's `ExecStart`. Reuse the TradingView Node installation.
- **Credentials missing or unreadable:** check `.env`, the JSON path, and
  `ubuntu` ownership. Keys under `/opt/go-charting-scraper/.auth` must be
  readable by `ubuntu`. Google 403 errors usually require enabling the Sheets
  API and sharing the spreadsheet as Editor.
- **Instance guard unavailable:** a scraper or another listener owns the
  port named in the error. Use `sudo ss -ltnp` to identify it. Stop the
  duplicate scraper normally; do not kill an unrelated service blindly.
- **Cognito extra challenge:** the current sign-in flow cannot complete MFA.
  Check the account's authentication requirements. Authentication errors do
  not open a browser portal.
- **Stale data while systemd says active:** inspect `lastSampleAt`, `lastError`,
  and the journal. Verify the symbol, account access, current market window,
  holiday status, and outbound connectivity. Empty responses remain errors
  rather than claiming successful data collection.
- **Service start limit reached:** fix the reported startup problem, then run
  `sudo systemctl reset-failed gocharting-scraper.service` followed by
  `sudo systemctl start gocharting-scraper.service`.
- **No new rows after an outage:** the app recovers only the session it can
  currently retain. Previous IST calendar days are not automatically restored.
  Check current-session data before relying on formulas that consume it.

The GoCharting authentication and data protocol are unofficial web interfaces.
Validate actual login, market data, Sheet writes, reconnection, and startup after
reboot on your VPS; local checks cannot establish provider access from that server.
