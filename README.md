# go-charting-scraper

Reverse-engineering how [gocharting.com](https://gocharting.com) sources and
computes its footprint/order-flow data — specifically the **"Max Vol B"** and
**"Max Vol S"** values shown on the terminal.

**To clone, install, and start scraping:** see
[`INSTRUCTIONS.md`](INSTRUCTIONS.md) (prerequisites, headless Linux, env vars,
Google Sheets, CSV schema, systemd/cron, Docker, troubleshooting).

- Protocol write-up: [`investigation/FINDINGS.md`](investigation/FINDINGS.md)
- Capture & decode tooling: [`investigation/`](investigation/)

## Short answer

The market data is delivered over a WebSocket
(`wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws`) as binary Protobuf, not via
any REST/JSON endpoint. Each footprint candle (`fpgc.FootPrintForDateResponse` →
`FootPrintCandle`) includes a server-computed `max` field:

- **Max Vol B** = `candle.max.buy.volume` = the largest buy volume at any single
  price level in the candle.
- **Max Vol S** = `candle.max.sell.volume` = the largest sell volume at any single
  price level in the candle.

This was confirmed by decoding real captured frames with the site's own
`footprint.proto`; the server values match the recomputed per-level maxima exactly.
See [`investigation/FINDINGS.md`](investigation/FINDINGS.md) for the protocol,
schema, and proof.

## Live scraper (closed NSE candles)

`investigation/poc-log-maxvol.js` logs in, opens the market-data WebSocket, and
persists **OHLC** plus **Max Vol B / Max Vol S** for every **closed** `2m`, `3m`,
and `5m` candle of `NSE:FUTURE:NIFTY-I` during the **09:15–15:30 IST** session.
Forming (in-progress) bars are not written. It does not click chart/timeframe
buttons — intervals are requested as `FOOTPRINT/V2` and `TS/V2` `OHLCV/V2`.

Output is configured in `.env` (see [`.env.example`](.env.example)):

- `GOOGLE_SHEET_ID` — append to a Google spreadsheet (tabs `2m` / `3m` / `5m`)
- `WRITE_CSV=1` — append the same rows to a local CSV

```bash
cp .env.example .env   # fill in credentials + sheet id and/or WRITE_CSV=1
cd investigation
npm install
HEADLESS=1 RUN_MS=0 node poc-log-maxvol.js   # one-shot backfill of closed bars
```

An example scrape with OHLC (older crude-oil POC) is committed at
[`investigation/evidence/maxvol-poc.csv`](investigation/evidence/maxvol-poc.csv).
