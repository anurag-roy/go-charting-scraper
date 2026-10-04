import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from './env.js';
import { createLogger } from './log.js';
import { createSheetsApi, ConfigSheet, SheetsSink } from './sheets.js';
import { CsvSink } from './csv-sink.js';
import { AuthSession } from './cognito.js';
import { FootprintClient, loadProtos } from './gocharting.js';
import { Supervisor } from './supervisor.js';
import { istNow } from './session.js';
import { acquireInstanceGuard } from './instance-guard.js';

function isMain() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return import.meta.url === pathToFileURL(entry).href;
}

export async function main() {
  const cfg = loadConfig();
  const configErrors = validateConfig(cfg);
  if (configErrors.length) {
    for (const err of configErrors) console.error(err);
    process.exitCode = 2;
    return;
  }

  const abortController = new AbortController();
  cfg.signal = abortController.signal;
  const auth = new AuthSession({ tokenRefreshMs: cfg.tokenRefreshMs, signal: cfg.signal, timeoutMs: cfg.httpTimeoutMs });
  let supervisor;
  let client;
  let releaseGuard;
  let shutdownRequested = false;
  const log = createLogger({
    errorLogPath: cfg.errorLogPath,
    getSecrets: () => [
      auth.email,
      auth.password,
      auth.tokens?.idToken,
      auth.tokens?.refreshToken,
      auth.tokens?.accessToken,
      cfg.googlePrivateKey,
      ...(supervisor?.secrets() || []),
    ],
  });
  auth.log = log;

  const shutdown = (signal) => {
    shutdownRequested = true;
    if (!cfg.signal.aborted) log.info(`received ${signal}`);
    abortController.abort();
    supervisor?.stop();
    client?.stop();
  };
  const onTerm = () => shutdown('SIGTERM');
  const onInt = () => shutdown('SIGINT');
  const onRejection = (err) => {
    log.error('unhandledRejection', err);
    process.exitCode = 1;
    shutdown('unhandledRejection');
  };
  const onException = (err) => {
    log.error('uncaughtException', err);
    // The OS releases the instance guard even if orderly cleanup is impossible.
    process.exit(1);
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  try {
    releaseGuard = await acquireInstanceGuard(cfg.sheetId);
    cfg.signal.throwIfAborted();
    const sheetsApi = await createSheetsApi(cfg);
    const configSheet = new ConfigSheet({
      sheetsApi,
      spreadsheetId: cfg.sheetId,
      tab: cfg.configTab,
      log,
      signal: cfg.signal,
    });
    const sink = new SheetsSink({
      sheetsApi,
      spreadsheetId: cfg.sheetId,
      log,
      signal: cfg.signal,
    });

    let csvSink = null;
    if (cfg.writeCsv) {
      csvSink = new CsvSink(cfg.csvPath);
      await csvSink.init();
    }

    const { FP, OHLC } = await loadProtos(cfg.protoDir);
    client = new FootprintClient({
      FP,
      OHLC,
      session: cfg.session,
      log,
      signal: cfg.signal,
      heartbeatMs: cfg.wsHeartbeatMs,
    });

    supervisor = new Supervisor({
      cfg,
      log,
      configSheet,
      sink,
      csvSink,
      auth,
      client,
      abortController,
    });

    log.info('go-charting-scraper', {
      at: istNow(),
      once: cfg.once,
      lastWorkingDay: cfg.lastWorkingDay,
      sheet: cfg.sheetId,
    });

    if (cfg.once) await supervisor.runOnce();
    else await supervisor.run();
  } catch (err) {
    if (!shutdownRequested) {
      log.error('FATAL', err);
      process.exitCode = 1;
    }
  } finally {
    abortController.abort();
    supervisor?.stop();
    client?.stop();
    if (releaseGuard) await releaseGuard();
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  }
}

if (isMain()) {
  await main();
}
