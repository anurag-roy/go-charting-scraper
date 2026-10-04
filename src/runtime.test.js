import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { acquireInstanceGuard } from './instance-guard.js';
import { cognitoInitiateAuth, AuthSession } from './cognito.js';
import { createSheetsApi } from './sheets.js';
import { FootprintClient } from './gocharting.js';
import { withRetry } from './util.js';

describe('request cancellation', () => {
  it('times out a Cognito response whose body never completes', async (t) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    await assert.rejects(cognitoInitiateAuth({
      username: 'fixture', password: 'fixture', timeoutMs: 50,
      fetchImpl: (_, options) => fetch(`http://127.0.0.1:${server.address().port}`, options),
    }), (err) => /TimeoutError|AbortError/.test(err.name));
  });

  it('does not start a password fallback after shutdown cancels a refresh', async () => {
    const controller = new AbortController();
    let calls = 0;
    const session = new AuthSession({
      signal: controller.signal,
      cognito: async () => { calls += 1; controller.abort(); throw controller.signal.reason; },
    });
    session.email = 'fixture'; session.password = 'fixture';
    session.tokens = { refreshToken: 'fixture' };
    await assert.rejects(session.refresh(), { name: 'AbortError' });
    assert.equal(calls, 1);
  });

  it('cancels a Google retry wait without another attempt', async () => {
    const controller = new AbortController();
    let calls = 0;
    const request = withRetry(async () => {
      calls += 1;
      const err = new Error('quota'); err.code = 429; throw err;
    }, { baseMs: 30_000, signal: controller.signal, onRetry: () => controller.abort() });
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(calls, 1);
  });

  for (const stage of ['token', 'Sheets']) {
    it(`bounds ${stage} requests through the actual Google auth transport`, async (t) => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const api = await createSheetsApi({
        httpTimeoutMs: 50,
        googleCredentialsJson: {
          type: 'service_account', client_email: 'fixture@example.invalid',
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        },
      });
      // AbortSignal timeout timers are unref'd; keep this isolated transport alive.
      const keeper = setTimeout(() => {}, 3000);
      t.after(() => clearTimeout(keeper));
      let calls = 0;
      api.context._options.auth.transporter.defaults.adapter = async (options) => {
        calls += 1;
        assert.equal(options.timeout, 50);
        assert.equal(options.retry, false);
        assert.equal(options.retryConfig.retry, 0);
        if (stage === 'Sheets' && options.url.hostname === 'oauth2.googleapis.com') {
          return { status: 200, data: { access_token: 'fixture', expires_in: 3600 }, headers: new Headers(), config: options };
        }
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      };
      await assert.rejects(api.spreadsheets.values.get({ spreadsheetId: 'fixture', range: 'config!A1:E8' }), /timeout|aborted/i);
      assert.equal(calls, stage === 'token' ? 1 : 2);
    });
  }

  it('cancels an active Google token request on shutdown', async (t) => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const controller = new AbortController();
    const api = await createSheetsApi({
      signal: controller.signal, httpTimeoutMs: 20_000,
      googleCredentialsJson: { type: 'service_account', client_email: 'fixture@example.invalid',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    });
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    api.context._options.auth.transporter.defaults.adapter = (options) => new Promise((resolve, reject) => {
      started();
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const keeper = setTimeout(() => {}, 3000);
    t.after(() => clearTimeout(keeper));
    const pending = api.spreadsheets.values.get({ spreadsheetId: 'fixture', range: 'config!A1:E8' });
    const rejected = assert.rejects(pending, /abort/i);
    await ready;
    controller.abort();
    await rejected;
    await assert.rejects(api.spreadsheets.values.get({ spreadsheetId: 'fixture', range: 'config!A1:E8' }), /abort/i);
  });
});

