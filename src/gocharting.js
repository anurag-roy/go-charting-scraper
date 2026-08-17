import WebSocket from 'ws';
import * as pako from 'pako';
import protobuf from 'protobufjs';
import path from 'node:path';
import { symbolId } from './instruments.js';
import { formatIst } from './session.js';
import { num } from './util.js';

export async function loadProtos(protoDir) {
  const root = await protobuf.load(path.join(protoDir, 'footprint.proto'));
  const ohlcRoot = await protobuf.load(path.join(protoDir, 'ohlc_bars.proto'));
  return {
    FP: root.lookupType('fpgc.FootPrintForDateResponse'),
    OHLC: ohlcRoot.lookupType('protobars.OHLCBarResult'),
  };
}

export function addMinutesIst(startIso, offsetMin) {
  const t = new Date(startIso);
  if (Number.isNaN(t.getTime())) return '';
  t.setTime(t.getTime() + Number(offsetMin || 0) * 60_000);
  return formatIst(t);
}

export function flattenOhlc(obj) {
  const map = obj?.intradayCandles || obj?.intraday_candles || {};
  const out = [];
  for (const [sessionDate, group] of Object.entries(map)) {
    const start = group.start || '';
    for (const c of group.candles || []) {
      const offset = num(c.offset);
      out.push({
        session_date: sessionDate,
        offset,
        time: addMinutesIst(start, offset),
        open: num(c.open),
        high: num(c.high),
        low: num(c.low),
        close: num(c.close),
        volume: num(c.volume),
        oi: num(c.oi),
      });
    }
  }
  return out;
}

export function parseFrame(buf) {
  if (!buf || buf.length < 6) return null;
  let data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (data[0] !== 0x6d) {
    try { data = Buffer.from(pako.inflate(data)); } catch { return null; }
  }
  if (data[0] !== 0x6d || data.length < 6) return null;
  const hlen = data.readUInt32BE(1);
  if (!Number.isFinite(hlen) || hlen < 0 || 5 + hlen > data.length) return null;
  const header = data.subarray(5, 5 + hlen).toString('utf8');
  const body = data.subarray(5 + hlen);
  const parts = header.split('~');
  return {
    cmd: parts[0] || '',
    cursor: parts[1] || '',
    requestId: parts[2] || '',
    header,
    body,
  };
}

export function dedupeOhlcBars(bars) {
  const map = new Map();
  for (const b of bars || []) {
    if (b?.time) map.set(b.time, b);
  }
  return [...map.values()];
}

export function findOhlcBar(bars, candleTime) {
  if (!bars?.length || !candleTime) return null;
  const exact = bars.find((b) => b.time === candleTime);
  if (exact) return exact;
  const t = Date.parse(candleTime);
  if (!Number.isFinite(t)) return null;
  return bars.find((b) => Date.parse(b.time) === t) || null;
}

export class OhlcCollector {
  constructor(OHLC, { maxBars = 2000 } = {}) {
    this.OHLC = OHLC;
    this.maxBars = maxBars;
    this.reqInterval = new Map();
    this.bars = new Map();
  }

  key(symbolKey, interval) {
    return `${symbolKey}|${interval}`;
  }

  noteSent(json) {
    if (!json || typeof json !== 'string' || !json.includes('TS/V2')) return;
    try {
      const obj = JSON.parse(json);
      const interval = obj.payload?.interval;
      const requestId = obj.request_id ?? obj.requestId;
      const symbol = obj.payload?.symbol;
      if (obj.command === 'TS/V2' && interval != null && requestId != null) {
        this.reqInterval.set(String(requestId), { interval, symbol });
      }
    } catch { /* ignore */ }
  }

  merge(symbolKey, interval, bars) {
    const k = this.key(symbolKey, interval);
    if (!this.bars.has(k)) this.bars.set(k, new Map());
    const m = this.bars.get(k);
    for (const b of bars) {
      if (b?.time) m.set(b.time, b);
    }
    if (m.size > this.maxBars) {
      const times = [...m.keys()].sort();
      const drop = m.size - this.maxBars;
      for (let i = 0; i < drop; i += 1) m.delete(times[i]);
    }
  }

  getBars(symbolKey, interval) {
    return [...(this.bars.get(this.key(symbolKey, interval))?.values() || [])];
  }

  dropSymbol(symbolKey) {
    for (const k of [...this.bars.keys()]) {
      if (k.startsWith(`${symbolKey}|`)) this.bars.delete(k);
    }
  }

