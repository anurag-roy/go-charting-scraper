import fs from 'node:fs';
import WebSocket from 'ws';
import {
  configFingerprint,
  configSummary,
  instrumentIntervals,
  isUsableConfig,
  reconcileInstruments,
} from './instruments.js';
import { sheetTabName } from './columns.js';
import { earliestOpenMs, workForInstrument } from './market.js';
import { formatIst, istDateString, sessionDatesFor } from './session.js';
import { sampleInstruments } from './collect.js';
import { writeStatus } from './log.js';
import { interruptibleSleep } from './util.js';
import { buildWsUrl } from './cognito.js';

export class Supervisor {
  constructor({
    cfg,
    log,
    configSheet,
    sink,
    csvSink,
    auth,
    client,
    now = () => Date.now(),
  }) {
    this.cfg = cfg;
    this.log = log;
    this.configSheet = configSheet;
    this.sink = sink;
    this.csvSink = csvSink;
    this.auth = auth;
    this.client = client;
    this.now = now;

    this.stopping = false;
    this.liveConfig = null;
    this.liveFingerprint = '';
    this.liveInstruments = [];
    this.instrumentState = new Map();
    this.sampleN = 0;
    this.nextSampleAt = 0;
    this.lastError = null;
    this.lastSampleAt = null;
    this.lastConfigAt = null;
    this.wsBackoffMs = 1000;
    this.wsBackoffUntil = 0;
    this.wakeSample = [];
    this.wakeConfig = [];
    this.loops = [];
    this._queue = Promise.resolve();
  }

