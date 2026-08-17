// Live scraper: persist closed 2m / 3m / 5m footprint candles (OHLC, delta,
// max delta, Max Vol B/S, POC, volume, OI change, session VWAP) for NSE Nifty
// during the 09:15–15:30 IST cash session.
//
// Auth is AWS Cognito USER_PASSWORD_AUTH (same public client id the website
// uses). No browser is required. Intervals are requested over the market-data
// WebSocket (FOOTPRINT/V2 + TS/V2 OHLCV/V2). See FINDINGS.md.
//
// Config: gitignored .env at repo root or investigation/ (see .env.example).
// Writes to Google Sheets when GOOGLE_SHEET_ID is set; local CSV when WRITE_CSV=1.
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import * as pako from 'pako';
import { loadConfig, validateConfig } from './lib/env.js';
import { CsvSink } from './lib/csv-sink.js';
import { SheetsSink } from './lib/sheets-sink.js';
import { symbolId } from './lib/columns.js';
import {
  footprintMetrics,
  oiFields,
  vwapByCandleTime,
} from './lib/footprint-metrics.js';
import {
  formatIst,
  inSession,
  isAfterClose,
  isBeforeOpen,
  isCandleClosed,
  isPersistableCandle,
  isWeekendIst,
  istDateString,
  istNow,
  marketWindowMs,
  sessionDatesFor,
} from './lib/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const configErrors = validateConfig(cfg);
if (configErrors.length) {
  for (const err of configErrors) console.error(err);
  process.exit(2);
}

const DEFAULT_WS_HOST = cfg.wsHost;
const DEVICE_TAG = cfg.wsTag;
const SYMBOL = cfg.symbol;
const INTERVALS = cfg.intervals;
const SESSION = cfg.session;
const RUN_MS = cfg.runMs;
const SAMPLE_MS = cfg.sampleMs;
const LAST_N = cfg.lastN;
const OUT_DIR = cfg.outDir;
const email = cfg.email;
const password = cfg.password;

// Public Amplify/Cognito config from the GoCharting web client.
const COGNITO_REGION = 'ap-south-1';
const COGNITO_CLIENT_ID = '3fqhvm22ea8pjsr2spbnv484pr';
const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;
const COGNITO_CLIENT_METADATA = { myCustomKey: 'myCustomValue' };
const sessionOpts = {
  open: cfg.marketOpen,
  close: cfg.marketClose,
  graceMs: cfg.closeGraceMs,
};

fs.mkdirSync(OUT_DIR, { recursive: true });

const debugLog = fs.createWriteStream(path.join(OUT_DIR, 'debug.jsonl'));
const dbg = (o) => debugLog.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

function redact(s) {
  if (s == null) return s;
  let out = String(s);
  for (const sec of [password, email, encodeURIComponent(password), encodeURIComponent(email)]) {
    if (sec) out = out.split(sec).join('[REDACTED]');
  }
  out = out.replace(/token=[^&"'\s]+/gi, 'token=[REDACTED]');
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]');
  return out;
}

function jwtExpMs(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return Number(exp) * 1000;
  } catch {
    return 0;
  }
}

async function cognitoInitiateAuth({ username, password: pw, refreshToken }) {
  const body = refreshToken
    ? {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
      ClientMetadata: COGNITO_CLIENT_METADATA,
    }
    : {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: pw },
      ClientMetadata: COGNITO_CLIENT_METADATA,
    };
  const res = await fetch(COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`cognito non-json ${res.status}`);
  }
  if (!res.ok || data.__type || data.message) {
    const msg = data.message || data.__type || `HTTP ${res.status}`;
    throw new Error(`cognito auth failed: ${msg}`);
  }
  if (data.ChallengeName) {
    throw new Error(`cognito extra challenge: ${data.ChallengeName}`);
  }
  const ar = data.AuthenticationResult || {};
  if (!ar.IdToken) throw new Error('cognito auth failed: no IdToken');
  return {
    idToken: ar.IdToken,
    accessToken: ar.AccessToken || '',
    refreshToken: ar.RefreshToken || refreshToken || '',
    expiresIn: Number(ar.ExpiresIn || 0),
    expMs: jwtExpMs(ar.IdToken),
  };
}

