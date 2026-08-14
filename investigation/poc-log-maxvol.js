// Proof-of-concept: log Max Vol B / Max Vol S and OHLC every 30s for 5m / 10m /
// 15m candles, using the FOOTPRINT/V2 + TS/V2 (OHLCV/V2) WebSocket protocol
// documented in FINDINGS.md.
//
// Visits the saved chart URL and logs in (required). Does NOT change profile
// settings or click terminal/chart buttons (no timeframe clicks) — the three
// intervals are requested directly over the market-data WebSocket.
//
// Credentials: GOCHARTING_EMAIL / GOCHARTING_PASSWORD (env only, never written).
//
// Usage:
//   cd investigation && npm install
//   PW_CHANNEL=chrome xvfb-run -a node poc-log-maxvol.js
//   HEADLESS=1 node poc-log-maxvol.js
//
// Optional env:
//   RUN_MS      total sampling window (default 300000 = 5 minutes)
//   SAMPLE_MS   period between samples (default 30000)
//   LAST_N      if set, also print the last N candles per interval
//   HEADLESS    1/true to launch Chromium/Chrome without a display
//   CSV_PATH    output CSV (default investigation/evidence/maxvol-poc.csv)
import { chromium } from 'playwright';
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import * as pako from 'pako';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHART_URL = 'https://gocharting.com/terminal/chart/kd5OXEIXs';
const DEFAULT_WS_HOST = 'wss://origin.ws.prodb.blr1.gocharting.com/blr1/ws';
const SYMBOL = { exchange: 'MCX', segment: 'FUTURE', symbol: 'CRUDEOIL-I' };
const INTERVALS = ['5m', '10m', '15m'];
const SESSION = 'RTH';

const RUN_MS = Number(process.env.RUN_MS || 300_000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 30_000);
const LAST_N = Number(process.env.LAST_N || 0);
const HEADLESS = /^(1|true|yes)$/i.test(String(process.env.HEADLESS || ''));
const CSV_PATH = process.env.CSV_PATH || path.join(__dirname, 'evidence', 'maxvol-poc.csv');
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'out', 'poc');

const email = process.env.GOCHARTING_EMAIL;
const password = process.env.GOCHARTING_PASSWORD;
if (!email || !password) {
  console.error('missing GOCHARTING_EMAIL / GOCHARTING_PASSWORD');
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });

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

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function istDateString(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function istNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';
}

function sessionDates() {
  // Today + previous two IST calendar days (session date can lag around midnight).
  return [istDateString(0), istDateString(-1), istDateString(-2)];
}

const num = (v) => (v && typeof v === 'object' && 'toNumber' in v ? v.toNumber() : Number(v || 0));

