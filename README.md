# go-charting-scraper

24×7 service that reads GoCharting credentials, instruments, and candle
timeframes from a Google Sheet, scrapes **closed** footprint candles, and
writes them back into that same spreadsheet. The process is meant to run
unattended on a VPS.

Handing this to a client on a **Windows laptop** that is powered on each
morning (not left on 24×7): [`WINDOWS.md`](WINDOWS.md).

GoCharting login is AWS Cognito over HTTPS (no browser). Market data is the
WebSocket + Protobuf protocol; schemas live in [`src/proto/`](src/proto/).

## What it does

1. Polls the `config` tab every 5 seconds (12 Google reads/minute; the Sheets
   API allowance is 60 reads/minute/user).
2. Authenticates with the email/password from that tab and keeps the JWT in
   process memory only (refresh before expiry; never written to disk).
3. Tracks up to six instruments (`Instrument1`–`Instrument6`) in
   `EXCHANGE:CATEGORY:SYMBOL` form (`NSE`, `BSE`, or `MCX`). Candle timeframes
   are read from that row’s cells to the right of the symbol (columns C, D, E,
   …). There is no default list: if a row has a symbol but no timeframes, that
   instrument is skipped. If only `5m` and `10m` are listed, only those bars
   are requested.
4. Writes **closed** candles to **static** tabs named from the config slot and
   timeframe letter: `Instrument1` → `1A`, `1B`, `1C`, `Instrument2` → `2A`,
   `2B`, `2C`, and so on (column C → A, D → B, E → C). Forming bars are never
   written. Each tab keeps **only the current IST day’s rows**; previous-day
   candles are deleted in the morning.
5. If you change a slot’s symbol or timeframes during the session, those same
   tabs are **overwritten** (the sheet names never change, and sheets are never
   deleted). The new symbol/timeframe is backfilled for **today’s** session
   only.
6. Stays running overnight and on weekends. NSE/BSE are sampled 09:15–15:40
   IST; MCX energy-style contracts 09:00–23:30 IST (23:55 while US Eastern is
   on daylight saving). Outside those windows the websocket is closed.

## Config sheet

Create a tab named `config` with labels in column A, the login / instrument
id in column B, and candle timeframes in columns C onward:

| A | B | C | D | E |
| --- | --- | --- | --- | --- |
| email | GoCharting login | | | |
| password | GoCharting password | | | |
| Instrument1 | `NSE:FUTURE:NIFTY-I` | `2m` | `3m` | `5m` |
| Instrument2 | `MCX:FUTURE:CRUDEOIL-I` | `5m` | `10m` | |
| Instrument3 | `NSE:OPTIONS:NIFTY2681824300CE` | `2m` | `3m` | `5m` |
| Instrument4 | *(optional)* | | | |
| Instrument5 | *(optional)* | | | |
| Instrument6 | *(optional)* | | | |

Share the spreadsheet with the service-account email as **Editor**. The
password is stored in the sheet in plaintext — share the file only with people
who should have that login, plus the service account.

## Candle columns

Each static tab (`1A`, `1B`, `1C`, …) uses this schema:

| Column | Meaning |
| --- | --- |
| `symbol` | Contract code only (`NIFTY26AUG24050CE`), not `NSE:OPTIONS:…` |
| `candle_time` | Candle open time in IST (no `+05:30` suffix) |
| `open` / `high` / `low` / `close` | Matching OHLC bar, ticks ÷ 100 (`high`/`low` fall back to footprint if the bar is missing). If a candle was stored without open/close, a later sample fills those cells (and `oi_change` / `vwap`) in place. |
| `delta` | Buy volume − sell volume |
| `max_delta` | Intra-bar cumulative-delta high (`0` when missing or negative) |
| `max_vol_b` / `max_vol_s` | Max buy / sell volume at a single price |
| `poc` | Point of control |
| `volume` | Footprint candle volume |
| `oi_change` | Change in open interest vs the previous OHLC bar |
| `vwap` | Session VWAP from typical price `(H+L+C)/3` × OHLC volume, ticks ÷ 100, 2 decimal places |

## Run

```bash
cp .env.example .env   # GOOGLE_SHEET_ID + GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY
npm ci
npm start              # 24x7
ONCE=1 npm start       # one config read + one sample, then exit
npm test
npm run pack           # dist/go-charting-scraper-<version>.zip (no git / tests)
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
and `TS/V2` `OHLCV/V2`. Decoder schemas are [`src/proto/footprint.proto`](src/proto/footprint.proto)
and [`src/proto/ohlc_bars.proto`](src/proto/ohlc_bars.proto).

## Shareable zip

`npm run pack` bundles the `npm start` graph (no tests) with esbuild into one
`index.js`, then zips it with `package.json`, `package-lock.json`, `start.bat`,
`start-once.bat`, `.env.example`, the proto files, and — if they exist on this
machine — `.env` and `google-service-account.json`. Recipients unzip, run
`npm ci --omit=dev` (or double-click `start.bat`), and do not need git or the
source tree. That zip includes secrets when those files were present, so treat
it like `.env`.
