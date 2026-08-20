import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from './supervisor.js';
import { parseInstrumentId } from './instruments.js';
import { sheetTabName } from './columns.js';

function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

function mockAuth() {
  return {
    tokens: { idToken: 'id', refreshToken: 'r' },
    email: 'a@b.c',
    password: 'pw',
    getSecrets: () => ['pw'],
    async ensure() { return { changed: false, tokens: this.tokens }; },
  };
}

function inst(raw, intervals, slot = 1) {
  return { ...parseInstrumentId(raw), intervals, slot };
}

function baseCfg() {
  return {
    sampleMs: 15_000,
    configPollMs: 5_000,
    closeGraceMs: 2000,
    afterCloseBufferMs: 60_000,
    wsHost: 'wss://example',
    wsTag: 't',
    statusPath: '',
  };
}

describe('Supervisor instrument hot-swap', () => {
  it('overwrites the same slot tabs and does not delete sheets', async () => {
    const created = [];
    const dropped = [];
    const deletedSheets = [];
    const sink = {
      async ensureStaticTabs() {},
      async ensureInstrument(instrument) {
        created.push({
          slot: instrument.slot,
          symbol: instrument.symbol,
          intervals: [...instrument.intervals],
        });
      },
      dropInstrument(instrument) {
        dropped.push({ slot: instrument.slot, symbol: instrument.symbol });
      },
      async retainSession() { return 0; },
      async writeRows() { return 0; },
    };
    const client = {
      isOpen: () => false,
      dropSymbol() {},
      async disconnect() {},
      async connect() {},
    };
    const supervisor = new Supervisor({
      cfg: baseCfg(),
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink,
      auth: mockAuth(),
      client,
      now: () => Date.parse('2026-08-17T10:00:00+05:30'),
    });

    const x = inst('NSE:FUTURE:NIFTY-I', ['2m', '3m', '5m'], 1);
    const y = inst('NSE:OPTIONS:NIFTY2681824300CE', ['2m', '3m', '5m'], 1);
    await supervisor.reconcile([x]);
    await supervisor.reconcile([y]);

    assert.deepEqual(created.map((c) => c.symbol), ['NIFTY-I', 'NIFTY2681824300CE']);
    assert.deepEqual(created.map((c) => c.slot), [1, 1]);
    assert.deepEqual(created[0].intervals, ['2m', '3m', '5m']);
    assert.deepEqual(dropped.map((d) => d.symbol), ['NIFTY-I']);
    assert.deepEqual(deletedSheets, []);
    assert.deepEqual(supervisor.liveInstruments.map((i) => i.id), [y.id]);
    assert.equal(supervisor.instrumentState.has(x.slot), true);
    assert.equal(supervisor.instrumentState.get(y.slot).backfilledSessionDate, null);
    assert.equal(sheetTabName(y.slot, 0), '1A');
    assert.equal(sheetTabName(y.slot, 2), '1C');
  });

  it('backfills a newly added instrument immediately', async () => {
    const requested = [];
    const sink = {
      async ensureStaticTabs() {},
      async ensureInstrument() {},
      dropInstrument() {},
      async retainSession() { return 0; },
      async writeRows(rows) { return rows.length; },
    };
    const client = {
      isOpen: () => true,
      ws: { readyState: 1 },
      dropSymbol() {},
      async disconnect() {},
      async connect() {},
      ohlcCollector: { getBars() { return []; } },
      async requestInterval(instrument, interval) {
        requested.push(`${instrument.id}:${interval}`);
        return {
          ok: true,
          candles: [{
            date: '2026-08-17T09:15:00+05:30',
            totals: { buy: { volume: 2 }, sell: { volume: 1 } },
            max: { buy: { volume: 2 }, sell: { volume: 1 } },
            footprint: [{ level: 1, buy: { volume: 2 }, sell: { volume: 1 } }],
          }],
        };
      },
      async requestOhlc() {
        return { ok: true, bars: [{ time: '2026-08-17T09:15:00+05:30', open: 1, high: 1, low: 1, close: 1, volume: 1, oi: 1 }] };
      },
    };
    const supervisor = new Supervisor({
      cfg: baseCfg(),
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink,
      auth: mockAuth(),
      client,
      now: () => Date.parse('2026-08-17T10:00:00+05:30'),
    });
    supervisor.liveConfig = { email: 'a@b.c', password: 'pw' };
    const y = inst('MCX:FUTURE:CRUDEOIL-I', ['2m'], 2);
    await supervisor.reconcile([y]);
    const wrote = await supervisor.sampleDue(true);
    assert.ok(requested.includes('MCX:FUTURE:CRUDEOIL-I:2m'));
    assert.equal(wrote > 0, true);
    assert.equal(supervisor.instrumentState.get(y.slot).backfilledSessionDate, '2026-08-17');
  });

  it('requests only the timeframes listed on each instrument', async () => {
    const requested = [];
    const created = [];
    const supervisor = new Supervisor({
      cfg: baseCfg(),
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink: {
        async ensureStaticTabs() {},
        async ensureInstrument(instrument) {
          created.push({ slot: instrument.slot, symbol: instrument.symbol, intervals: [...instrument.intervals] });
        },
        dropInstrument() {},
        async retainSession() { return 0; },
        async writeRows() { return 0; },
      },
      auth: mockAuth(),
      client: {
        isOpen: () => true,
        ws: { readyState: 1 },
        dropSymbol() {},
        async disconnect() {},
        async connect() {},
        ohlcCollector: { getBars() { return []; } },
        async requestInterval(instrument, interval) {
          requested.push(`${instrument.id}:${interval}`);
          return { ok: true, candles: [] };
        },
        async requestOhlc() { return { ok: true, bars: [] }; },
      },
      now: () => Date.parse('2026-08-17T10:00:00+05:30'),
    });
    supervisor.liveConfig = { email: 'a@b.c', password: 'pw' };
    const nifty = inst('NSE:FUTURE:NIFTY-I', ['5m', '10m'], 1);
    const crude = inst('MCX:FUTURE:CRUDEOIL-I', ['15m'], 2);
    await supervisor.reconcile([nifty, crude]);
    await supervisor.sampleDue(true);
    assert.deepEqual(created, [
      { slot: 1, symbol: 'NIFTY-I', intervals: ['5m', '10m'] },
      { slot: 2, symbol: 'CRUDEOIL-I', intervals: ['15m'] },
    ]);
    assert.deepEqual(requested.sort(), [
      'MCX:FUTURE:CRUDEOIL-I:15m',
      'NSE:FUTURE:NIFTY-I:10m',
      'NSE:FUTURE:NIFTY-I:5m',
    ]);
  });

  it('does not request data when an instrument has no timeframes', async () => {
    const requested = [];
    const created = [];
    const supervisor = new Supervisor({
      cfg: baseCfg(),
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink: {
        async ensureStaticTabs() {},
        async ensureInstrument(instrument) {
          created.push({ slot: instrument.slot, symbol: instrument.symbol, intervals: [...instrument.intervals] });
        },
        dropInstrument() {},
        async retainSession() { return 0; },
        async writeRows() { return 0; },
      },
      auth: mockAuth(),
      client: {
        isOpen: () => true,
        ws: { readyState: 1 },
        dropSymbol() {},
        async disconnect() {},
        async connect() {},
        ohlcCollector: { getBars() { return []; } },
        async requestInterval(instrument, interval) {
          requested.push(`${instrument.id}:${interval}`);
          return { ok: true, candles: [] };
        },
        async requestOhlc() { return { ok: true, bars: [] }; },
      },
      now: () => Date.parse('2026-08-17T10:00:00+05:30'),
    });
    supervisor.liveConfig = { email: 'a@b.c', password: 'pw' };
    await supervisor.reconcile([inst('NSE:FUTURE:NIFTY-I', [], 1)]);
    const wrote = await supervisor.sampleDue(true);
    assert.deepEqual(created, [{ slot: 1, symbol: 'NIFTY-I', intervals: [] }]);
    assert.deepEqual(requested, []);
    assert.equal(wrote, 0);
  });

  it('hot-swaps timeframes on a slot and overwrites those tabs', async () => {
    const created = [];
    const dropped = [];
    const supervisor = new Supervisor({
      cfg: baseCfg(),
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink: {
        async ensureStaticTabs() {},
        async ensureInstrument(instrument) {
          created.push({ slot: instrument.slot, symbol: instrument.symbol, intervals: [...instrument.intervals] });
        },
        dropInstrument(instrument) {
          dropped.push({ slot: instrument.slot, symbol: instrument.symbol, intervals: [...instrument.intervals] });
        },
        async retainSession() { return 0; },
        async writeRows() { return 0; },
      },
      auth: mockAuth(),
      client: { isOpen: () => false, dropSymbol() {}, async disconnect() {}, async connect() {} },
      now: () => Date.parse('2026-08-17T10:00:00+05:30'),
    });

    const first = inst('NSE:FUTURE:NIFTY-I', ['2m', '3m', '5m'], 1);
    const next = inst('NSE:FUTURE:NIFTY-I', ['5m', '10m'], 1);
    await supervisor.reconcile([first]);
    await supervisor.reconcile([next]);

    assert.deepEqual(created, [
      { slot: 1, symbol: 'NIFTY-I', intervals: ['2m', '3m', '5m'] },
      { slot: 1, symbol: 'NIFTY-I', intervals: ['5m', '10m'] },
    ]);
    assert.deepEqual(dropped, [{ slot: 1, symbol: 'NIFTY-I', intervals: ['5m', '10m'] }]);
    assert.equal(supervisor.instrumentState.get(first.slot).backfilledSessionDate, null);
    assert.deepEqual(supervisor.liveInstruments[0].intervals, ['5m', '10m']);
  });

  it('drops previous-day sheet rows when the IST date changes', async () => {
    const retained = [];
    const x = inst('NSE:FUTURE:NIFTY-I', ['2m', '3m', '5m'], 1);
    let nowMs = Date.parse('2026-08-17T10:00:00+05:30');
    const supervisor = new Supervisor({
      cfg: baseCfg(),
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink: {
        async ensureStaticTabs() {},
        async ensureInstrument() {},
        dropInstrument() {},
        async retainSession(instrument, dateStr) {
          retained.push({ slot: instrument.slot, symbol: instrument.symbol, dateStr, intervals: [...instrument.intervals] });
          return dateStr === '2026-08-18' ? 4 : 0;
        },
        async writeRows() { return 0; },
      },
      auth: mockAuth(),
      client: { isOpen: () => false, dropSymbol() {}, async disconnect() {}, async connect() {} },
      now: () => nowMs,
    });

    await supervisor.reconcile([x]);
    assert.equal(retained.at(-1).dateStr, '2026-08-17');
    assert.deepEqual(retained.at(-1).intervals, ['2m', '3m', '5m']);
    assert.equal(supervisor.instrumentState.get(x.slot).retainedDate, '2026-08-17');

    nowMs = Date.parse('2026-08-18T08:00:00+05:30');
    const dropped = await supervisor.retainCurrentDay();
    assert.equal(dropped, 4);
    assert.equal(retained.at(-1).dateStr, '2026-08-18');
    assert.equal(supervisor.instrumentState.get(x.slot).retainedDate, '2026-08-18');
  });

  it('requests only intervals whose current candle can have closed', async () => {
    let nowMs = Date.parse('2026-08-17T10:00:03+05:30');
    const requested = [];
    const x = inst('NSE:FUTURE:NIFTY-I', ['2m', '5m'], 1);
    const sink = {
      async ensureStaticTabs() {},
      async ensureInstrument() {},
      dropInstrument() {},
      async retainSession() { return 0; },
      async writeRows() { return 0; },
    };
    const client = {
      isOpen: () => true,
      ws: { readyState: 1 },
      dropSymbol() {},
      async disconnect() {},
      async connect() {},
      ohlcCollector: { getBars() { return []; } },
      async requestInterval(instrument, interval) {
        requested.push(interval);
        const rolled = interval === '2m' && nowMs >= Date.parse('2026-08-17T10:02:02+05:30');
        return {
          ok: true,
          candles: [{
            date: rolled
              ? '2026-08-17T10:02:00+05:30'
              : '2026-08-17T10:00:00+05:30',
          }],
        };
      },
      async requestOhlc() { return { ok: true, bars: [] }; },
    };
    const cfg = { ...baseCfg(), sampleMs: 5_000 };
    const supervisor = new Supervisor({
      cfg,
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink,
      auth: mockAuth(),
      client,
      now: () => nowMs,
    });
    supervisor.liveConfig = { email: 'a@b.c', password: 'pw' };
    await supervisor.reconcile([x]);

    await supervisor.sampleDue(true);
    assert.deepEqual(requested.sort(), ['2m', '5m']);

    requested.length = 0;
    nowMs = Date.parse('2026-08-17T10:00:08+05:30');
    await supervisor.sampleDue(false);
    assert.deepEqual(requested, []);

    nowMs = Date.parse('2026-08-17T10:02:02+05:30');
    await supervisor.sampleDue(false);
    assert.deepEqual(requested, ['2m']);
  });

  it('keeps SAMPLE_MS on a start-to-start cadence when a sample overruns', async () => {
    const startedAt = Date.parse('2026-08-17T10:00:00+05:30');
    let nowMs = startedAt;
    const x = inst('NSE:FUTURE:NIFTY-I', ['2m'], 1);
    const supervisor = new Supervisor({
      cfg: { ...baseCfg(), sampleMs: 5_000 },
      log: silentLog(),
      configSheet: { read: async () => ({}) },
      sink: {
        async ensureStaticTabs() {},
        async ensureInstrument() {},
        dropInstrument() {},
        async retainSession() { return 0; },
        async writeRows() { return 0; },
      },
      auth: mockAuth(),
      client: {
        isOpen: () => true,
        ws: { readyState: 1 },
        dropSymbol() {},
        async disconnect() {},
        async connect() {},
        ohlcCollector: { getBars() { return []; } },
        async requestInterval() {
          nowMs += 6_200;
          return { ok: false, candles: [], error: 'test' };
        },
        async requestOhlc() { return { ok: true, bars: [] }; },
      },
      now: () => nowMs,
    });
    supervisor.liveConfig = { email: 'a@b.c', password: 'pw' };
    await supervisor.reconcile([x]);

    await supervisor.sampleDue(true);

    assert.equal(supervisor.nextSampleAt, startedAt + 10_000);
  });
});
