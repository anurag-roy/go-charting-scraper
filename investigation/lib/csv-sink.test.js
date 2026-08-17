import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CsvSink } from './csv-sink.js';
import { COLUMNS } from './columns.js';

describe('CsvSink', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxvol-csv-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a header, appends new closed rows, and skips duplicates', async () => {
    const file = path.join(dir, 'out.csv');
    const sink = new CsvSink(file);
    await sink.init();
    const header = fs.readFileSync(file, 'utf8').trim();
    assert.equal(header, COLUMNS.join(','));

    const n1 = sink.writeRows([
      { ok: true, interval: '2m', candle_time: 't1', open: 1, sample_n: 1 },
      { ok: true, interval: '3m', candle_time: 't1', open: 2, sample_n: 1 },
    ]);
    assert.equal(n1, 2);

    const n2 = sink.writeRows([
      { ok: true, interval: '2m', candle_time: 't1', open: 99, sample_n: 2 },
      { ok: true, interval: '5m', candle_time: 't1', open: 3, sample_n: 2 },
    ]);
    assert.equal(n2, 1);

    const sink2 = new CsvSink(file);
    await sink2.init();
    const n3 = sink2.writeRows([
      { ok: true, interval: '5m', candle_time: 't1', open: 3, sample_n: 3 },
      { ok: true, interval: '5m', candle_time: 't2', open: 4, sample_n: 3 },
    ]);
    assert.equal(n3, 1);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 5); // header + 4 unique rows
  });

  it('upgrades a prefix header when new columns are added', async () => {
    const file = path.join(dir, 'upgrade.csv');
    const old = COLUMNS.slice(0, 8);
    fs.writeFileSync(file, `${old.join(',')}\n2m,t-old\n`);
    const sink = new CsvSink(file);
    await sink.init();
    const header = fs.readFileSync(file, 'utf8').split('\n')[0];
    assert.equal(header, COLUMNS.join(','));
    const n = sink.writeRows([{ ok: true, interval: '2m', candle_time: 't-new' }]);
    assert.equal(n, 1);
  });

  it('renames a trailing vwap header to vwap1,vwap2', async () => {
    const file = path.join(dir, 'legacy-vwap.csv');
    const legacy = COLUMNS.slice(0, -2).concat(['vwap']);
    fs.writeFileSync(file, `${legacy.join(',')}\n`);
    const sink = new CsvSink(file);
    await sink.init();
    const header = fs.readFileSync(file, 'utf8').split('\n')[0];
    assert.equal(header, COLUMNS.join(','));
  });
});