function buildWsUrl(idToken) {
  return `${DEFAULT_WS_HOST}?token=${encodeURIComponent(idToken)}&tag=${encodeURIComponent(DEVICE_TAG)}`;
}

const num = (v) => (v && typeof v === 'object' && 'toNumber' in v ? v.toNumber() : Number(v || 0));

function addMinutesIst(startIso, offsetMin) {
  const t = new Date(startIso);
  if (Number.isNaN(t.getTime())) return '';
  t.setTime(t.getTime() + Number(offsetMin || 0) * 60_000);
  return formatIst(t);
}

function flattenOhlc(obj) {
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

function findOhlcBar(bars, candleTime) {
  if (!bars?.length || !candleTime) return null;
  const exact = bars.find((b) => b.time === candleTime);
  if (exact) return exact;
  const t = Date.parse(candleTime);
  if (!Number.isFinite(t)) return null;
  return bars.find((b) => Date.parse(b.time) === t) || null;
}

function dedupeOhlcBars(bars) {
  const map = new Map();
  for (const b of bars || []) {
    if (b?.time) map.set(b.time, b);
  }
  return [...map.values()];
}

function fmtOhlc(bar) {
  if (!bar) return '-';
  return `${bar.open}/${bar.high}/${bar.low}/${bar.close}`;
}

class OhlcCollector {
  constructor(OHLC) {
    this.OHLC = OHLC;
    this.reqInterval = new Map(); // requestId -> interval
    this.bars = new Map(); // interval -> Map(time -> bar)
  }

  noteSent(json) {
    if (!json || typeof json !== 'string' || !json.includes('TS/V2')) return;
    try {
      const obj = JSON.parse(json);
      const interval = obj.payload?.interval;
      const requestId = obj.request_id ?? obj.requestId;
      if (obj.command === 'TS/V2' && interval != null && requestId != null) {
        this.reqInterval.set(String(requestId), interval);
      }
    } catch { /* ignore */ }
  }

  noteBinary(buf) {
    const fr = parseFrame(buf);
    if (!fr || fr.cmd !== 'TS/V2') return 0;
    let msg;
    try { msg = this.OHLC.decode(fr.body); } catch {
      return 0;
    }
    const obj = this.OHLC.toObject(msg, { longs: Number, defaults: false });
    const bars = flattenOhlc(obj);
    const interval = this.reqInterval.get(fr.cursor) || this.reqInterval.get(fr.requestId);
    if (!interval || !bars.length) return bars.length;
    this.merge(interval, bars);
    return bars.length;
  }

  merge(interval, bars) {
    if (!this.bars.has(interval)) this.bars.set(interval, new Map());
    const m = this.bars.get(interval);
    for (const b of bars) {
      if (b?.time) m.set(b.time, b);
    }
  }

  getBars(interval) {
    return [...(this.bars.get(interval)?.values() || [])];
  }
}

function parseFrame(buf) {
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

function summarizeCandle(candle) {
  return footprintMetrics(candle);
}

function lastNCandles(candles, n) {
  if (!candles?.length) return [];
  return [...candles]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .slice(-n);
}

class FootprintClient {
  constructor(FP, OHLC, ohlcCollector, { symbol, intervals, session } = {}) {
    this.wsUrl = '';
    this.FP = FP;
    this.OHLC = OHLC;
    this.ohlcCollector = ohlcCollector;
    this.symbol = symbol || SYMBOL;
    this.intervals = intervals || INTERVALS;
    this.sessionType = session || SESSION;
    this.ws = null;
    this.nextId = 9000;
    this.pending = new Map(); // requestId -> { kind, interval, candles/bars, extra, resolve, timer, quiet }
    this.nativeIntervals = new Set();
  }

  connect(wsUrl) {
    if (wsUrl) this.wsUrl = wsUrl;
    try { this.ws?.close(); } catch {}
    return new Promise((resolve, reject) => {
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
      const t = setTimeout(() => reject(new Error('poc ws connect timeout')), 20_000);
      ws.on('open', () => {
        opened = true;
        clearTimeout(t);
        dbg({ ev: 'poc-ws-open' });
        resolve();
      });
      ws.on('unexpected-response', (req, res) => {
        dbg({ ev: 'poc-ws-unexpected', status: res.statusCode });
        if (!opened) {
          clearTimeout(t);
          reject(new Error(`ws unexpected HTTP ${res.statusCode}`));
        }
      });
      ws.on('error', (err) => {
        dbg({ ev: 'poc-ws-error', err: String(err.message || err) });
        if (!opened) {
          clearTimeout(t);
          reject(err);
        }
      });
      ws.on('close', (code, reason) => {
        dbg({ ev: 'poc-ws-close', code, reason: redact(String(reason || '')) });
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: `ws closed ${code}` });
        }
        this.pending.clear();
      });
      ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    });
  }

  send(obj) {
    const json = JSON.stringify(obj);
    this.ohlcCollector?.noteSent(json);
    dbg({ ev: 'poc-send', json: redact(json) });
    this.ws.send(json);
  }

  onMessage(data, isBinary) {
    const binary = isBinary || Buffer.isBuffer(data);
    if (!binary && typeof data === 'string') {
      dbg({ ev: 'poc-text', data: redact(data).slice(0, 2000) });
      this.handleText(data);
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Some servers deliver JSON as a binary opcode.
    if (buf[0] === 0x7b /* '{' */) {
      const s = buf.toString('utf8');
      dbg({ ev: 'poc-text-bin', data: redact(s).slice(0, 2000) });
      this.handleText(s);
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
    if (!fr) {
      const utf8 = buf.toString('utf8');
      dbg({
        ev: 'poc-unparsed',
        len: buf.length,
        b0: buf[0],
        utf8: redact(utf8).slice(0, 200),
      });
      return;
    }
    dbg({ ev: 'poc-frame', cmd: fr.cmd, cursor: fr.cursor, requestId: fr.requestId, body: fr.body.length });
    if (fr.cmd === 'TS/V2') {
      this.handleOhlcFrame(fr);
      return;
    }
    if (fr.cmd !== 'FOOTPRINT/V2') return;

    let msg;
    try { msg = this.FP.decode(fr.body); } catch (e) {
      dbg({ ev: 'decode-err', err: e.message, requestId: fr.requestId });
      // Empty / ref-only body: follow the cursor if present.
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
    dbg({
      ev: 'footprint',
      requestId: fr.requestId,
      interval,
      date: req.date,
      candles: candles.length,
      last: candles.length ? candles[candles.length - 1]?.date : null,
    });

    const p = this.pending.get(fr.requestId);
    if (!p) return;
    p.candles.push(...candles);
    if (req.interval) p.interval = req.interval;
    if (fr.cursor && candles.length === 0) {
      this.send({ command: 'FOOTPRINT/V2', request_id: Number(fr.requestId), payload: { ref: fr.cursor } });
      return;
    }
    // Debounce: more frames (other session dates / ref follow-ups) may still arrive.
    if (p.quiet) clearTimeout(p.quiet);
    p.quiet = setTimeout(() => this.finish(fr.requestId), 1200);
  }

  handleOhlcFrame(fr) {
    let msg;
    try { msg = this.OHLC.decode(fr.body); } catch (e) {
      dbg({ ev: 'ohlc-decode-err', err: e.message, requestId: fr.requestId, cursor: fr.cursor, body: fr.body.length });
      return;
    }
    const obj = this.OHLC.toObject(msg, { longs: Number, defaults: false });
    const bars = flattenOhlc(obj);
    dbg({
      ev: 'ohlc',
      requestId: fr.requestId,
      cursor: fr.cursor,
      zone: obj.zone,
      count: obj.count,
      offsetIn: obj.offsetIn || obj.offset_in,
      bars: bars.length,
      last: bars.length ? bars.reduce((a, b) => (a.time > b.time ? a : b)).time : null,
    });

    // TS/V2 headers are "TS/V2~<request_id>~<page>"; FOOTPRINT uses request_id in the 3rd slot.
    const p = this.pending.get(fr.cursor) || this.pending.get(fr.requestId);
    const interval = (p && p.kind === 'ohlc' && p.interval)
      || this.ohlcCollector?.reqInterval.get(fr.cursor)
      || this.ohlcCollector?.reqInterval.get(fr.requestId);
    if (interval && this.ohlcCollector) this.ohlcCollector.merge(interval, bars);
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

  requestOne(interval, dates, timeoutMs) {
    const request_id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(String(request_id))) return;
        this.finish(String(request_id));
      }, timeoutMs);
      this.pending.set(String(request_id), {
        id: String(request_id),
        kind: 'footprint',
        interval,
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
          exchange: this.symbol.exchange,
          segment: this.symbol.segment,
          symbol: this.symbol.symbol,
          interval,
          dates,
          session: this.sessionType,
        },
      });
    });
  }

  async requestInterval(interval, dates, timeoutMs = 10_000) {
    let last = { ok: false, interval, candles: [], error: 'no candles for any date' };
    for (const date of dates) {
      const res = await this.requestOne(interval, [date], timeoutMs);
      if (res.ok && res.candles.length) return res;
      last = res;
    }
    return last;
  }

  requestOhlc(interval, timeoutMs = 12_000) {
    const request_id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(String(request_id))) return;
        this.finish(String(request_id));
      }, timeoutMs);
      this.pending.set(String(request_id), {
        id: String(request_id),
        kind: 'ohlc',
        interval,
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
          symbol: symbolId(this.symbol),
          interval,
          session: this.sessionType,
          // Official client always sends these; without them the server ignores the add.
          hint: 'rows=500',
          idxs: [Math.max(0, this.intervals.indexOf(interval))],
        },
      });
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForMarketOpen() {
  while (isBeforeOpen(Date.now(), sessionOpts)) {
    const today = istDateString(new Date());
    const { openMs } = marketWindowMs(today, cfg.marketOpen, cfg.marketClose);
    const remain = Math.max(0, openMs - Date.now());
    console.log(`waiting for ${cfg.marketOpen} IST open (${Math.ceil(remain / 1000)}s)`);
    await sleep(Math.min(remain || 1000, 30_000));
  }
}