function formatIst(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}+05:30`;
}

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
  const levels = candle.footprint || [];
  let maxBuy = 0;
  let maxSell = 0;
  let maxBuyLevel = '';
  let maxSellLevel = '';
  let fpHigh = -Infinity;
  let fpLow = Infinity;
  for (const l of levels) {
    const b = num(l.buy?.volume);
    const s = num(l.sell?.volume);
    const px = num(l.level);
    if (b > maxBuy) { maxBuy = b; maxBuyLevel = px; }
    if (s > maxSell) { maxSell = s; maxSellLevel = px; }
    if (b + s > 0) {
      if (px > fpHigh) fpHigh = px;
      if (px < fpLow) fpLow = px;
    }
  }
  const es = candle.endingSummary || candle.ending_summary || {};
  const esHigh = num(es.high);
  const esLow = num(es.low);
  const serverBuy = num(candle.max?.buy?.volume);
  const serverSell = num(candle.max?.sell?.volume);
  return {
    candle_time: candle.date || '',
    max_vol_b: serverBuy,
    max_vol_s: serverSell,
    totals_buy: num(candle.totals?.buy?.volume),
    totals_sell: num(candle.totals?.sell?.volume),
    price_levels: levels.length,
    recomputed_max_b: maxBuy,
    recomputed_max_s: maxSell,
    max_vol_b_level: maxBuyLevel,
    max_vol_s_level: maxSellLevel,
    values_match: serverBuy === maxBuy && serverSell === maxSell,
    fp_high: esHigh || (Number.isFinite(fpHigh) ? fpHigh : ''),
    fp_low: esLow || (Number.isFinite(fpLow) ? fpLow : ''),
  };
}

function latestCandle(candles) {
  if (!candles?.length) return null;
  return candles.reduce((best, c) => {
    if (!best) return c;
    return String(c.date || '') > String(best.date || '') ? c : best;
  }, null);
}

function lastNCandles(candles, n) {
  if (!candles?.length) return [];
  return [...candles]
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    .slice(-n);
}

class FootprintClient {
  constructor(wsUrl, FP, OHLC, ohlcCollector) {
    this.wsUrl = wsUrl;
    this.FP = FP;
    this.OHLC = OHLC;
    this.ohlcCollector = ohlcCollector;
    this.ws = null;
    this.nextId = 9000;
    this.pending = new Map(); // requestId -> { kind, interval, candles/bars, extra, resolve, timer, quiet }
    this.nativeIntervals = new Set();
  }

  connect() {
    try { this.ws?.close(); } catch {}
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, {
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
      ws.on('error', (err) => {
        dbg({ ev: 'poc-ws-error', err: String(err.message || err) });
        if (!opened) reject(err);
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
          exchange: SYMBOL.exchange,
          segment: SYMBOL.segment,
          symbol: SYMBOL.symbol,
          interval,
          dates,
          session: SESSION,
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
          symbol: `${SYMBOL.exchange}:${SYMBOL.segment}:${SYMBOL.symbol}`,
          interval,
          session: SESSION,
          // Official client always sends these; without them the server ignores the add.
          hint: 'rows=500',
          idxs: [Math.max(0, INTERVALS.indexOf(interval))],
        },
      });
    });
  }
}

async function loginAndGetWsUrl(page, context, ohlcCollector) {
  let wsUrl = '';
  const seen = new Set();

  const noteUrl = (u) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    dbg({ ev: 'ws-seen', url: redact(u) });
    if (/\/ws(\?|$)/.test(u) && u.includes('token=')) wsUrl = u;
    else if (/gocharting\.com.*\/ws/.test(u) && !wsUrl) wsUrl = u;
  };

  page.on('websocket', (ws) => {
    noteUrl(ws.url());
    ws.on('framesent', (d) => {
      const s = typeof d.payload === 'string' ? d.payload : '';
      if (s) ohlcCollector?.noteSent(s);
      if (s && /FOOTPRINT|command/i.test(s)) dbg({ ev: 'native-sent', data: redact(s).slice(0, 1500) });
    });
    ws.on('framereceived', (d) => {
      const p = d.payload;
      if (p == null) return;
      let buf;
      if (Buffer.isBuffer(p)) buf = p;
      else if (typeof p === 'string') {
        if (!p.length || p.charCodeAt(0) === 0x7b) return;
        buf = Buffer.from(p, 'latin1');
      } else {
        buf = Buffer.from(p);
      }
      const n = ohlcCollector?.noteBinary(buf) || 0;
      if (n) dbg({ ev: 'native-ohlc', url: redact(ws.url()), bars: n });
    });
  });

  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', (p) => noteUrl(p.url));
    cdp.on('Target.attachedToTarget', async (ev) => {
      try {
        const session = ev.sessionId
          ? await context.newCDPSession(page).catch(() => null)
          : null;
        void session;
      } catch {}
    });
  } catch (e) {
    dbg({ ev: 'cdp-err', err: e.message });
  }

  console.log('goto', CHART_URL);
  await page.goto(CHART_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(5000);

  const dismiss = page.locator('button', { hasText: /^Dismiss$/ });
  if (await dismiss.count()) {
    await dismiss.first().click().catch(() => {});
    await page.waitForTimeout(800);
  }

  console.log('login');
  await page.locator('#login-avatar').click({ timeout: 15_000 });
  await page.waitForSelector('#email_field', { timeout: 20_000 });
  await page.fill('#email_field', email);
  await page.fill('#password_field', password);
  await page.locator('button[type=submit]', { hasText: /Sign In/i }).click();
  await page.waitForTimeout(8000);

  const stillLogin = await page.locator('#email_field').count();
  console.log('loginModalGone=', stillLogin === 0, 'url=', page.url());
  if (stillLogin > 0) {
    await page.screenshot({ path: path.join(OUT_DIR, 'login-failed.png') }).catch(() => {});
    throw new Error('login modal still present');
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'after-login.png') }).catch(() => {});

  // Wait for the market-data WS (token in query string).
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !String(wsUrl).includes('token=')) {
    await page.waitForTimeout(500);
  }

  // Fallback: Cognito id token in localStorage.
  if (!String(wsUrl).includes('token=')) {
    const tok = await page.evaluate(() => {
      const out = { idToken: '', keys: Object.keys(localStorage) };
      for (const k of out.keys) {
        if (/idToken$/i.test(k)) { out.idToken = localStorage.getItem(k) || ''; break; }
      }
      return out;
    });
    dbg({ ev: 'localStorage-keys', keys: tok.keys.filter((k) => /cognito|token|jwt/i.test(k)) });
    if (tok.idToken) {
      const host = wsUrl && wsUrl.startsWith('wss://') ? wsUrl.split('?')[0] : DEFAULT_WS_HOST;
      wsUrl = `${host}?token=${tok.idToken}`;
    }
  }

  if (!wsUrl) throw new Error('could not obtain market-data websocket URL / token');
  dbg({ ev: 'ws-url-ready', url: redact(wsUrl) });
  return wsUrl;
}

function writeHeader(stream) {
  stream.write([
    'sampled_at_utc',
    'sampled_at_ist',
    'sample_n',
    'interval',
    'symbol',
    'candle_time',
    'open',
    'high',
    'low',
    'close',
    'ohlc_volume',
    'max_vol_b',
    'max_vol_s',
    'max_vol_b_level',
    'max_vol_s_level',
    'totals_buy',
    'totals_sell',
    'price_levels',
    'recomputed_max_b',
    'recomputed_max_s',
    'values_match',
    'candles_in_response',
    'ok',
    'error',
  ].join(',') + '\n');
}

function writeRow(stream, row) {
  const cols = [
    row.sampled_at_utc, row.sampled_at_ist, row.sample_n, row.interval, row.symbol,
    row.candle_time, row.open, row.high, row.low, row.close, row.ohlc_volume,
    row.max_vol_b, row.max_vol_s, row.max_vol_b_level, row.max_vol_s_level,
    row.totals_buy, row.totals_sell, row.price_levels, row.recomputed_max_b, row.recomputed_max_s,
    row.values_match, row.candles_in_response, row.ok, row.error,
  ];
  stream.write(cols.map(csvEscape).join(',') + '\n');
}

async function main() {
  const protoPath = path.join(__dirname, 'evidence', 'footprint.proto');
  const ohlcProtoPath = path.join(__dirname, 'evidence', 'ohlc_bars.proto');
  const root = await protobuf.load(protoPath);
  const ohlcRoot = await protobuf.load(ohlcProtoPath);
  const FP = root.lookupType('fpgc.FootPrintForDateResponse');
  const OHLC = ohlcRoot.lookupType('protobars.OHLCBarResult');
  const ohlcCollector = new OhlcCollector(OHLC);

  const launchOpts = { headless: HEADLESS, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;
  console.log('browser launch', { headless: HEADLESS, channel: process.env.PW_CHANNEL || 'playwright-chromium' });

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  let client;
  try {
    const wsUrl = await loginAndGetWsUrl(page, context, ohlcCollector);
    client = new FootprintClient(wsUrl, FP, OHLC, ohlcCollector);
    await client.connect();

    const dates = sessionDates();
    console.log('session dates (IST):', dates.join(', '));
    console.log(`sampling ${INTERVALS.join(', ')} every ${SAMPLE_MS / 1000}s for ${RUN_MS / 1000}s`);
    console.log('csv ->', CSV_PATH);

    const csv = fs.createWriteStream(CSV_PATH);
    writeHeader(csv);

    const start = Date.now();
    const last = start + RUN_MS;
    let sampleN = 0;

    for (let when = start; when <= last; when += SAMPLE_MS) {
      const wait = when - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      sampleN += 1;
      const sampled_at_utc = new Date().toISOString();
      const sampled_at_ist = istNow();
      console.log(`\n--- sample ${sampleN} @ ${sampled_at_utc} ---`);

      if (client.ws.readyState !== WebSocket.OPEN) {
        console.log('ws not open; reconnecting');
        await client.connect();
      }

      const results = await Promise.all(INTERVALS.map(async (iv) => {
        const [fp, ohlc] = await Promise.all([
          client.requestInterval(iv, dates),
          client.requestOhlc(iv),
        ]);
        return { interval: iv, fp, ohlc };
      }));
      for (const { interval, fp: res, ohlc } of results) {
        const ohlcBars = dedupeOhlcBars([...(ohlc?.bars || []), ...ohlcCollector.getBars(interval)]);
        if (LAST_N > 0) {
          const slice = lastNCandles(res.candles, LAST_N);
          console.log(`  ${interval} last ${slice.length}/${res.candles?.length || 0}:`);
          for (const c of slice) {
            const s = summarizeCandle(c);
            const bar = findOhlcBar(ohlcBars, s.candle_time);
            console.log(
              `    ${s.candle_time}  OHLC=${fmtOhlc(bar)}  MaxVolB=${s.max_vol_b} MaxVolS=${s.max_vol_s} totals=${s.totals_buy}/${s.totals_sell} levels=${s.price_levels} match=${s.values_match}`,
            );
          }
        }
        const candle = latestCandle(res.candles);
        const stats = candle ? summarizeCandle(candle) : {};
        const bar = candle ? findOhlcBar(ohlcBars, stats.candle_time) : null;
        if (candle && !bar) {
          dbg({ ev: 'ohlc-miss', interval, candle_time: stats.candle_time, nBars: ohlcBars.length, ohlcErr: ohlc?.error || '' });
        }
        const high = bar ? bar.high : (candle ? stats.fp_high : '');
        const low = bar ? bar.low : (candle ? stats.fp_low : '');
        const row = {
          sampled_at_utc,
          sampled_at_ist,
          sample_n: sampleN,
          interval,
          symbol: `${SYMBOL.exchange}:${SYMBOL.segment}:${SYMBOL.symbol}`,
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
          candles_in_response: res.candles?.length || 0,
          ok: Boolean(res.ok && candle),
          error: res.ok && candle ? '' : (res.error || 'no candle'),
        };
        writeRow(csv, row);
        console.log(
          `  ${interval}: ok=${row.ok} candle=${row.candle_time || '-'}  OHLC=${row.open || '-'}/${row.high || '-'}/${row.low || '-'}/${row.close || '-'} MaxVolB=${row.max_vol_b} MaxVolS=${row.max_vol_s} match=${row.values_match} n=${row.candles_in_response} ${row.error}`,
        );
      }
    }

    csv.end();
    await new Promise((r) => csv.on('finish', r));
    console.log('\nDONE samples=', sampleN, 'csv=', CSV_PATH);
  } finally {
    try { client?.ws?.close(); } catch {}
    debugLog.end();
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
