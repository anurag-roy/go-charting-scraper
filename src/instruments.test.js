import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  configFingerprint,
  isUsableConfig,
  MAX_INSTRUMENTS,
  normalizeConfigKey,
  parseConfigRows,
  parseInstrumentId,
  parseIntervalCells,
  parseIntervalToken,
  reconcileInstruments,
} from './instruments.js';

describe('parseInstrumentId', () => {
  it('parses EXCHANGE:CATEGORY:SYMBOL', () => {
    assert.deepEqual(parseInstrumentId('NSE:FUTURE:NIFTY-I'), {
      exchange: 'NSE',
      segment: 'FUTURE',
      symbol: 'NIFTY-I',
      id: 'NSE:FUTURE:NIFTY-I',
    });
  });

  it('accepts slashes and mixed case', () => {
    assert.equal(parseInstrumentId('mcx/future/CRUDEOIL-I').id, 'MCX:FUTURE:CRUDEOIL-I');
  });

  it('keeps option symbols intact', () => {
    assert.equal(
      parseInstrumentId('NSE:OPTIONS:NIFTY2681824300CE').symbol,
      'NIFTY2681824300CE',
    );
  });

  it('rejects unknown exchanges', () => {
    assert.throws(() => parseInstrumentId('NYSE:FUTURE:FOO'), /unsupported exchange/);
  });
});

describe('parseIntervalToken', () => {
  it('normalizes minute bars', () => {
    assert.equal(parseIntervalToken('2m'), '2m');
    assert.equal(parseIntervalToken('10m'), '10m');
    assert.equal(parseIntervalToken(' 5 M '), '5m');
    assert.equal(parseIntervalToken('15min'), '15m');
    assert.equal(parseIntervalToken('15'), '15m');
    assert.equal(parseIntervalToken(''), '');
  });

  it('rejects values that are not minute bars', () => {
    assert.throws(() => parseIntervalToken('1h'), /unsupported interval/);
    assert.throws(() => parseIntervalToken('xyz'), /unsupported interval/);
  });
});

describe('parseIntervalCells', () => {
  it('keeps only the given timeframes, with no defaults', () => {
    assert.deepEqual(parseIntervalCells(['5m', '10m']).intervals, ['5m', '10m']);
    assert.deepEqual(parseIntervalCells([]).intervals, []);
    assert.deepEqual(parseIntervalCells(['', '']).intervals, []);
    assert.deepEqual(parseIntervalCells(['2m', '', '5m']).intervals, ['2m', '5m']);
  });

  it('skips invalid cells and keeps valid ones', () => {
    const parsed = parseIntervalCells(['5m', 'nope', '10m']);
    assert.deepEqual(parsed.intervals, ['5m', '10m']);
    assert.equal(parsed.errors.length, 1);
  });

  it('splits comma-separated cells and de-duplicates', () => {
    assert.deepEqual(parseIntervalCells(['2m, 3m', '2m']).intervals, ['2m', '3m']);
  });

  it('treats bare numbers from spreadsheet cells as minutes', () => {
    assert.deepEqual(parseIntervalCells([5, 10]).intervals, ['5m', '10m']);
  });
});