function shouldStop(startedAt) {
  if (RUN_MS != null) return Date.now() >= startedAt + RUN_MS;
  const today = istDateString(new Date());
  const { closeMs } = marketWindowMs(today, cfg.marketOpen, cfg.marketClose);
  return Date.now() >= closeMs + cfg.afterCloseBufferMs;
}

function candleToRow({
  interval, candle, ohlcBars, vwapMap, sampled_at_utc, sampled_at_ist, sample_n, candlesInResponse, error,
}) {
  const stats = candle ? summarizeCandle(candle) : {};
  const bar = candle ? findOhlcBar(ohlcBars, stats.candle_time) : null;
  if (candle && !bar) {
    dbg({ ev: 'ohlc-miss', interval, candle_time: stats.candle_time, nBars: ohlcBars.length });
  }
  const high = bar ? bar.high : (candle ? stats.fp_high : '');
  const low = bar ? bar.low : (candle ? stats.fp_low : '');
  const oi = bar ? oiFields(bar, ohlcBars) : { oi: '', oi_change: '' };
  const vwap = bar && vwapMap ? (vwapMap.get(bar.time) ?? '') : '';
  return {
    sampled_at_utc,
    sampled_at_ist,
    sample_n,
    interval,
    symbol: symbolId(SYMBOL),
    candle_time: stats.candle_time || '',
    open: bar ? bar.open : '',
    high: high ?? '',
    low: low ?? '',
    close: bar ? bar.close : '',
    ohlc_volume: bar ? bar.volume : '',
    max_vol_b: candle ? stats.max_vol_b : '',
    max_vol_s: candle ? stats.max_vol_s : '',
    max_vol_b_level: candle ? stats.max_vol_b_level : '',
    max_vol_s_level: candle ? stats.max_vol_s_level : '',
    totals_buy: candle ? stats.totals_buy : '',
    totals_sell: candle ? stats.totals_sell : '',
    price_levels: candle ? stats.price_levels : '',
    recomputed_max_b: candle ? stats.recomputed_max_b : '',
    recomputed_max_s: candle ? stats.recomputed_max_s : '',
    values_match: candle ? stats.values_match : '',
    candles_in_response: candlesInResponse,
    ok: Boolean(candle),
    error: candle ? '' : (error || 'no candle'),
    delta: candle ? stats.delta : '',
    max_delta: candle ? stats.max_delta : '',
    min_delta: candle ? stats.min_delta : '',
    poc: candle ? stats.poc : '',
    poc_volume: candle ? stats.poc_volume : '',
    volume: candle ? stats.volume : '',
    oi: oi.oi,
    oi_change: oi.oi_change,
    vwap,
  };
}

