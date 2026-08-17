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

  const auth = new AuthSession({ tokenRefreshMs: cfg.tokenRefreshMs });
  const log = createLogger({
    errorLogPath: cfg.errorLogPath,
    getSecrets: () => [
      auth.email,
      auth.password,
      auth.tokens?.idToken,
      auth.tokens?.refreshToken,
      auth.tokens?.accessToken,
    ],
  });
  auth.log = log;

  const sheetsApi = createSheetsApi(cfg);
  const configSheet = new ConfigSheet({
    sheetsApi,
    spreadsheetId: cfg.sheetId,
    tab: cfg.configTab,
    log,
  });
  const sink = new SheetsSink({
    sheetsApi,
    spreadsheetId: cfg.sheetId,
    log,
  });

  let csvSink = null;
  if (cfg.writeCsv) {
    csvSink = new CsvSink(cfg.csvPath);
    await csvSink.init();
  }

  const { FP, OHLC } = await loadProtos(cfg.protoDir);
  const client = new FootprintClient({
    FP,
    OHLC,
    session: cfg.session,
    intervals: cfg.intervals,
    log,
  });

  const supervisor = new Supervisor({
    cfg,
    log,
    configSheet,
    sink,
    csvSink,
    auth,
    client,
  });

  const shutdown = (signal) => {
    log.info(`received ${signal}`);
    supervisor.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    log.error('unhandledRejection', err);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
    process.exit(1);
  });

  log.info('go-charting-scraper', { at: istNow(), once: cfg.once, sheet: cfg.sheetId });

  try {
    if (cfg.once) await supervisor.runOnce();
    else await supervisor.run();
  } catch (err) {
    log.error('FATAL', err);
    process.exitCode = 1;
  }
}

if (isMain()) {
  await main();
}