describe('socket recovery', () => {
  async function localClient(t, { autoPong = true, heartbeatMs = 1000 } = {}) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong });
    await once(server, 'listening');
    const controller = new AbortController();
    const client = new FootprintClient({ FP: {}, OHLC: {}, heartbeatMs, signal: controller.signal });
    t.after(async () => {
      controller.abort();
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    });
    await client.connect(`ws://127.0.0.1:${server.address().port}`);
    return { client, controller };
  }

  it('destroys an apparently open socket that stops answering heartbeat pings', { timeout: 3000 }, async (t) => {
    const { client } = await localClient(t, { autoPong: false, heartbeatMs: 30 });
    const closed = once(client.ws, 'close');
    await closed;
    assert.equal(client.isOpen(), false);
    assert.equal(client.heartbeat, null);
  });

  it('releases pending requests and metadata after three unanswered data requests', async (t) => {
    const { client } = await localClient(t);
    const inst = { exchange: 'NSE', segment: 'FUTURE', symbol: 'FIXTURE' };
    const results = await Promise.all(['2m', '3m', '5m'].map((iv) => client.requestOhlc(inst, iv, 30)));
    assert.ok(results.every((r) => !r.ok && r.timedOut));
    assert.equal(client.isOpen(), false);
    assert.equal(client.pending.size, 0);
    assert.equal(client.ohlcCollector.reqInterval.size, 0);
    assert.equal(client.ohlcIdxInUse.size, 0);
  });

  it('aborts a connection and in-flight data immediately on shutdown', async (t) => {
    const { client, controller } = await localClient(t);
    const pending = client.requestOhlc({ exchange: 'NSE', segment: 'FUTURE', symbol: 'FIXTURE' }, '2m');
    controller.abort();
    assert.equal((await pending).ok, false);
    assert.equal(client.pending.size, 0);
    assert.equal(client.heartbeat, null);
    await assert.rejects(client.connect('ws://127.0.0.1:1'), /abort/i);
  });
});

describe('instance guard', () => {
  it('blocks a separate process and releases automatically after a crash', { timeout: 5000 }, async (t) => {
    const sheetId = randomUUID();
    const moduleUrl = new URL('./instance-guard.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { acquireInstanceGuard } from ${JSON.stringify(moduleUrl)}; await acquireInstanceGuard(${JSON.stringify(sheetId)}); console.log('ready');`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGKILL'));
    await once(child.stdout, 'data');
    await assert.rejects(acquireInstanceGuard(sheetId), /already running/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const release = await acquireInstanceGuard(sheetId);
    await release();
  });
});

describe('process lifecycle', () => {
  function fixtureProcess(t, { once: oneShot }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gocharting-lifecycle-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const code = `
      import { google } from 'googleapis';
      google.sheets = (options) => ({ spreadsheets: { values: { get() {
        ${oneShot ? "throw new Error('fixture config failure');" : `
          console.log('fixture ready');
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });`}
      } } } });
      const { main } = await import('./src/index.js');
      await main();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env, GOOGLE_SHEET_ID: randomUUID(),
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: 'service_account', client_email: 'fixture@example.invalid', private_key: 'fixture' }),
        ONCE: oneShot ? '1' : '0', WRITE_CSV: '0',
        ERROR_LOG_PATH: path.join(directory, 'error.log'),
        STATUS_PATH: path.join(directory, 'status.json'),
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    return child;
  }

  it('exits nonzero after one-shot cleanup when config loading fails', { timeout: 5000 }, async (t) => {
    const child = fixtureProcess(t, { once: true });
    let output = '';
    child.stderr.on('data', (chunk) => { output += chunk; });
    assert.equal((await once(child, 'exit'))[0], 1);
    assert.match(output, /fixture config failure/);
  });

  it('exits normally on SIGTERM while a config request is pending', { timeout: 5000 }, async (t) => {
    const child = fixtureProcess(t, { once: false });
    const exit = once(child, 'exit');
    await new Promise((resolve) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('fixture ready')) resolve();
      });
    });
    child.kill('SIGTERM');
    assert.equal((await exit)[0], 0);
  });
});
