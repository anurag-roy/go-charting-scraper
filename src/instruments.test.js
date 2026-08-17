import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  configFingerprint,
  normalizeConfigKey,
  parseConfigRows,
  parseInstrumentId,
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

describe('parseConfigRows', () => {
  it('reads the config sheet layout case-insensitively', () => {
    const cfg = parseConfigRows([
      ['email', 'trader@example.com'],
      ['password', 'secret'],
      ['Instrument1', 'NSE:FUTURE:NIFTY-I'],
      ['Instrument2', 'MCX:FUTURE:CRUDEOIL-I'],
      ['Instrument3', 'NSE:OPTIONS:NIFTY2681824300CE'],
    ]);
    assert.equal(cfg.email, 'trader@example.com');
    assert.equal(cfg.password, 'secret');
    assert.deepEqual(cfg.instruments.map((i) => i.id), [
      'NSE:FUTURE:NIFTY-I',
      'MCX:FUTURE:CRUDEOIL-I',
      'NSE:OPTIONS:NIFTY2681824300CE',
    ]);
    assert.deepEqual(cfg.errors, []);
  });

  it('skips duplicates and invalid slots without dropping valid ones', () => {
    const cfg = parseConfigRows([
      ['Email', 'a@b.c'],
      ['Password', 'x'],
      ['instrument 1', 'NSE:FUTURE:NIFTY-I'],
      ['instrument2', 'NSE:FUTURE:NIFTY-I'],
      ['instrument3', 'NOPE'],
    ]);
    assert.deepEqual(cfg.instruments.map((i) => i.id), ['NSE:FUTURE:NIFTY-I']);
    assert.equal(cfg.errors.length, 1);
  });

  it('normalizes keys by stripping spaces and underscores', () => {
    assert.equal(normalizeConfigKey('Instrument_1'), 'instrument1');
  });
});

describe('reconcileInstruments', () => {
  const x = parseInstrumentId('NSE:FUTURE:NIFTY-I');
  const y = parseInstrumentId('MCX:FUTURE:CRUDEOIL-I');

  it('detects X -> Y without implying deletion of X sheets', () => {
    const { added, removed, kept } = reconcileInstruments([x], [y]);
    assert.deepEqual(added.map((i) => i.id), [y.id]);
    assert.deepEqual(removed.map((i) => i.id), [x.id]);
    assert.deepEqual(kept, []);
  });

  it('changes fingerprint when the password changes', () => {
    const a = configFingerprint({ email: 'a', password: '1', instruments: [x] });
    const b = configFingerprint({ email: 'a', password: '2', instruments: [x] });
    assert.notEqual(a, b);
  });
});
