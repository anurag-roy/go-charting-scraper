# Protobuf schemas

These are the public GoCharting schemas used to decode market-data WebSocket
frames (`gocharting.com/assets/proto/1.1/…`). The live scraper loads them at
startup from this directory (`PROTO_DIR` overrides the path).

| File | Type | WS command |
| --- | --- | --- |
| `footprint.proto` | `fpgc.FootPrintForDateResponse` | `FOOTPRINT/V2` |
| `ohlc_bars.proto` | `protobars.OHLCBarResult` | `TS/V2` `OHLCV/V2` |

Login is AWS Cognito `USER_PASSWORD_AUTH` (HTTPS only, no browser). The
id token is passed as `?token=` on

`wss://origin.ws.prodb.<dc>.gocharting.com/<dc>/ws`.

Binary frames: byte `0x6d` (`m`) is `uint32be` header length + UTF-8 header
`COMMAND~cursor~request_id~…` + protobuf body. Any other first byte is a
pako/deflate blob that inflates into an `m` frame.

**Max Vol B / Max Vol S** are `FootPrintCandle.max.buy.volume` /
`max.sell.volume` — the largest buy / sell volume at any single price level
in that candle. The client does not re-aggregate them.
