// Decode captured binary WS frames using the site's own footprint.proto,
// replicating the client's _parseMessage framing:
//   byte0 == 'm'(109): [1..5)=uint32 BE header length; [5..5+len)=UTF-8 header
//     ("CMD~cursor~request_id~..."); rest = protobuf body.
//   otherwise: pako-inflate the frame, then parse the same way.
import fs from 'node:fs';
import path from 'node:path';
import protobuf from 'protobufjs';
import * as pako from 'pako';

const FRAMES = '/workspace/investigation/out/frames';
const root = await protobuf.load('/workspace/investigation/out/proto/footprint.proto');
const FP = root.lookupType('fpgc.FootPrintForDateResponse');

const num = (v) => (v && typeof v === 'object' && 'toNumber' in v ? v.toNumber() : Number(v || 0));

function parseFrame(buf) {
  let data = buf;
  if (buf[0] !== 109) { // not 'm' -> try inflate
    try { data = Buffer.from(pako.inflate(buf)); } catch { return null; }
  }
  if (data[0] !== 109) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hlen = dv.getUint32(1, false);
  const header = Buffer.from(data.buffer, data.byteOffset + 5, hlen).toString('utf8');
  const body = Buffer.from(data.buffer, data.byteOffset + 5 + hlen);
  return { cmd: header.split('~')[0], header, body };
}

const files = fs.readdirSync(FRAMES).filter((f) => f.endsWith('.bin')).sort();

console.log('=== all frames (command by header) ===');
for (const f of files) {
  const fr = parseFrame(fs.readFileSync(path.join(FRAMES, f)));
  console.log(`  ${f}: ${fr ? fr.header.split('~').slice(0, 3).join('~') : '(unparsed)'}`);
}

let decoded = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(FRAMES, f));
  const fr = parseFrame(buf);
  if (!fr || fr.cmd !== 'FOOTPRINT/V2') continue;
  let msg;
  try { msg = FP.decode(fr.body); } catch (e) { console.log(f, 'decode err', e.message); continue; }
  const obj = FP.toObject(msg, { longs: Number, defaults: false });
  const req = obj.request || {};
  const candles = obj.candles || [];
  if (!candles.length) continue;
  decoded++;
  console.log(`\n#### ${f}  ${fr.header.slice(0, 60)}`);
  console.log(`symbol=${req.exchange}:${req.segment}:${req.symbol} interval=${req.interval} date=${req.date} candles=${candles.length} is_complete=${obj.is_complete}`);
  // Examine the last candle in detail.
  const c = candles[candles.length - 1];
  const levels = c.footprint || [];
  const maxBuyOverLevels = Math.max(0, ...levels.map((l) => num(l.buy?.volume)));
  const maxSellOverLevels = Math.max(0, ...levels.map((l) => num(l.sell?.volume)));
  console.log(`  candle.date=${c.date}  price_levels=${levels.length}`);
  console.log(`  totals.buy.volume =${num(c.totals?.buy?.volume)}   totals.sell.volume =${num(c.totals?.sell?.volume)}`);
  console.log(`  server max.buy.volume =${num(c.max?.buy?.volume)}   server max.sell.volume =${num(c.max?.sell?.volume)}   <-- "Max Vol B" / "Max Vol S"`);
  console.log(`  recomputed max(level.buy.volume) =${maxBuyOverLevels}   max(level.sell.volume) =${maxSellOverLevels}`);
  console.log(`  MATCH B=${num(c.max?.buy?.volume) === maxBuyOverLevels}  MATCH S=${num(c.max?.sell?.volume) === maxSellOverLevels}`);
  // show a few price levels
  console.log('  sample levels (level: buyVol / sellVol):');
  for (const l of levels.slice(0, 6)) {
    console.log(`    ${num(l.level)}: B=${num(l.buy?.volume)} (t=${num(l.buy?.trades)})  S=${num(l.sell?.volume)} (t=${num(l.sell?.trades)})`);
  }
  if (decoded >= 3) break;
}
console.log(`\nDecoded ${decoded} FOOTPRINT/V2 responses.`);