async function initSinks() {
  const sinks = [];
  if (cfg.writeCsv) sinks.push(new CsvSink(cfg.csvPath));
  if (cfg.sheetId) {
    sinks.push(new SheetsSink({
      sheetId: cfg.sheetId,
      googleCredentialsPath: cfg.googleCredentialsPath,
      googleCredentialsJson: cfg.googleCredentialsJson,
      googleClientEmail: cfg.googleClientEmail,
      googlePrivateKey: cfg.googlePrivateKey,
    }));
  }
  await Promise.all(sinks.map((s) => s.init(INTERVALS, SYMBOL.symbol)));
  return sinks;
}

async function writeToSinks(sinks, rows) {
  const counts = await Promise.all(sinks.map((s) => Promise.resolve(s.writeRows(rows))));
  return counts.reduce((a, b) => a + b, 0);
}

async function refreshAuth(client, auth) {
  console.log('refreshing cognito token');
  let next;
  try {
    next = await cognitoInitiateAuth({ refreshToken: auth.refreshToken });
  } catch (e) {
    dbg({ ev: 'refresh-fail', err: String(e.message || e) });
    next = await cognitoInitiateAuth({ username: email, password });
  }
  dbg({ ev: 'cognito-refresh', expiresIn: next.expiresIn, expMs: next.expMs });
  await client.connect(buildWsUrl(next.idToken));
  return next;
}