  clear() {
    this.bars.clear();
    this.reqInterval.clear();
  }
}

export class FootprintClient {
  constructor({ FP, OHLC, session = 'RTH', intervals = ['2m', '3m', '5m'], log, dbg } = {}) {
    this.wsUrl = '';
    this.FP = FP;
    this.OHLC = OHLC;
    this.sessionType = session;
    this.intervals = intervals;
    this.log = log;
    this.dbg = dbg || (() => {});
    this.ohlcCollector = new OhlcCollector(OHLC);
    this.ws = null;
    this.nextId = 9000;
    this.pending = new Map();
    this.nativeIntervals = new Set();
  }

  get readyState() {
    return this.ws?.readyState;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  dropSymbol(symbolKey) {
    this.ohlcCollector.dropSymbol(symbolKey);
  }

  failPending(error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.quiet) clearTimeout(p.quiet);
      p.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  async disconnect() {
    this.failPending('ws disconnect');
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try { ws.removeAllListeners(); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
  }

  connect(wsUrl) {
    if (wsUrl) this.wsUrl = wsUrl;
    return new Promise((resolve, reject) => {
      try { this.ws?.removeAllListeners(); } catch { /* ignore */ }
      try { this.ws?.close(); } catch { /* ignore */ }
      this.failPending('ws reconnect');
      const ws = new WebSocket(this.wsUrl, {
        origin: 'https://gocharting.com',
        perMessageDeflate: false,
        handshakeTimeout: 20_000,
        headers: {
          Origin: 'https://gocharting.com',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        },
      });
      this.ws = ws;
      let opened = false;
      const t = setTimeout(() => {
        if (!opened) {
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error('poc ws connect timeout'));
        }
      }, 20_000);
      ws.on('open', () => {
        opened = true;
        clearTimeout(t);
        this.dbg({ ev: 'poc-ws-open' });
        resolve();
      });
      ws.on('unexpected-response', (req, res) => {
        this.dbg({ ev: 'poc-ws-unexpected', status: res.statusCode });
        if (!opened) {
          clearTimeout(t);
          reject(new Error(`ws unexpected HTTP ${res.statusCode}`));
        }
      });
      ws.on('error', (err) => {
        this.dbg({ ev: 'poc-ws-error', err: String(err.message || err) });
        if (!opened) {
          clearTimeout(t);
          reject(err);
        }
      });
      ws.on('close', (code, reason) => {
        this.dbg({ ev: 'poc-ws-close', code, reason: String(reason || '') });
        if (this.ws !== ws) return;
        this.ws = null;
        this.failPending(`ws closed ${code}`);
      });
      ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    });
  }

  send(obj) {
    const json = JSON.stringify(obj);
    this.ohlcCollector.noteSent(json);
    this.dbg({ ev: 'poc-send', json });
    if (!this.isOpen()) throw new Error('ws not open');
    this.ws.send(json);
  }

  onMessage(data, isBinary) {
    const binary = isBinary || Buffer.isBuffer(data);
    if (!binary && typeof data === 'string') {
      this.handleText(data);
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf[0] === 0x7b) {
      this.handleText(buf.toString('utf8'));
      return;
    }
    this.handleBinary(buf);
  }

  handleText(text) {
    let obj;
    try { obj = JSON.parse(text); } catch { return; }
    const ref = obj.ref || obj.payload?.ref || obj.data?.ref;
    const requestId = String(obj.request_id ?? obj.requestId ?? '');
    if (ref && this.pending.has(requestId)) {
      this.send({ command: 'FOOTPRINT/V2', request_id: Number(requestId), payload: { ref } });
    }
    const p = this.pending.get(requestId);
    if (p && (obj.error || obj.status === 'error' || obj.message)) {
      p.extra.error = obj.error || obj.message || JSON.stringify(obj).slice(0, 300);
    }
  }

  handleBinary(buf) {
    const fr = parseFrame(buf);
    if (!fr) return;
    this.dbg({ ev: 'poc-frame', cmd: fr.cmd, cursor: fr.cursor, requestId: fr.requestId, body: fr.body.length });
    if (fr.cmd === 'TS/V2') {
      this.handleOhlcFrame(fr);
      return;
    }
    if (fr.cmd !== 'FOOTPRINT/V2') return;

    let msg;
    try { msg = this.FP.decode(fr.body); } catch {
      if (fr.cursor && this.pending.has(fr.requestId)) {
        this.send({ command: 'FOOTPRINT/V2', request_id: Number(fr.requestId), payload: { ref: fr.cursor } });
      }
      return;
    }
    const obj = this.FP.toObject(msg, { longs: Number, defaults: false });
    const req = obj.request || {};
    const interval = req.interval || '';
    if (interval) this.nativeIntervals.add(interval);
    const candles = obj.candles || [];
    const p = this.pending.get(fr.requestId);
    if (!p) return;
    p.candles.push(...candles);
    if (req.interval) p.interval = req.interval;
    if (fr.cursor && candles.length === 0) {
      this.send({ command: 'FOOTPRINT/V2', request_id: Number(fr.requestId), payload: { ref: fr.cursor } });
      return;
    }
    if (p.quiet) clearTimeout(p.quiet);
    p.quiet = setTimeout(() => this.finish(fr.requestId), 1200);
  }

  handleOhlcFrame(fr) {
    let msg;
    try { msg = this.OHLC.decode(fr.body); } catch {
      return;
    }
    const obj = this.OHLC.toObject(msg, { longs: Number, defaults: false });
    const bars = flattenOhlc(obj);
    const p = this.pending.get(fr.cursor) || this.pending.get(fr.requestId);
    const meta = this.ohlcCollector.reqInterval.get(fr.cursor)
      || this.ohlcCollector.reqInterval.get(fr.requestId);
    const interval = (p && p.kind === 'ohlc' && p.interval) || meta?.interval;
    const symbolKey = p?.symbolKey || meta?.symbol;
    if (interval && symbolKey) this.ohlcCollector.merge(symbolKey, interval, bars);
    if (!p || p.kind !== 'ohlc') return;
    p.bars.push(...bars);
    if (p.quiet) clearTimeout(p.quiet);
    p.quiet = setTimeout(() => this.finish(p.id), 1200);
  }

  finish(requestId) {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    if (p.quiet) clearTimeout(p.quiet);
    this.pending.delete(requestId);
    if (p.kind === 'ohlc') {
      p.resolve({
        ok: p.bars.length > 0,
        interval: p.interval,
        bars: dedupeOhlcBars(p.bars),
        error: p.extra.error || (p.bars.length ? '' : 'no ohlc bars'),
      });
      return;
    }
    p.resolve({
      ok: p.candles.length > 0,
      interval: p.interval,
      candles: p.candles,
      error: p.extra.error || (p.candles.length ? '' : 'no candles'),
    });
  }

  requestOne(instrument, interval, dates, timeoutMs) {
    const request_id = this.nextId++;
    const symbolKey = symbolId(instrument);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(String(request_id))) return;
        this.finish(String(request_id));
      }, timeoutMs);
      this.pending.set(String(request_id), {
        id: String(request_id),
        kind: 'footprint',
        interval,
        symbolKey,
        candles: [],
        extra: {},
        resolve,
        timer,
        quiet: null,
      });
      this.send({
        command: 'FOOTPRINT/V2',
        request_id,
        payload: {
          exchange: instrument.exchange,
          segment: instrument.segment,
          symbol: instrument.symbol,
          interval,
          dates,
          session: this.sessionType,
        },
      });
    });
  }

  async requestInterval(instrument, interval, dates, timeoutMs = 10_000) {
    let last = { ok: false, interval, candles: [], error: 'no candles for any date' };
    for (const date of dates) {
      const res = await this.requestOne(instrument, interval, [date], timeoutMs);
      if (res.ok && res.candles.length) return res;
      last = res;
    }
    return last;
  }

  requestOhlc(instrument, interval, timeoutMs = 12_000) {
    const request_id = this.nextId++;
    const symbolKey = symbolId(instrument);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(String(request_id))) return;
        this.finish(String(request_id));
      }, timeoutMs);
      this.pending.set(String(request_id), {
        id: String(request_id),
        kind: 'ohlc',
        interval,
        symbolKey,
        bars: [],
        extra: {},
        resolve,
        timer,
        quiet: null,
      });
      this.send({
        request_id,
        command: 'TS/V2',
        action: 'add',
        payload: {
          msg_type: 'OHLCV/V2',
          symbol: symbolKey,
          interval,
          session: this.sessionType,
          hint: 'rows=500',
          idxs: [Math.max(0, this.intervals.indexOf(interval))],
        },
      });
    });
  }
}
