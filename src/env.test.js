import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, parseSheetId, validateConfig } from './env.js';
import { redactText } from './redact.js';
import { isRetryableGoogleError, logTiming, timed, withRetry } from './util.js';
import { jwtExpMs, AuthSession } from './cognito.js';

describe('parseSheetId', () => {
  it('accepts a raw id or a full URL', () => {
    assert.equal(parseSheetId('abc-123_ID'), 'abc-123_ID');
    assert.equal(
      parseSheetId('https://docs.google.com/spreadsheets/d/1AbCDefGhIJklmn/edit#gid=0'),
      '1AbCDefGhIJklmn',
    );
  });
});

describe('loadConfig protoDir', () => {
  it('defaults to src/proto next to this module', () => {
    const prev = process.env.PROTO_DIR;
    delete process.env.PROTO_DIR;
    try {
      const cfg = loadConfig();
      assert.equal(path.basename(cfg.protoDir), 'proto');
      assert.ok(fs.existsSync(path.join(cfg.protoDir, 'footprint.proto')));
      assert.ok(fs.existsSync(path.join(cfg.protoDir, 'ohlc_bars.proto')));
    } finally {
      if (prev === undefined) delete process.env.PROTO_DIR;
      else process.env.PROTO_DIR = prev;
    }
  });
});

describe('validateConfig', () => {
  it('requires a sheet id and Google credentials, not GoCharting env vars', () => {
    const errs = validateConfig({
      sheetId: '',
      googleCredentialsPath: '',
      googleCredentialsJson: null,
      googleClientEmail: '',
      googlePrivateKey: '',
      configPollMs: 5000,
      sampleMs: 15000,
    });
    assert.ok(errs.some((e) => /GOOGLE_SHEET_ID/.test(e)));
    assert.ok(errs.some((e) => /credentials are missing/.test(e)));
    assert.ok(!errs.some((e) => /GOCHARTING_EMAIL/.test(e)));
  });
});

describe('redact', () => {
  it('strips secrets, JWTs, and token query params', () => {
    const out = redactText('user secret jwt eyJaa.bb.cc url?token=abc123', ['secret']);
    assert.equal(out.includes('secret'), false);
    assert.match(out, /\[JWT\]/);
    assert.match(out, /token=\[REDACTED\]/);
  });
});

describe('withRetry', () => {
  it('retries retryable Google errors then succeeds', async () => {
    let n = 0;
    const out = await withRetry(async () => {
      n += 1;
      if (n < 3) {
        const err = new Error('quota');
        err.code = 429;
        throw err;
      }
      return 7;
    }, { retries: 4, baseMs: 1, maxMs: 5 });
    assert.equal(out, 7);
    assert.equal(n, 3);
  });

  it('does not retry auth errors', async () => {
    await assert.rejects(
      () => withRetry(async () => {
        const err = new Error('forbidden');
        err.code = 403;
        throw err;
      }, { retries: 3, baseMs: 1 }),
      /forbidden/,
    );
  });

  it('detects 429 as retryable', () => {
    assert.equal(isRetryableGoogleError({ code: 429 }), true);
    assert.equal(isRetryableGoogleError({ code: 400 }), false);
  });
});

describe('logTiming', () => {
  it('writes a grep-friendly line and skips empty fields', () => {
    const lines = [];
    logTiming({ info: (s) => lines.push(s) }, 'sheets append', {
      tab: '1A',
      rows: 2,
      skip: '',
      ms: 41,
    });
    assert.equal(lines[0], 'timing sheets append tab=1A rows=2 ms=41');
  });

  it('no-ops when the logger has no info()', () => {
    logTiming({ warn() {} }, 'noop', { ms: 1 });
  });
});

describe('timed', () => {
  it('logs ms after success and rethrows after failure', async () => {
    const lines = [];
    const log = { info: (s) => lines.push(s) };
    const out = await timed(async () => 9, {
      log,
      label: 'sheets config_read',
      fields: { rows: 3 },
    });
    assert.equal(out, 9);
    assert.match(lines[0], /^timing sheets config_read rows=3 ms=\d+$/);

    await assert.rejects(
      () => timed(async () => { throw new Error('boom'); }, { log, label: 'cognito login' }),
      /boom/,
    );
    assert.match(lines[1], /^timing cognito login error=boom ms=\d+$/);
  });
});

describe('AuthSession', () => {
  it('keeps the previous session when new credentials fail', async () => {
    let calls = 0;
    const session = new AuthSession({
      log: { error() {}, warn() {} },
      cognito: async ({ username }) => {
        calls += 1;
        if (username === 'new@x') throw new Error('bad password');
        return { idToken: 'old', refreshToken: 'r', expMs: Date.now() + 60_000 };
      },
    });
    await session.login('old@x', 'a');
    const result = await session.ensure('new@x', 'b');
    assert.equal(result.changed, false);
    assert.equal(session.email, 'old@x');
    assert.equal(session.tokens.idToken, 'old');
    assert.equal(calls, 2);
  });

  it('decodes jwt exp', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1700000000 })).toString('base64url');
    assert.equal(jwtExpMs(`h.${payload}.s`), 1700000000 * 1000);
  });
});
