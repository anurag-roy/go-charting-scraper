# go-charting-scraper

Reverse-engineering how [gocharting.com](https://gocharting.com) sources and
computes its footprint/order-flow data — specifically the **"Max Vol B"** and
**"Max Vol S"** values shown on the terminal.

**To clone, install, and start scraping:** see
[`INSTRUCTIONS.md`](INSTRUCTIONS.md) (prerequisites, headless Linux, env vars,
CSV schema, systemd/cron, Docker, troubleshooting).

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

## Live proof-of-concept (CSV sampler)

`investigation/poc-log-maxvol.js` logs in to the saved chart, opens the
market-data WebSocket, and writes **Max Vol B / Max Vol S** for the latest
`5m`, `10m`, and `15m` footprint candles to CSV every 30 seconds (default 5
minute run). It does not click chart/timeframe buttons — those intervals are
requested as `FOOTPRINT/V2` commands.

```bash
cd investigation
npm install
# Headless (works on a Linux server with no display / no Xvfb):
HEADLESS=1 node poc-log-maxvol.js
# Or headed Chrome under Xvfb:
PW_CHANNEL=chrome xvfb-run -a node poc-log-maxvol.js
# CSV -> investigation/evidence/maxvol-poc.csv
```

A 5-minute live run is committed at
[`investigation/evidence/maxvol-poc.csv`](investigation/evidence/maxvol-poc.csv)
(11 samples × 5m/10m/15m, all `values_match=true`).