  #withLock(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  stop() {
    this.stopping = true;
    this.#wakeAll();
  }

  #wakeAll() {
    for (const fn of [...this.wakeSample, ...this.wakeConfig]) {
      try { fn(); } catch { /* ignore */ }
    }
    this.wakeSample = [];
    this.wakeConfig = [];
  }

  #wakeSampleLoop() {
    for (const fn of this.wakeSample) {
      try { fn(); } catch { /* ignore */ }
    }
    this.wakeSample = [];
  }

  async #sleep(ms, bucket) {
    await interruptibleSleep(ms, {
      isStopped: () => this.stopping,
      onRegister: (cancel) => bucket.push(cancel),
    });
  }

  secrets() {
    return [
      this.liveConfig?.email,
      this.liveConfig?.password,
      ...(this.auth?.getSecrets?.() || []),
    ];
  }

  #status(extra = {}) {
    const payload = {
      updatedAt: new Date(this.now()).toISOString(),
      email: this.liveConfig?.email || '',
      instruments: this.liveInstruments.map((i) => ({
        slot: i.slot,
        id: i.id,
        intervals: instrumentIntervals(i),
        tabs: instrumentIntervals(i).map((_, idx) => sheetTabName(i.slot, idx)),
      })),
      lastConfigAt: this.lastConfigAt,
      lastSampleAt: this.lastSampleAt,
      lastError: this.lastError,
      ws: this.client?.isOpen?.() ? 'open' : 'closed',
      ...extra,
    };
    try { writeStatus(this.cfg.statusPath, payload); } catch (err) {
      this.log.warn('failed to write status.json', err);
    }
  }

  async run() {
    this.log.info('starting 24x7 scraper', {
      sheet: this.cfg.sheetId,
      configTab: this.cfg.configTab,
      configPollMs: this.cfg.configPollMs,
      sampleMs: this.cfg.sampleMs,
    });
    this.loops = [
      this.#configLoop(),
      this.#sampleLoop(),
    ];
    await Promise.all(this.loops);
    await this.#shutdown();
  }

  async runOnce() {
    await this.refreshConfig();
    if (!isUsableConfig(this.liveConfig)) {
      throw new Error('config sheet is missing email, password, or instruments with candle timeframes');
    }
    await this.sampleDue(true);
    await this.#shutdown();
  }

  async #configLoop() {
    while (!this.stopping) {
      try {
        await this.refreshConfig();
      } catch (err) {
        this.lastError = { at: new Date().toISOString(), message: String(err?.message || err) };
        this.log.error('config poll failed; keeping last good config', err);
        this.#status();
      }
      await this.#sleep(this.cfg.configPollMs, this.wakeConfig);
    }
  }

  async #sampleLoop() {
    while (!this.stopping) {
      try {
        if (isUsableConfig(this.liveConfig)) {
          await this.sampleDue(false);
        }
      } catch (err) {
        this.lastError = { at: new Date().toISOString(), message: String(err?.message || err) };
        this.log.error('sample loop failed', err);
        this.#status();
      }
      const wait = this.#nextSampleWait();
      await this.#sleep(wait, this.wakeSample);
    }
  }

  #nextSampleWait() {
    const nowMs = this.now();
    const due = this.#dueInstruments(nowMs);
    if (due.length) {
      return Math.max(0, this.nextSampleAt - nowMs);
    }
    const nextOpen = earliestOpenMs(this.liveInstruments, nowMs);
    const untilOpen = Math.max(5_000, nextOpen - nowMs);
    return Math.min(untilOpen, 30_000);
  }

  #dueInstruments(nowMs) {
    const extra = {
      afterCloseBufferMs: this.cfg.afterCloseBufferMs,
      graceMs: this.cfg.closeGraceMs,
    };
    const due = [];
    for (const inst of this.liveInstruments) {
      if (!instrumentIntervals(inst).length) continue;
      const state = this.#stateFor(inst);
      const work = workForInstrument(inst, nowMs, state, extra);
      if (work.action !== 'idle') due.push({ instrument: inst, work, state });
    }
    return due;
  }

  async refreshConfig() {
    const parsed = await this.configSheet.read();
    for (const err of parsed.errors || []) this.log.error(err);
    for (const warn of parsed.warnings || []) this.log.warn(warn);
    if (!parsed.email || !parsed.password) {
      if (!this.liveConfig) this.log.warn('config sheet is missing email/password');
      else this.log.warn('config sheet missing email/password; keeping last good credentials');
      if (this.liveConfig && parsed.instruments?.length) {
        await this.#withLock(() => this.reconcile(parsed.instruments));
      }
      this.lastConfigAt = new Date().toISOString();
      this.#status();
      return this.liveConfig;
    }
    if (!parsed.instruments?.length && parsed.errors?.length) {
      this.log.warn('no valid instruments in config; keeping last good list');
      this.lastConfigAt = new Date().toISOString();
      this.#status();
      return this.liveConfig;
    }

    const next = {
      email: parsed.email,
      password: parsed.password,
      instruments: parsed.instruments,
    };
    const fp = configFingerprint(next);
    const first = !this.liveConfig;
    const changed = fp !== this.liveFingerprint;
    this.liveConfig = next;
    this.liveFingerprint = fp;
    this.lastConfigAt = new Date().toISOString();

    if (first || changed) {
      this.log.info('config applied', configSummary(next));
    }

    await this.#withLock(async () => {
      const authResult = await this.auth.ensure(next.email, next.password);
      if (authResult.changed && this.client?.isOpen?.()) {
        await this.#reconnectWs('auth changed');
      }
      await this.reconcile(next.instruments);
    });
    this.#status();
    return this.liveConfig;
  }

  #stateKey(inst) {
    return inst?.slot ?? inst?.id;
  }

  #stateFor(inst) {
    const key = this.#stateKey(inst);
    let state = this.instrumentState.get(key);
    if (!state) {
      state = { backfilledSessionDate: null, retainedDate: null, intervalNextAt: new Map() };
      this.instrumentState.set(key, state);
    }
    if (!(state.intervalNextAt instanceof Map)) state.intervalNextAt = new Map();
    return state;
  }

  #intervalsForSample({ instrument, work, state }, nowMs, force) {
    const intervals = instrumentIntervals(instrument);
    if (force || work.action === 'backfill') return intervals;
    return intervals.filter((interval) => nowMs >= (state.intervalNextAt.get(interval) ?? -Infinity));
  }

  #earliestIntervalFetchAt(nowMs) {
    let earliest = Infinity;
    for (const inst of this.liveInstruments) {
      const schedule = this.instrumentState.get(this.#stateKey(inst))?.intervalNextAt;
      if (!(schedule instanceof Map)) continue;
      for (const value of schedule.values()) {
        const t = Number(value);
        if (Number.isFinite(t) && t > nowMs && t < earliest) earliest = t;
      }
    }
    return earliest;
  }

  #scheduleNextSample(startedAt) {
    const nowMs = this.now();
    const periods = Math.max(1, Math.ceil(Math.max(0, nowMs - startedAt) / this.cfg.sampleMs));
    const cadenceAt = startedAt + periods * this.cfg.sampleMs;
    const intervalAt = this.#earliestIntervalFetchAt(nowMs);
    this.nextSampleAt = Number.isFinite(intervalAt)
      ? Math.min(cadenceAt, intervalAt)
      : cadenceAt;
  }

  async #startSlot(inst) {
    await this.sink.ensureInstrument(inst);
    this.instrumentState.set(this.#stateKey(inst), {
      backfilledSessionDate: null,
      retainedDate: null,
      intervalNextAt: new Map(),
    });
    this.nextSampleAt = 0;
    this.#wakeSampleLoop();
  }

  async reconcile(instruments) {
    await this.sink.ensureStaticTabs?.();
    const nextIds = new Set((instruments || []).map((i) => i.id));
    const { added, removed, replaced, updated } = reconcileInstruments(this.liveInstruments, instruments);
    for (const inst of removed) {
      this.log.info('stop monitoring', `slot ${inst.slot}`, inst.id);
      this.sink.dropInstrument(inst);
      this.instrumentState.delete(this.#stateKey(inst));
      if (!nextIds.has(inst.id)) this.client?.dropSymbol(inst.id);
    }
    await Promise.all(replaced.map(async ({ from, to }) => {
      this.log.info('replace slot', to.slot, `${from.id} -> ${to.id}`);
      this.sink.dropInstrument(from);
      this.instrumentState.delete(this.#stateKey(from));
      if (!nextIds.has(from.id)) this.client?.dropSymbol(from.id);
      await this.#startSlot(to);
    }));
    await Promise.all(added.map(async (inst) => {
      const ivs = instrumentIntervals(inst);
      this.log.info('start monitoring', `slot ${inst.slot}`, inst.id, ivs.join(', '));
      await this.#startSlot(inst);
    }));
    for (const inst of updated) {
      this.log.info('update intervals', `slot ${inst.slot}`, inst.id, instrumentIntervals(inst).join(', ') || '(none)');
      this.sink.dropInstrument(inst);
      await this.sink.ensureInstrument(inst);
      const state = this.#stateFor(inst);
      state.backfilledSessionDate = null;
      state.retainedDate = null;
      state.intervalNextAt = new Map();
      this.instrumentState.set(this.#stateKey(inst), state);
      this.nextSampleAt = 0;
      this.#wakeSampleLoop();
    }
    this.liveInstruments = instruments;
    await this.retainCurrentDay();
    if (!instruments.length && this.client?.isOpen?.()) {
      await this.client.disconnect();
    }
  }

  /** Drop sheet rows that are not from today's IST calendar date. */
  async retainCurrentDay() {
    const today = istDateString(new Date(this.now()));
    const dropped = await Promise.all(this.liveInstruments.map(async (inst) => {
      const state = this.#stateFor(inst);
      if (state.retainedDate === today) return 0;
      const n = await this.sink.retainSession(inst, today);
      if (n > 0) this.log.info(`removed ${n} previous-day row(s) for ${inst.id}`);
      state.retainedDate = today;
      this.instrumentState.set(this.#stateKey(inst), state);
      return n;
    }));
    return dropped.reduce((sum, n) => sum + n, 0);
  }

  async sampleDue(force) {
    return this.#withLock(async () => {
      await this.retainCurrentDay();
      const nowMs = this.now();
      const due = this.#dueInstruments(nowMs);
      if (!due.length) {
        if (this.client?.isOpen?.()) await this.client.disconnect();
        return 0;
      }
      const needImmediate = force || due.some((d) => d.work.action === 'backfill') || this.nextSampleAt === 0;
      if (!needImmediate && nowMs < this.nextSampleAt) return 0;

      const intervalsBySlot = new Map();
      for (const item of due) {
        const intervals = this.#intervalsForSample(item, nowMs, force);
        if (intervals.length) intervalsBySlot.set(this.#stateKey(item.instrument), intervals);
      }
      const planned = due.filter((item) => intervalsBySlot.has(this.#stateKey(item.instrument)));
      if (!planned.length) {
        this.#scheduleNextSample(nowMs);
        return 0;
      }

      await this.auth.ensure(this.liveConfig.email, this.liveConfig.password);

      await this.#ensureWs();

      this.sampleN += 1;
      const sampled_at_utc = new Date(nowMs).toISOString();
      const sampled_at_ist = formatIst(new Date(nowMs));
      const samplePlan = planned.map((d) => {
        const intervals = intervalsBySlot.get(this.#stateKey(d.instrument));
        return `${d.instrument.id}/${d.work.action}:${intervals.join(',')}`;
      }).join(', ');
      this.log.info(`sample ${this.sampleN}`, samplePlan);

      const { rows, summaries } = await sampleInstruments({
        client: this.client,
        instruments: planned.map((d) => d.instrument),
        intervalsFor: (inst) => intervalsBySlot.get(this.#stateKey(inst)),
        sessionDatesFor,
        sessionOptsFor: (inst) => planned.find(
          (d) => this.#stateKey(d.instrument) === this.#stateKey(inst),
        )?.work.hours,
        nowMs,
        sampled_at_utc,
        sampled_at_ist,
        sample_n: this.sampleN,
      });

      for (const s of summaries) {
        this.log.info(
          `  ${s.id} ${s.interval}: closed=${s.closed}/${s.candles} ohlc=${s.ohlcBars ?? 0} miss=${s.ohlcMiss ?? 0}${s.error ? ` err=${s.error}` : ''}`,
        );
      }

      let wrote = 0;
      try {
        wrote += await this.sink.writeRows(rows) || 0;
        if (this.csvSink) wrote += this.csvSink.writeRows(rows) || 0;
      } catch (err) {
        this.log.error('write failed', err);
        throw err;
      }

      for (const summary of summaries) {
        const item = planned.find((d) => d.instrument.id === summary.id);
        if (!item) continue;
        const schedule = this.#stateFor(item.instrument).intervalNextAt;
        if (Number.isFinite(summary.nextFetchAt)) schedule.set(summary.interval, summary.nextFetchAt);
        else schedule.delete(summary.interval);
      }
      for (const d of planned) {
        const state = this.#stateFor(d.instrument);
        state.backfilledSessionDate = d.work.persistDate;
        this.instrumentState.set(this.#stateKey(d.instrument), state);
      }
      this.lastSampleAt = sampled_at_utc;
      this.lastError = null;
      this.#scheduleNextSample(nowMs);
      this.wsBackoffMs = 1000;
      this.log.info(`wrote ${wrote} new closed-candle row(s)`);
      this.#status({ lastWrote: wrote });
      return wrote;
    });
  }

  async #ensureWs() {
    const nowMs = this.now();
    if (this.client.isOpen() && this.client.ws?.readyState === WebSocket.OPEN) return;
    if (nowMs < this.wsBackoffUntil) {
      throw new Error('ws backoff');
    }
    await this.#reconnectWs('not open');
  }

  async #reconnectWs(reason) {
    const token = this.auth.tokens?.idToken;
    if (!token) throw new Error('no auth token for websocket');
    this.log.info('connecting websocket', reason);
    try {
      await this.client.connect(buildWsUrl(this.cfg.wsHost, token, this.cfg.wsTag));
      this.wsBackoffMs = 1000;
      this.wsBackoffUntil = 0;
    } catch (err) {
      this.wsBackoffUntil = this.now() + this.wsBackoffMs;
      this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, 60_000);
      throw err;
    }
  }

  async #shutdown() {
    this.log.info('shutting down');
    try { await this.client?.disconnect(); } catch { /* ignore */ }
    this.#status({ ws: 'closed' });
  }
}

export function ensureLogDir(cfg) {
  fs.mkdirSync(cfg.outDir, { recursive: true });
}
