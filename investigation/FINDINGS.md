# GoCharting "Max Vol B" / "Max Vol S" — data-source & calculation analysis

Target: `https://gocharting.com/terminal/chart/kd5OXEIXs` (a saved 3×3 layout of
`MCX:FUTURE:CRUDEOIL-I` footprint/order-flow charts).

## TL;DR

- **"Max Vol B" = the largest BUY volume traded at any single price level within a
  footprint candle. "Max Vol S" = the largest SELL volume at any single price level
  within that candle.** ("B"/"S" = Buy/Sell; internal metric ids `maxBuy_volume` /
  `maxSell_volume`, catalog labels "Max Buy Vol" / "Max Sell Vol".)
- These numbers are **computed on the server and pushed to the browser** inside a
  **binary Protobuf** message over a **WebSocket** — they are *not* computed in the
  browser and *not* served from any REST/JSON endpoint.
- Transport: `wss://origin.ws.prodb.<dc>.gocharting.com/<dc>/ws?token=<JWT>&tag=<id>`
  (`dc` is `blr1` for MCX crude; the worker template is
  `wss://origin.ws.prodb.{{__DC__}}.gocharting.com/{{dc}}/ws`). Command
  `FOOTPRINT/V2`. Each candle in the response carries a `max` field whose
  `buy.volume` / `sell.volume` are exactly these two values.
- Verified by decoding real captured frames: the server's `max.buy.volume` /
  `max.sell.volume` **exactly equal** the max over the candle's per-level
  `footprint[].buy.volume` / `footprint[].sell.volume` (see
  `evidence/footprint-decode-proof.txt`).

## Where the data comes from (transport map)

Login is AWS Cognito `USER_PASSWORD_AUTH` against the public web client the
site ships in its Amplify config (`region: ap-south-1`, user pool
`ap-south-1_uuM8MRslb`, client id `3fqhvm22ea8pjsr2spbnv484pr`). A `POST` to
`https://cognito-idp.ap-south-1.amazonaws.com/` with `X-Amz-Target:
AWSCognitoIdentityProviderService.InitiateAuth` returns an **id token**. That
JWT is passed as the `?token=` query param (plus a `tag=` device id) when
opening the market-data WebSocket. **No browser is required** for this — the
live scraper (`poc-log-maxvol.js`) does the same Cognito call the website
does.

| Concern | Channel | Notes |
| --- | --- | --- |
| Auth | REST → AWS Cognito `USER_PASSWORD_AUTH` | Returns JWT used to authorize the WS. |
| Saved chart layout | `GET gocharting.com/api/chart` | Contains the footprint metric toggles for this chart (`maxBuy_volume:true`, `maxSell_volume:true`). |
| Symbol metadata | `gocharting.com/api/instruments/*` | Tick size, precision, etc. |
| Protobuf schemas | `gocharting.com/assets/proto/1.1/footprint.proto`, `.../ohlc_bars.proto` | Public; used by the client to decode binary frames. |
| **All market data** | **WebSocket** `wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws` | OHLCV, footprint, live trades, DOM, option chain, studies. Binary Protobuf frames; some are deflate-compressed. |

No REST/JSON endpoint returns footprint volumes. The footprint data (including
`max`) arrives only over the WebSocket.

## WebSocket protocol

The client (running inside a dedicated Web Worker, `trades.worker.*.min.js`) sends
JSON command frames, e.g.:

```json
{"command":"FOOTPRINT/V2","request_id":5,"payload":{"exchange":"MCX","segment":"FUTURE","symbol":"CRUDEOIL-I","interval":"5m","dates":["2026-08-13"],"session":"RTH"}}
{"command":"SUBSCRIBE","channel":"trade","payload":["MCX:FUTURE:CRUDEOIL-I"]}
{"request_id":1,"command":"TS/V2","action":"add","payload":{"msg_type":"OHLCV/V2","symbol":"MCX:FUTURE:CRUDEOIL-I","interval":"5m","session":"RTH"}}
```

Large historical footprint payloads are handed back by reference: the client later
re-requests them via `{"command":"FOOTPRINT/V2","payload":{"ref":"<uuid>"}}`.

### Binary frame framing (from the client's `_parseMessage`)

Each binary frame:

- `byte[0]` = kind. `0x6d` (`'m'`) = "text header + protobuf body". Any other kind
  is a **pako/zlib deflate** blob that inflates into an `'m'` frame.
- For `'m'` frames: `bytes[1..5)` = big-endian `uint32` header length `L`;
  `bytes[5..5+L)` = a UTF‑8 header string `"<COMMAND>~<next_cursor>~<request_id>~…"`;
  the remaining bytes are the Protobuf body.
- Dispatch by command:
  - `FOOTPRINT/V2` → decode body as `fpgc.FootPrintForDateResponse`
  - `TS/V2` → decode body as `protobars.OHLCBarResult` (OHLCV bars). Each
    `IntradayOHLCBars` group has a `start` timestamp; each `Candle.offset` is
    **minutes** after that start (`offset_in = "m"`). Bar time =
    `start + offset minutes`, which matches `FootPrintCandle.date`.

Decoded footprint responses are cached in the browser's IndexedDB
(`BinaryFootprint` store) keyed by `exchange:segment:symbol:interval:date:session`.

## The footprint Protobuf schema (`fpgc`, abridged)

From `gocharting.com/assets/proto/1.1/footprint.proto` (full copy in
`evidence/footprint.proto`):

