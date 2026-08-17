import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetId, validateConfig } from './env.js';
import { redactText } from './redact.js';
import { isRetryableGoogleError, withRetry } from './util.js';
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

describe('validateConfig', () => {
  it('requires a sheet id and Google credentials, not GoCharting env vars', () => {
    const errs = validateConfig({
      sheetId: '',
      googleCredentialsPath: '',
      googleCredentialsJson: null,
      googleClientEmail: '',
      googlePrivateKey: '',
      intervals: ['2m'],
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