async function main() {
  const protoPath = path.join(__dirname, 'evidence', 'footprint.proto');
  const ohlcProtoPath = path.join(__dirname, 'evidence', 'ohlc_bars.proto');
  const root = await protobuf.load(protoPath);
  const ohlcRoot = await protobuf.load(ohlcProtoPath);
  const FP = root.lookupType('fpgc.FootPrintForDateResponse');
  const OHLC = ohlcRoot.lookupType('protobars.OHLCBarResult');
  const ohlcCollector = new OhlcCollector(OHLC);

  console.log('cognito login (USER_PASSWORD_AUTH, no browser)');
  console.log('symbol', symbolId(SYMBOL), 'intervals', INTERVALS.join(', '), 'session', `${cfg.marketOpen}–${cfg.marketClose} IST`);
  console.log('ws', DEFAULT_WS_HOST);
  console.log('outputs', {
    csv: cfg.writeCsv ? cfg.csvPath : false,
    sheet: cfg.sheetId || false,
  });

  const sinks = await initSinks();
  const now0 = Date.now();
  let oneShotAfterHours = false;
  if (RUN_MS == null) {
    if (isWeekendIst(now0)) {
      console.log('weekend; one-shot backfill of last weekday session');
      oneShotAfterHours = true;
    } else if (isBeforeOpen(now0, sessionOpts)) {
      await waitForMarketOpen();
    } else if (isAfterClose(now0, sessionOpts)) {
      console.log('after market close; one-shot backfill of today\'s closed candles');
      oneShotAfterHours = true;
    }
  }

  let auth = await cognitoInitiateAuth({ username: email, password });
  dbg({ ev: 'cognito-ok', expiresIn: auth.expiresIn, expMs: auth.expMs });
  console.log('cognito ok expiresIn=', auth.expiresIn, 's');

  const client = new FootprintClient(FP, OHLC, ohlcCollector, {
    symbol: SYMBOL,
    intervals: INTERVALS,
    session: SESSION,
  });
  await client.connect(buildWsUrl(auth.idToken));
  let lastAuthAt = Date.now();
  try {

    const start = Date.now();
    let sampleN = 0;
    let nextAt = start;

    while (true) {
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);

      sampleN += 1;
      const nowMs = Date.now();
      const sampled_at_utc = new Date(nowMs).toISOString();
      const sampled_at_ist = istNow(new Date(nowMs));
      const dates = sessionDatesFor(nowMs, sessionOpts);
      console.log(`\n--- sample ${sampleN} @ ${sampled_at_utc} ---`);
      console.log('session dates (IST):', dates.join(', '));

      const tokenStale = auth.expMs - nowMs < 5 * 60_000;
      if (tokenStale || nowMs - lastAuthAt >= cfg.tokenRefreshMs || client.ws.readyState !== WebSocket.OPEN) {
        try {
          auth = await refreshAuth(client, auth);
          lastAuthAt = Date.now();
        } catch (e) {
          console.error('auth refresh failed', e);
          dbg({ ev: 'auth-refresh-err', err: String(e.message || e) });
        }
      }

      if (client.ws.readyState !== WebSocket.OPEN) {
        console.log('ws not open; reconnecting');
        await client.connect(buildWsUrl(auth.idToken));
      }

      const results = await Promise.all(INTERVALS.map(async (iv) => {
        const [fp, ohlc] = await Promise.all([
          client.requestInterval(iv, dates),
          client.requestOhlc(iv),
        ]);
        return { interval: iv, fp, ohlc };
      }));

      const closedRows = [];
      for (const { interval, fp: res, ohlc } of results) {
        const ohlcBars = dedupeOhlcBars([...(ohlc?.bars || []), ...ohlcCollector.getBars(interval)]);
        const sessionBars = ohlcBars.filter((b) => inSession(b.time, sessionOpts));
        const vwapMap = vwapByCandleTime(sessionBars);
        const candles = res.candles || [];
        if (LAST_N > 0) {
          const slice = lastNCandles(candles, LAST_N);
          console.log(`  ${interval} last ${slice.length}/${candles.length}:`);
          for (const c of slice) {
            const s = summarizeCandle(c);
            const bar = findOhlcBar(ohlcBars, s.candle_time);
            const vwap = bar ? (vwapMap.get(bar.time) ?? '') : '';
            console.log(
              `    ${s.candle_time}  OHLC=${fmtOhlc(bar)}  Δ=${s.delta} maxΔ=${s.max_delta} MaxVolB=${s.max_vol_b} MaxVolS=${s.max_vol_s} POC=${s.poc} vol=${s.volume} VWAP=${vwap} match=${s.values_match}`,
            );
          }
        }

        const closed = candles
          .filter((c) => isPersistableCandle(c.date, nowMs, sessionOpts))
          .filter((c) => isCandleClosed(c.date, interval, nowMs, sessionOpts))
          .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

        for (const candle of closed) {
          closedRows.push(candleToRow({
            interval,
            candle,
            ohlcBars,
            vwapMap,
            sampled_at_utc,
            sampled_at_ist,
            sample_n: sampleN,
            candlesInResponse: candles.length,
            error: res.error,
          }));
        }

        const forming = candles
          .filter((c) => isPersistableCandle(c.date, nowMs, sessionOpts) && inSession(c.date, sessionOpts))
          .filter((c) => !isCandleClosed(c.date, interval, nowMs, sessionOpts))
          .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
          .at(-1);
        console.log(
          `  ${interval}: closed=${closed.length}/${candles.length} forming=${forming?.date || '-'} err=${res.ok ? '' : (res.error || '')}`,
        );
        if (closed.length) {
          const lastClosed = closed[closed.length - 1];
          const stats = summarizeCandle(lastClosed);
          const bar = findOhlcBar(ohlcBars, stats.candle_time);
          const vwap = bar ? (vwapMap.get(bar.time) ?? '') : '';
          console.log(
            `    last closed ${stats.candle_time}  OHLC=${fmtOhlc(bar)}  Δ=${stats.delta} maxΔ=${stats.max_delta} MaxVolB=${stats.max_vol_b} MaxVolS=${stats.max_vol_s} POC=${stats.poc} vol=${stats.volume} VWAP=${vwap} match=${stats.values_match}`,
          );
        }
      }

      const wrote = await writeToSinks(sinks, closedRows);
      console.log(`  wrote ${wrote} new closed-candle row(s)`);

      if (oneShotAfterHours || RUN_MS === 0 || shouldStop(start)) break;
      nextAt += SAMPLE_MS;
      if (nextAt < Date.now()) nextAt = Date.now();
    }

    console.log('\nDONE samples=', sampleN, {
      csv: cfg.writeCsv ? cfg.csvPath : false,
      sheet: cfg.sheetId || false,
    });
  } finally {
    try { client?.ws?.close(); } catch {}
    debugLog.end();
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
