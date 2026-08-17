import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetId, validateConfig } from './env.js';

describe('validateConfig', () => {
  const base = {
    email: 'a@b.c',
    password: 'x',
    writeCsv: false,
    sheetId: '',
    intervals: ['2m', '3m', '5m'],
    runMs: null,
    googleCredentialsPath: '',
    googleCredentialsJson: null,
    googleClientEmail: '',
    googlePrivateKey: '',
  };

  it('requires credentials and an output sink', () => {
    const missingAuth = validateConfig({ ...base, email: '', password: '' });
    assert.ok(missingAuth.some((e) => /GOCHARTING_EMAIL/.test(e)));
    const missingSink = validateConfig(base);
    assert.ok(missingSink.some((e) => /GOOGLE_SHEET_ID|WRITE_CSV/.test(e)));
  });

  it('allows CSV-only output even if a missing Google key path is set', () => {
    assert.deepEqual(
      validateConfig({
        ...base,
        writeCsv: true,
        googleCredentialsPath: '/tmp/does-not-exist-sa.json',
      }),
      [],
    );
  });

  it('requires Google credentials when a sheet is set', () => {
    const errs = validateConfig({ ...base, sheetId: 'abc' });
    assert.ok(errs.some((e) => /credentials are missing/.test(e)));
  });

  it('parses spreadsheet URLs', () => {
    assert.equal(
      parseSheetId('https://docs.google.com/spreadsheets/d/SheetId_123/edit?usp=sharing'),
      'SheetId_123',
    );
  });
});