```proto
message FootPrintForDateResponse {
  FootPrintForDateRequest request = 1;
  repeated FootPrintCandle candles = 2;
  ...
}

message FootPrintCandle {
  string date = 1;
  EndingSummary ending_summary = 2;
  Levels totals = 3;   // sum across the candle
  Levels max    = 4;   // <-- per-candle maxima  (source of Max Vol B / Max Vol S)
  Levels min    = 5;
  repeated Footprint footprint = 6;  // one entry per price level
}

message Footprint { int64 level = 1; Cluster buy = 2; Cluster sell = 3; }
message Levels    { Cluster overall = 1; Cluster buy = 2; Cluster sell = 3; }
message Cluster   { int64 trades = 1; int64 volume = 2; }

message Trade { ... int64 ltp = 5; int64 size = 6; sint32 side = 7; /* 1=buy, -1=sell */ ... }
```

## How "Max Vol B" / "Max Vol S" are calculated

1. Every trade in the feed is tagged with a **side** (`Trade.side`: `1 = buy`,
   `-1 = sell`) — i.e. aggressor side (buy = executed at the ask, sell = at the bid).
2. The server buckets trades of each candle by price level, summing size into a
   `Footprint{ level, buy{trades,volume}, sell{trades,volume} }` per level.
3. For each candle it also emits `totals`, `max`, and `min` `Levels` objects.
   - **`max.buy.volume`** = `max` over price levels of `footprint[i].buy.volume`
     → displayed as **"Max Vol B"**.
   - **`max.sell.volume`** = `max` over price levels of `footprint[i].sell.volume`
     → displayed as **"Max Vol S"**.
4. The browser decodes the Protobuf and, because this chart's saved layout has
   `maxBuy_volume:true` and `maxSell_volume:true`, renders those two values as the
   "Max Vol B" / "Max Vol S" rows in the footprint summary column. The client does
   **no** aggregation of its own for these values — it reads them straight from the
   `max` field.

Pseudo-code equivalent of the server value:

```
MaxVolB(candle) = max(level.buy.volume  for level in candle.footprint)
MaxVolS(candle) = max(level.sell.volume for level in candle.footprint)
```

### Proof from real decoded frames

Decoding captured `FOOTPRINT/V2` frames with the site's own `footprint.proto`
(`node decode-frames.js`), e.g. `MCX:FUTURE:CRUDEOIL-I` 15m, candle
`2026-08-12T23:15:00+05:30`, 26 price levels:

```
totals.buy.volume = 561    totals.sell.volume = 395
server max.buy.volume = 189   server max.sell.volume = 63     <-- Max Vol B / Max Vol S
recomputed max(level.buy.volume) = 189   max(level.sell.volume) = 63
MATCH B = true   MATCH S = true
```

The server-sent `max.buy.volume` / `max.sell.volume` match the independently
recomputed per-level maxima for every decoded candle. Full log:
`evidence/footprint-decode-proof.txt`.

## Reproduce

Prereqs: Node 22, Google Chrome, `xvfb`. Secrets `GOCHARTING_EMAIL` /
`GOCHARTING_PASSWORD` in the environment.

```bash
cd investigation
npm install
# 1) Log in + capture all network (requests/responses/WS/console) — raw output in out/ (gitignored)
PW_CHANNEL=chrome xvfb-run -a node investigate.js
# 2) Capture full binary WS frames, then decode + verify Max Vol B/S
PW_CHANNEL=chrome xvfb-run -a node capture-frames.js
node decode-frames.js
```

Scripts:

- `investigate.js` — logs in and records every request, response body, WebSocket
  frame, worker and console message. Credentials are read from env only and
  redacted from disk output.
- `capture-frames.js` — saves complete (untruncated) binary WS frames.
- `decode-frames.js` — reproduces the client framing and decodes `FOOTPRINT/V2`
  bodies with `footprint.proto`, verifying `max.buy/sell.volume`.
- `analyze-ws.js`, `extract.js` — helpers for summarizing frames / grepping bundles.
- `poc-log-maxvol.js` — live sampler: Cognito HTTPS login (no browser), then
  request `5m` / `10m` / `15m` `FOOTPRINT/V2` and `TS/V2` `OHLCV/V2` every 30s
  and append OHLC + Max Vol B/S of the latest candle to
  `evidence/maxvol-poc.csv`.

Full clone-to-deploy steps: [`INSTRUCTIONS.md`](../INSTRUCTIONS.md).

## Live POC result (2026-08-13)

Ran `poc-log-maxvol.js` against `MCX:FUTURE:CRUDEOIL-I` for 5 minutes
(11 samples × 3 intervals = 33 rows). Every row decoded, and server
`max.buy.volume` / `max.sell.volume` matched the recomputed per-level max.

CSV: [`evidence/maxvol-poc.csv`](evidence/maxvol-poc.csv). Snapshot of live
updates around the 20:45 IST 5m/15m candle rollover:

| sample (IST) | 5m MaxVol B/S (candle) | 10m MaxVol B/S (candle) | 15m MaxVol B/S (candle) |
| --- | --- | --- | --- |
| 20:44:45 | 74 / 61 (20:40) | 74 / 61 (20:40) | 85 / 177 (20:30) |
| 20:45:15 | 25 / 10 (20:45) | 74 / 61 (20:40) | 25 / 10 (20:45) |
| 20:46:15 | 169 / 13 (20:45) | 169 / 61 (20:40) | 169 / 13 (20:45) |

The forming 5m/15m candles reset at 20:45; the 10m candle (20:40–20:50) kept
accumulating. Totals and price-level counts also increased between samples.

## Notes & caveats

- No profile settings were changed and no terminal buttons were clicked beyond the
  required login (and dismissing the promo popup).
- Raw captures under `investigation/out/` are **git-ignored** because they contain
  the session JWT, cookies and account info. Only the public `footprint.proto` and a
  numbers-only decode log are committed as evidence.
- `side` is provided by the feed, so buy/sell (bid/ask) classification is upstream of
  the browser; the client never re-derives it.
