# Run on a Windows laptop (client handover)

This is the guide for running the GoCharting scraper on **your own Windows
PC**, instead of a 24×7 Linux server.

You start it in the morning, leave it running while the market is open, and
stop it when you shut the laptop down. There is no monthly VPS bill. The
trade-off is that **nothing is collected while the PC is asleep, off, or
disconnected from the internet**.

If you only need the operator/VPS version of this project, use
[`INSTRUCTIONS.md`](INSTRUCTIONS.md) instead.

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [What you will be given](#2-what-you-will-be-given)
3. [How a laptop day differs from a 24×7 server](#3-how-a-laptop-day-differs-from-a-24x7-server)
4. [Prerequisites (one-time)](#4-prerequisites-one-time)
5. [One-time setup](#5-one-time-setup)
6. [First successful run (smoke test)](#6-first-successful-run-smoke-test)
7. [Every trading morning](#7-every-trading-morning)
8. [When you can stop](#8-when-you-can-stop)
9. [Keep the laptop awake](#9-keep-the-laptop-awake)
10. [Changing instruments or the GoCharting login](#10-changing-instruments-or-the-gocharting-login)
11. [How to tell it is working](#11-how-to-tell-it-is-working)
12. [Troubleshooting](#12-troubleshooting)
13. [Optional: start automatically at logon](#13-optional-start-automatically-at-logon)
14. [Security](#14-security)

---

## 1. What you get

The scraper signs in to GoCharting (no browser window), reads the instruments
and candle timeframes on the Google Sheet `config` tab, and writes **closed**
footprint candles back into that same spreadsheet.

| Sheet column | Meaning |
| --- | --- |
| `symbol` | Contract code only (`NIFTY26AUG24050CE`), not `NSE:OPTIONS:…` |
| `candle_time` | Candle open time in IST (no `+05:30` suffix) |
| `open` / `high` / `low` / `close` | Matching OHLC bar, ticks ÷ 100 (`high`/`low` fall back to footprint if the bar is missing) |
| `delta` | Buy volume − sell volume |
| `max_delta` | Intra-bar cumulative-delta high (`0` when missing or negative) |
| `max_vol_b` / `max_vol_s` | Largest buy / sell volume at any single price |
| `poc` | Point of control |
| `volume` | Footprint candle volume |
| `oi_change` | This bar’s open interest minus the previous bar’s |
| `vwap` | Session VWAP from typical price `(H+L+C)/3` × OHLC volume, ticks ÷ 100, 2 decimal places |

The candle that is still forming is **not** written. After a bar ends, the
process waits about 2 seconds, then appends the row. Restarts skip times
already on that tab, so starting twice does not duplicate rows.

Each instrument writes to **static** tabs named from the config slot:
`Instrument1` → `1A`, `1B`, `1C`; `Instrument2` → `2A`, `2B`, `2C`; and so on.
Those names stay the same if you change the symbol or timeframe, so VLOOKUP
formulas keep working. The scraper overwrites the data inside the tab.

---

## 2. What you will be given

You should receive these from the person handing the project over. You do
**not** need to create a Google Cloud project yourself.

| Item | What it is |
| --- | --- |
| Project folder (zip) **or** a git clone of this repo | The scraper code |
| Google Sheet link | The spreadsheet the scraper reads and writes |
| `.env` file | Spreadsheet id/URL plus Google API credentials |
| `google-service-account.json` (if mentioned in `.env`) | Google API key file. Keep it next to `.env` |

The Google Sheet must already be shared with the service-account email as
**Editor**. GoCharting email and password live on the sheet `config` tab, not
in `.env`.

Put `.env` (and the JSON key, if you were given one) in the **project root**
— the same folder that contains `package.json`. Do not commit them, email
them to a group, or put them in a public Drive folder.

---

## 3. How a laptop day differs from a 24×7 server

On a server the process stays up overnight and on weekends. On a laptop it
only runs while the window is open and the PC is awake.

| Situation | What happens |
| --- | --- |
| You start **before** the cash open (~09:15 IST) | The scraper backfills the **previous weekday** once (useful if yesterday was cut short), then waits for today’s open. |
| You start **after** the open | It backfills today’s **already-closed** candles, then continues live. Yesterday is **not** filled in once today’s session has started. |
| Laptop sleeps, hibernates, or you close the lid | Collection stops. The WebSocket dies. You will have a gap until you start it again. |
| You shut down at NSE close (~15:40 IST) | NSE/BSE for the day is complete. **MCX** (for example CRUDEOIL) still trades until **23:30 IST**, or **23:55 IST** while US markets are on daylight saving. Those evening bars are missed unless you leave the PC running. |
| Weekend | You can leave it off. Starting Saturday/Sunday (or Monday before open) backfills Friday. |

**Practical recommendation**

- Weekdays: start by **08:50 IST** (or **08:45 IST** if you track MCX).
- Keep the PC awake until you no longer need that day’s bars.
- For NSE/BSE only, you can stop after **15:42 IST**.
- For MCX energy/bullion-style contracts, leave it running into the evening.

The Windows clock can stay on India time or any other zone. Candle times are
always computed in **Asia/Kolkata**. The PC clock itself must be correct
(Windows automatic time is fine).

---

## 4. Prerequisites (one-time)

### Hardware and network

- A Windows 10 or 11 PC (64-bit).
- Enough disk for Node plus the project (a few hundred MB). RAM use is small
  (~128–256 MB).
- A **stable internet** connection for the whole session. Wi‑Fi is fine;
  avoid sleeping the adapter. Outbound HTTPS and WSS on port 443 must work
  (office networks and some VPNs block this).
- The PC does **not** need a second monitor, Chrome, or any GoCharting
  desktop app.

### Software to install

1. **Node.js 22 LTS** (20 is also fine) from [https://nodejs.org](https://nodejs.org).
   During setup, leave **“Add to PATH”** checked. Close and reopen any
   terminal after installing.
2. Confirm it worked. Open **Command Prompt** or **PowerShell** and run:

   ```bat
   node -v
   npm -v
   ```

   You want `v20.x` or `v22.x`, and an `npm` version printed with no error.

**Git is optional.** If you were given a zip of the project, you do not need
Git. If you were asked to clone the repository, install
[Git for Windows](https://git-scm.com/download/win) and use the defaults.

You do **not** need Python, Docker, PlayWright, or Google Chrome for the
live scraper.

---

## 5. One-time setup

### 5.1 Place the project on disk

Unzip (or clone) to a simple path with no odd permissions, for example:

```text
C:\Users\<you>\go-charting-scraper\
```

Avoid OneDrive “Files On-Demand” only-online placeholders if you can. A
normal local folder is more reliable.

If you clone:

```bat
git clone https://github.com/anurag-roy/go-charting-scraper.git
cd go-charting-scraper
```

### 5.2 Drop in the secrets you were given

In that folder you should have:

```text
go-charting-scraper\
  package.json
  src\
  .env                          ← provided; do not share
  google-service-account.json   ← only if your .env points at this file
  start.bat                     ← double-click this each morning
```

If you only received `.env.example`, copy it to `.env` and paste the values
you were sent:

```bat
copy .env.example .env
notepad .env
```

Minimum `.env` (spreadsheet URL is also accepted):

```env
GOOGLE_SHEET_ID=https://docs.google.com/spreadsheets/d/<id>/edit
GOOGLE_SERVICE_ACCOUNT_JSON=./google-service-account.json
```

The JSON-file form is the easiest on Windows. If you were given
`GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` instead, paste them exactly
as sent. Save `.env` as **UTF-8** (Notepad: *Save as* → Encoding **UTF-8**).
A UTF-16 save from Notepad will break startup.

### 5.3 Confirm the Google Sheet `config` tab

Open the spreadsheet you were given. There must be a tab named exactly
**`config`**, with labels in column A, the login / instrument id in column B,
and candle timeframes in columns C onward:

| A | B (example) | C | D | E |
| --- | --- | --- | --- | --- |
| email | Your GoCharting login email | | | |
| password | Your GoCharting password | | | |
| Instrument1 | `NSE:FUTURE:NIFTY-I` | `2m` | `3m` | `5m` |
| Instrument2 | `MCX:FUTURE:CRUDEOIL-I` | `5m` | `10m` | |
| Instrument3 | `NSE:OPTIONS:NIFTY2681824300CE` | `2m` | `3m` | `5m` |

Blank instrument rows are ignored. You can run one, two, or six symbols.
Instrument strings look like `EXCHANGE:CATEGORY:SYMBOL` (`NSE`, `BSE`, or
`MCX`). Slashes (`NSE/FUTURE/NIFTY-I`) also work. Timeframes are minute bars
such as `2m` or `10m`. If a row has a symbol but no timeframes, that
instrument is skipped — there is no default list.

The password is **plaintext on the sheet**. Share the file only with people
who should have that GoCharting login.

### 5.4 Install Node packages

In Command Prompt or PowerShell, from the project folder:

```bat
cd C:\Users\<you>\go-charting-scraper
npm ci
```

This only needs to succeed **once** (and again if the project is updated).
`start.bat` will also run `npm ci` automatically if `node_modules` is
missing.

Windows Defender or another antivirus may prompt on the first `npm` run.
Allow it for this folder.

---

## 6. First successful run (smoke test)

Do this once, any time you have internet. It reads `config`, logs in,
creates any missing `1A` / `1B` / `1C` tabs, writes already-closed candles
for the current (or last weekday) session, then **exits**.

Double-click **`start-once.bat`**, or in a terminal:

```bat
cd C:\Users\<you>\go-charting-scraper
set ONCE=1
npm start
```

In **PowerShell** the `set` line is different:

```powershell
cd C:\Users\<you>\go-charting-scraper
$env:ONCE = "1"
npm start
```

Success looks like:

```text
INFO go-charting-scraper { once: true, sheet: '…' }
INFO config applied { email: '…', passwordSet: true, instruments: [ '…' ] }
INFO start monitoring NSE:FUTURE:NIFTY-I
INFO connecting websocket not open
INFO sample 1 NSE:FUTURE:NIFTY-I/backfill, …
INFO   NSE:FUTURE:NIFTY-I 2m: closed=193/193
INFO wrote … new closed-candle row(s)
INFO shutting down
```

Then open the Google Sheet and confirm the new tabs have rows. A second
smoke test should print `wrote 0 new closed-candle row(s)` (duplicates are
skipped).

If it exits immediately with `set GOOGLE_SHEET_ID` or `Google credentials
are missing`, the `.env` file is not in the project root or the values were
not pasted. See [§12](#12-troubleshooting).

---

## 7. Every trading morning

1. Turn the PC on and connect to the internet.
2. Disable sleep for this session ([§9](#9-keep-the-laptop-awake)).
3. Double-click **`start.bat`** in the project folder
   (`C:\Users\<you>\go-charting-scraper\start.bat`).
4. **Leave that black window open.** Closing it stops the scraper. You can
   minimise it.
5. Work as usual. The sheet updates every ~15 seconds while the market is
   open.

To start from a terminal instead of the `.bat` file:

```bat
cd C:\Users\<you>\go-charting-scraper
npm start
```

You should see `starting 24x7 scraper` and then either a backfill sample or
`connecting websocket` once the session is live.

Do **not** use `start-once.bat` / `ONCE=1` for the trading day. That mode
exits after one sample.

---

## 8. When you can stop

When you are done collecting for the day:

1. Click the scraper window.
2. Press **Ctrl+C** once. Wait for `received SIGINT` / `shutting down`.
3. You can then close the window and shut the PC down.

If you just close the window with the X, Windows kills the process. That is
usually fine; the next start will skip candle times already on the sheet.

You do **not** have to stop it at 15:40. If you leave it running, it will
idle after the session (and keep MCX going until that close). Overnight
idling is harmless but pointless if you are about to power off.

---

## 9. Keep the laptop awake

Sleep, hibernate, and “close lid = sleep” will pause or kill collection.

Suggested settings while it is running (**Windows 11** names; Windows 10 is
the same idea under *Power & sleep*):

1. **Settings → System → Power**.
2. When plugged in: **Screen** can turn off; **Sleep** should be **Never**
   for the hours you are collecting.
3. **Settings → System → Power → Lid, power & sleep buttons** (wording
   varies): when plugged in, **closing the lid** → **Do nothing** if you
   might shut the lid.
4. Plug in the charger. A battery saver plan that sleeps at 20% will leave
   a hole in the sheet.

Optional, for one session only, from an **Administrator** Command Prompt:

```bat
powercfg /change standby-timeout-ac 0
```

Set it back to your usual minutes when you are done (for example `30`).

---

## 10. Changing instruments or the GoCharting login

Edit the `config` tab on the Google Sheet. You do **not** restart the
scraper.

- Change `Instrument1` / `Instrument2` / `Instrument3` (symbol or timeframes)
  → within about 5 seconds the process switches symbols / intervals,
  **overwrites the data** in that slot’s static tabs (`1A`, `1B`, `1C` for
  Instrument1, and so on), and backfills today. Tab names do not change, and
  sheets are never deleted.
- Change email/password → the new login is tried first. A bad password is
  logged; the previous working session is kept.

`.env` only holds Google credentials. You should not need to edit it after
the handover unless the spreadsheet or service account is replaced.

---

## 11. How to tell it is working

| Check | Healthy sign |
| --- | --- |
| Scraper window | New `INFO sample N …` lines about every 15 seconds during market hours |
| Google Sheet | New rows on `1A` / `1B` / `1C` (and `2A` …) after each bar closes |
| `logs\status.json` | `"ws": "open"` during the session; `instruments` matches `config` |
| `logs\error.log` | Empty, or only old errors you already fixed |

Email, password, and tokens are redacted in logs. The GoCharting **email**
can still appear in `status.json`.

---

## 12. Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| `node` is not recognized | Node.js not installed, or terminal opened before install | Reinstall Node 22 LTS with PATH checked. Close all terminals and try again. |
| `set GOOGLE_SHEET_ID` (process exits) | `.env` missing or not in the project folder | Place `.env` next to `package.json`. Use the full sheet URL or the id from the URL. |
| `Google credentials are missing` / file not found | JSON path wrong, or PEM not pasted | Put `google-service-account.json` in the project folder, or fix `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`. |
| `config sheet is missing email, password, or instruments with candle timeframes` | Tab name or cells | Tab must be `config`. Labels in A, symbol in B, timeframes in C onward. |
| `cognito auth failed` / `NotAuthorizedException` | Wrong GoCharting password on the sheet | Fix the `config` email/password. There is no login window. |
| `ws unexpected HTTP 401` / connect timeout | JWT rejected, or office network blocking WSS | Confirm internet. Try without VPN. Allow outbound `origin.ws.prodb.blr1.gocharting.com`. |
| Window was working, then it froze and the sheet stopped | PC slept or Wi‑Fi dropped | Follow [§9](#9-keep-the-laptop-awake). Start `start.bat` again; duplicates are skipped. |
| `closed=0` / no new rows | Holiday, before the first bar, or a bad symbol | Confirm the instrument string in GoCharting. Empty on a market holiday is normal. |
| Started at 10:00 IST, yesterday’s bars missing | Expected | After today’s open, only **today** is filled. Start **before 09:00 IST** the next morning to pick up a missed weekday. |
| `npm run once` does nothing useful in Command Prompt | `ONCE=1` in `package.json` is a Unix-style env assignment | Use `start-once.bat` or `set ONCE=1` then `npm start` ([§6](#6-first-successful-run-smoke-test)). |

Never paste `logs\error.log` or `status.json` into a public chat without
checking. Redaction is best-effort.

---

## 13. Optional: start automatically at logon

If you want the scraper to start when you log into Windows (you still must
turn the PC on):

1. Press **Win+R**, type `shell:startup`, press Enter.
2. Create a shortcut to `C:\Users\<you>\go-charting-scraper\start.bat` in
   that folder.

You still need the PC awake and online. This only saves the double-click.

Task Scheduler (“At log on” → start `start.bat`) works the same way. Do not
schedule a task that exits (`ONCE=1`) for the trading day.

---

## 14. Security

- Treat `.env`, `google-service-account.json`, and the sheet password as
  secrets. Do not commit them or put them in shared screenshots.
- This uses **your** GoCharting account against their login and market-data
  socket. Confirm their terms of use allow it.
- When you are done with the PC for good, change the GoCharting password
  and restrict who can edit the spreadsheet.

---

## Minimal daily checklist

**Once on this PC:** install Node.js 22 → copy project + `.env` → `npm ci`
→ run `start-once.bat` and confirm the sheet.

**Each weekday:**

1. Power on, internet on, sleep off.
2. Double-click `start.bat` by **08:50 IST**.
3. Leave the window open.
4. After the session you care about, Ctrl+C and shut down.
