# go-charting-scraper

Reverse-engineering how [gocharting.com](https://gocharting.com) sources and
computes its footprint/order-flow data — specifically the **"Max Vol B"** and
**"Max Vol S"** values shown on the terminal.

- Full write-up: [`investigation/FINDINGS.md`](investigation/FINDINGS.md)
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