describe('parseConfigRows', () => {
  it('reads the config sheet layout case-insensitively', () => {
    const cfg = parseConfigRows([
      ['email', 'trader@example.com'],
      ['password', 'secret'],
      ['Instrument1', 'NSE:FUTURE:NIFTY-I', '2m', '3m', '5m'],
      ['Instrument2', 'MCX:FUTURE:CRUDEOIL-I', '2m', '3m', '5m'],
      ['Instrument3', 'NSE:OPTIONS:NIFTY2681824300CE', '2m', '3m', '5m'],
      ['Instrument4', 'NSE:FUTURE:BANKNIFTY-I', '2m', '3m', '5m'],
      ['Instrument5', 'BSE:FUTURE:SENSEX-I', '2m', '3m', '5m'],
      ['Instrument6', 'MCX:FUTURE:GOLD-I', '2m', '3m', '5m'],
      ['Instrument7', 'NSE:FUTURE:SHOULD-IGNORE', '2m'],
    ]);
    assert.equal(MAX_INSTRUMENTS, 6);
    assert.equal(cfg.email, 'trader@example.com');
    assert.equal(cfg.password, 'secret');
    assert.deepEqual(cfg.instruments.map((i) => i.id), [
      'NSE:FUTURE:NIFTY-I',
      'MCX:FUTURE:CRUDEOIL-I',
      'NSE:OPTIONS:NIFTY2681824300CE',
      'NSE:FUTURE:BANKNIFTY-I',
      'BSE:FUTURE:SENSEX-I',
      'MCX:FUTURE:GOLD-I',
    ]);
    assert.deepEqual(cfg.instruments[0].intervals, ['2m', '3m', '5m']);
    assert.deepEqual(cfg.errors, []);
    assert.deepEqual(cfg.warnings, []);
  });

  it('reads per-instrument candle timeframes from columns C onward', () => {
    const cfg = parseConfigRows([
      ['email', 'trader@example.com'],
      ['password', 'secret'],
      ['Instrument1', 'NSE:FUTURE:NIFTY-I', '2m', '3m', '5m'],
      ['Instrument2', 'NSE:OPTIONS:NIFTY2681824100CE', '5m', '10m'],
      ['Instrument3', 'NSE:OPTIONS:NIFTY2681824300CE', '15m'],
      ['Instrument4'],
      ['Instrument5'],
      ['Instrument6'],
    ]);
    assert.deepEqual(
      cfg.instruments.map((i) => ({ id: i.id, intervals: i.intervals })),
      [
        { id: 'NSE:FUTURE:NIFTY-I', intervals: ['2m', '3m', '5m'] },
        { id: 'NSE:OPTIONS:NIFTY2681824100CE', intervals: ['5m', '10m'] },
        { id: 'NSE:OPTIONS:NIFTY2681824300CE', intervals: ['15m'] },
      ],
    );
  });

  it('does not generate data when no timeframes are given', () => {
    const cfg = parseConfigRows([
      ['email', 'a@b.c'],
      ['password', 'x'],
      ['Instrument1', 'NSE:FUTURE:NIFTY-I'],
      ['Instrument2', 'MCX:FUTURE:CRUDEOIL-I', '', '', ''],
    ]);
    assert.deepEqual(cfg.instruments, []);
    assert.equal(cfg.warnings.length, 2);
    assert.equal(isUsableConfig(cfg), false);
  });

  it('skips duplicates and invalid slots without dropping valid ones', () => {
    const cfg = parseConfigRows([
      ['Email', 'a@b.c'],
      ['Password', 'x'],
      ['instrument 1', 'NSE:FUTURE:NIFTY-I', '2m'],
      ['instrument2', 'NSE:FUTURE:NIFTY-I', '5m'],
      ['instrument3', 'NOPE', '2m'],
    ]);
    assert.deepEqual(cfg.instruments.map((i) => i.id), ['NSE:FUTURE:NIFTY-I']);
    assert.deepEqual(cfg.instruments[0].intervals, ['2m']);
    assert.equal(cfg.errors.length, 1);
  });

  it('normalizes keys by stripping spaces and underscores', () => {
    assert.equal(normalizeConfigKey('Instrument_1'), 'instrument1');
  });
});

describe('reconcileInstruments', () => {
  const x = { ...parseInstrumentId('NSE:FUTURE:NIFTY-I'), intervals: ['2m', '3m', '5m'] };
  const y = { ...parseInstrumentId('MCX:FUTURE:CRUDEOIL-I'), intervals: ['5m'] };

  it('detects X -> Y without implying deletion of X sheets', () => {
    const { added, removed, kept } = reconcileInstruments([x], [y]);
    assert.deepEqual(added.map((i) => i.id), [y.id]);
    assert.deepEqual(removed.map((i) => i.id), [x.id]);
    assert.deepEqual(kept, []);
  });

  it('detects timeframe changes on a kept instrument', () => {
    const next = { ...x, intervals: ['5m', '10m'] };
    const { added, removed, kept, updated } = reconcileInstruments([x], [next]);
    assert.deepEqual(added, []);
    assert.deepEqual(removed, []);
    assert.equal(kept.length, 1);
    assert.deepEqual(updated.map((i) => i.intervals), [['5m', '10m']]);
  });

  it('changes fingerprint when the password changes', () => {
    const a = configFingerprint({ email: 'a', password: '1', instruments: [x] });
    const b = configFingerprint({ email: 'a', password: '2', instruments: [x] });
    assert.notEqual(a, b);
  });

  it('changes fingerprint when candle timeframes change', () => {
    const a = configFingerprint({ email: 'a', password: '1', instruments: [x] });
    const b = configFingerprint({
      email: 'a',
      password: '1',
      instruments: [{ ...x, intervals: ['5m', '10m'] }],
    });
    assert.notEqual(a, b);
  });
});
