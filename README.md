# go-charting-scraper

24×7 service that reads GoCharting credentials and instruments from a Google
Sheet, scrapes **closed** 2m / 3m / 5m footprint candles, and writes them back
into that same spreadsheet. The process is meant to run unattended on a VPS.

Handing this to a client on a **Windows laptop** that is powered on each
morning (not left on 24×7): [`WINDOWS.md`](WINDOWS.md).

GoCharting login is AWS Cognito over HTTPS (no browser). Market data is the
WebSocket + Protobuf protocol documented in
[`investigation/FINDINGS.md`](investigation/FINDINGS.md).

## What it does

1. Polls the `config` tab every 5 seconds (12 Google reads/minute; the Sheets
   API allowance is 60 reads/minute/user).
2. Authenticates with the email/password from that tab and keeps the JWT in
   process memory only (refresh before expiry; never written to disk).
3. Tracks up to six instruments (`Instrument1`–`Instrument6`) in
   `EXCHANGE:CATEGORY:SYMBOL` form (`NSE`, `BSE`, or `MCX`).
4. For each instrument, writes **closed** 2m / 3m / 5m candles to tabs named
   `{symbol} 2m`, `{symbol} 3m`, `{symbol} 5m` — for example
   `NIFTY2681824300CE 2m`. Forming bars are never written. Each tab keeps
   **only the current IST day’s rows**; previous-day candles are deleted in
   the morning.
5. If an instrument changes from X to Y, monitoring switches to Y and new tabs
   are created. X’s tabs are left in place. Y is backfilled for **today’s**
   session only (not previous weekdays).
6. Stays running overnight and on weekends. NSE/BSE are sampled 09:15–15:40
   IST; MCX energy-style contracts 09:00–23:30 IST (23:55 while US Eastern is
   on daylight saving). Outside those windows the websocket is closed.

## Config sheet

Create a tab named `config` with labels in column A and values in column B:

| A | B |
| --- | --- |
| email | GoCharting login |
| password | GoCharting password |
| Instrument1 | `NSE:FUTURE:NIFTY-I` |
| Instrument2 | `MCX:FUTURE:CRUDEOIL-I` |
| Instrument3 | `NSE:OPTIONS:NIFTY2681824300CE` |
| Instrument4 | *(optional)* |
| Instrument5 | *(optional)* |
| Instrument6 | *(optional)* |

Share the spreadsheet with the service-account email as **Editor**. The
password is stored in the sheet in plaintext — share the file only with people
who should have that login, plus the service account.

## Candle columns

Each `{symbol} 2m` / `3m` / `5m` tab uses this schema:

| Column | Meaning |
| --- | --- |
| `candle_time` | Candle open time in IST (no `+05:30` suffix) |
| `delta` | Buy volume − sell volume |
| `max_delta` | Intra-bar cumulative-delta high |
| `max_vol_b` / `max_vol_s` | Max buy / sell volume at a single price |
| `poc` | Point of control |
| `volume` | Footprint candle volume |
| `oi_change` | Change in open interest vs the previous OHLC bar |
| `vwap` | Session VWAP from typical price `(H+L+C)/3` × OHLC volume |

## Run

```bash
cp .env.example .env   # GOOGLE_SHEET_ID + GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
npm ci
npm start              # 24x7
ONCE=1 npm start       # one config read + one sample, then exit
npm test
```

On Windows, do not use `ONCE=1 npm start` in Command Prompt. Double-click
`start.bat` each morning, or `start-once.bat` for the smoke test. Full
client steps are in [`WINDOWS.md`](WINDOWS.md).

Errors go to [`logs/error.log`](logs/README.md) (redacted) and stdout.
[`logs/status.json`](logs/README.md) is a small heartbeat for the VPS.

A systemd unit is in [`deploy/gocharting-scraper.service`](deploy/gocharting-scraper.service).
Clone, Google Sheet setup, first run, and VPS/systemd/Docker deploy are in
[`INSTRUCTIONS.md`](INSTRUCTIONS.md). Handing the project to a client on a
Windows PC that is not on 24×7: [`WINDOWS.md`](WINDOWS.md) (double-click
`start.bat` each morning).

## Protocol notes

The live path does not open a browser. Intervals are requested as `FOOTPRINT/V2`
and `TS/V2` `OHLCV/V2`. Reverse-engineering notes and capture scripts remain
under [`investigation/`](investigation/).
