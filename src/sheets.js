import { google } from 'googleapis';
import {
  SHEET_COLUMNS,
  STATIC_INTERVAL_LETTERS,
  TAB_IDENTITY_CELL,
  allStaticTabNames,
  identityFromHeader,
  mapSheetRow,
  formatSheetCandleTime,
  rowToSheetValues,
  rowHasOhlc,
  selectSheetWrites,
  sheetCandleDate,
  sheetCandleTimeFromValues,
  sheetDisplaySymbol,
  sheetDisplaySymbolFromIdentity,
  sheetRowNeedsPatch,
  sheetRowKey,
  sheetTabName,
  sheetTabNamesFor,
  shouldRewriteHeader,
  tabIdentity,
} from './columns.js';
import { MAX_INSTRUMENTS, instrumentIntervals, parseConfigRows } from './instruments.js';
import { withRetry } from './util.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export function sheetA1(tab, range) {
  const quoted = `'${String(tab).replace(/'/g, "''")}'`;
  return `${quoted}!${range}`;
}

export function makeGoogleAuth({ googleCredentialsPath, googleCredentialsJson, googleClientEmail, googlePrivateKey }) {
  if (googleCredentialsPath) {
    return new google.auth.GoogleAuth({ keyFile: googleCredentialsPath, scopes: SCOPES });
  }
  if (googleCredentialsJson) {
    return new google.auth.GoogleAuth({ credentials: googleCredentialsJson, scopes: SCOPES });
  }
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: googleClientEmail,
      private_key: googlePrivateKey,
    },
    scopes: SCOPES,
  });
}

export function createSheetsApi(cfg) {
  const auth = makeGoogleAuth(cfg);
  return google.sheets({ version: 'v4', auth });
}

function retryOpts(log, label) {
  return {
    label,
    retries: 5,
    onRetry: ({ err, wait, attempt }) => {
      log?.warn(`${label} retry ${attempt} in ${wait}ms: ${err?.message || err}`);
    },
  };
}

async function settledSum(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.reduce((sum, result) => sum + (result.value || 0), 0);
}

export class ConfigSheet {
  constructor({ sheetsApi, spreadsheetId, tab = 'config', log } = {}) {
    this.sheetsApi = sheetsApi;
    this.spreadsheetId = spreadsheetId;
    this.tab = tab;
    this.log = log;
  }

  async read() {
    const res = await withRetry(
      () => this.sheetsApi.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(this.tab, 'A1:E8'),
      }),
      retryOpts(this.log, 'config read'),
    );
    return parseConfigRows(res.data.values || []);
  }

  async listTitles() {
    const meta = await withRetry(
      () => this.sheetsApi.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'sheets.properties.title',
      }),
      retryOpts(this.log, 'spreadsheet meta'),
    );
    return (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
  }
}

export class SheetsSink {
  constructor({ sheetsApi, spreadsheetId, log } = {}) {
    this.sheetsApi = sheetsApi;
    this.spreadsheetId = spreadsheetId;
    this.log = log;
    this.keys = new Set();
    this.incompleteKeys = new Set();
    this.loadedTabs = new Set();
    this.boundIdentity = new Map();
    this.staticTabsReady = false;
    this.sheetTitles = null;
  }

  tabForRow(row) {
    const ivs = Array.isArray(row?.intervals) ? row.intervals : [];
    return sheetTabName(row?.slot, ivs.indexOf(row?.interval));
  }

  #forgetTab(tab) {
    if (!tab) return;
    this.loadedTabs.delete(tab);
    this.boundIdentity.delete(tab);
    this.#forgetTabKeys(tab);
  }

  dropInstrument(instrument) {
    for (const tab of sheetTabNamesFor(instrument)) this.#forgetTab(tab);
  }

  async ensureStaticTabs() {
    if (this.staticTabsReady) return;
    const tabs = allStaticTabNames(MAX_INSTRUMENTS, STATIC_INTERVAL_LETTERS);
    await this.#ensureTabs(tabs);
    const res = await withRetry(
      () => this.sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId: this.spreadsheetId,
        ranges: tabs.map((tab) => sheetA1(tab, 'A1:Z1')),
      }),
      retryOpts(this.log, 'static headers'),
    );
    const valueRanges = res.data.valueRanges || [];
    const missingHeaders = [];
    for (let i = 0; i < tabs.length; i += 1) {
      const header = valueRanges[i]?.values?.[0] || [];
      if (!header.length) missingHeaders.push({ range: sheetA1(tabs[i], 'A1'), values: [SHEET_COLUMNS] });
    }
    if (missingHeaders.length) {
      await withRetry(
        () => this.sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: missingHeaders },
        }),
        retryOpts(this.log, 'static headers write'),
      );
    }
    this.staticTabsReady = true;
  }

  async ensureInstrument(instrument) {
    const ivs = instrumentIntervals(instrument);
    const tabs = sheetTabNamesFor(instrument);
    await this.#ensureTabs(tabs);
    await Promise.all(tabs.map(async (tab, i) => {
      const expected = tabIdentity(instrument.slot, ivs[i], instrument.id);
      if (this.loadedTabs.has(tab) && this.boundIdentity.get(tab) === expected) return;
      await this.#ensureHeaderAndLoadKeys(tab, expected);
      this.loadedTabs.add(tab);
      this.boundIdentity.set(tab, expected);
    }));
  }

  /**
   * Keep only rows whose `candle_time` date is `dateStr` (`YYYY-MM-DD`).
   * Also rewrites a legacy header (no `symbol` column, split `vwap1`/`vwap2`).
   * Returns how many data rows were removed.
   */
  async retainSession(instrument, dateStr) {
    const ivs = instrumentIntervals(instrument);
    const tabs = ivs.map((_, i) => sheetTabName(instrument.slot, i)).filter(Boolean);
    await this.#ensureTabs(tabs);
    const dropped = await Promise.all(tabs.map(async (tab) => {
      const n = await this.#retainTabDate(tab, dateStr, instrument);
      this.loadedTabs.add(tab);
      return n;
    }));
    return dropped.reduce((sum, n) => sum + n, 0);
  }

  async #titles() {
    if (this.sheetTitles) return this.sheetTitles;
    const meta = await withRetry(
      () => this.sheetsApi.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'sheets.properties.title',
      }),
      retryOpts(this.log, 'spreadsheet meta'),
    );
    this.sheetTitles = new Set((meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean));
    return this.sheetTitles;
  }

  async #ensureTabs(tabs) {
    const existing = await this.#titles();
    const missing = tabs.filter((title) => title && title.toLowerCase() !== 'config' && !existing.has(title));
    if (!missing.length) return;
    await withRetry(
      () => this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      }),
      retryOpts(this.log, 'add sheets'),
    );
    for (const title of missing) existing.add(title);
  }

  async #writeHeader(tab) {
    await withRetry(
      () => this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A1'),
        valueInputOption: 'RAW',
        requestBody: { values: [SHEET_COLUMNS] },
      }),
      retryOpts(this.log, `header ${tab}`),
    );
  }

  async #writeIdentity(tab, identity) {
    await withRetry(
      () => this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, TAB_IDENTITY_CELL),
        valueInputOption: 'RAW',
        requestBody: { values: [[identity || '']] },
      }),
      retryOpts(this.log, `identity ${tab}`),
    );
  }

  async #clearTabData(tab) {
    await withRetry(
      () => this.sheetsApi.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A2:Z'),
      }),
      retryOpts(this.log, `clear ${tab}`),
    );
    this.#replaceTabKeys(tab, []);
  }

  #forgetTabKeys(tab) {
    for (const k of [...this.keys]) {
      if (k.startsWith(`${tab}\t`)) this.keys.delete(k);
    }
    for (const k of [...this.incompleteKeys]) {
      if (k.startsWith(`${tab}\t`)) this.incompleteKeys.delete(k);
    }
  }

  #replaceTabKeys(tab, times, incompleteTimes = []) {
    this.#forgetTabKeys(tab);
    for (const t of times || []) {
      if (t) this.keys.add(sheetRowKey(tab, t));
    }
    for (const t of incompleteTimes || []) {
      if (t) this.incompleteKeys.add(sheetRowKey(tab, t));
    }
  }

  #replaceMappedTabKeys(tab, mapped) {
    const times = (mapped || []).map((row) => sheetCandleTimeFromValues(row)).filter(Boolean);
    this.#replaceTabKeys(
      tab,
      times,
      (mapped || [])
        .filter((row) => sheetRowNeedsPatch(SHEET_COLUMNS, row))
        .map((row) => sheetCandleTimeFromValues(row))
        .filter(Boolean),
    );
  }

  #mapTabRows(header, rows, symbol) {
    return (rows || [])
      .map((row) => mapSheetRow(header, row, SHEET_COLUMNS, { symbol }))
      .filter((row) => sheetCandleTimeFromValues(row));
  }

  async #writeMappedData(tab, mapped) {
    await withRetry(
      () => this.sheetsApi.spreadsheets.values.clear({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A2:Z'),
      }),
      retryOpts(this.log, `clear ${tab}`),
    );
    if (!mapped.length) return;
    await withRetry(
      () => this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A2'),
        valueInputOption: 'RAW',
        requestBody: { values: mapped },
      }),
      retryOpts(this.log, `rewrite ${tab}`),
    );
  }

  async #ensureHeaderAndLoadKeys(tab, expectedIdentity) {
    const res = await withRetry(
      () => this.sheetsApi.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A:Z'),
      }),
      retryOpts(this.log, `read ${tab}`),
    );
    const values = res.data.values || [];
    const expected = expectedIdentity == null ? null : String(expectedIdentity);
    if (!values.length) {
      await this.#writeHeader(tab);
      if (expected != null) await this.#writeIdentity(tab, expected);
      this.#replaceTabKeys(tab, []);
      return;
    }
    const header = values[0] || [];
    const stored = identityFromHeader(header);
    if (expected != null && stored !== expected) {
      this.log?.info(`overwriting ${tab}`, { from: stored || '(empty)', to: expected || '(vacant)' });
      if (shouldRewriteHeader(header, SHEET_COLUMNS) || !header.length) await this.#writeHeader(tab);
      await this.#writeIdentity(tab, expected);
      await this.#clearTabData(tab);
      return;
    }
    if (shouldRewriteHeader(header, SHEET_COLUMNS)) {
      const symbol = sheetDisplaySymbolFromIdentity(expected != null ? expected : stored);
      const mapped = this.#mapTabRows(header, values.slice(1), symbol);
      this.log?.info(`updating schema on ${tab}`, { rows: mapped.length });
      await this.#writeHeader(tab);
      if (stored || expected) await this.#writeIdentity(tab, expected != null ? expected : stored);
      await this.#writeMappedData(tab, mapped);
      this.#replaceMappedTabKeys(tab, mapped);
      return;
    }
    const iTime = header.indexOf('candle_time');
    const times = [];
    const incompleteTimes = [];
    for (const row of values.slice(1)) {
      const t = iTime >= 0 ? row[iTime] : '';
      if (!t) continue;
      times.push(t);
      if (sheetRowNeedsPatch(header, row)) incompleteTimes.push(t);
    }
    this.#replaceTabKeys(tab, times, incompleteTimes);
  }

  async #retainTabDate(tab, dateStr, instrument) {
    const res = await withRetry(
      () => this.sheetsApi.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A:Z'),
      }),
      retryOpts(this.log, `read ${tab}`),
    );
    const values = res.data.values || [];
    if (!values.length) {
      await this.#writeHeader(tab);
      this.#replaceTabKeys(tab, []);
      return 0;
    }
    const header = values[0] || [];
    const rewriteHeader = shouldRewriteHeader(header, SHEET_COLUMNS);
    const iTime = header.indexOf('candle_time');
    const data = values.slice(1);
    const kept = [];
    for (const row of data) {
      const t = iTime >= 0 ? row[iTime] : '';
      if (t && sheetCandleDate(t) === dateStr) kept.push(row);
    }
    const dropped = data.length - kept.length;
    const symbol = instrument?.symbol
      || sheetDisplaySymbol(instrument)
      || sheetDisplaySymbolFromIdentity(identityFromHeader(header));
    const mapped = this.#mapTabRows(header, kept, symbol);
    const extraCols = data.some((row) => (row?.length || 0) > SHEET_COLUMNS.length);
    if (rewriteHeader || dropped > 0 || extraCols) {
      if (rewriteHeader) await this.#writeHeader(tab);
      await this.#writeMappedData(tab, mapped);
    }
    this.#replaceMappedTabKeys(tab, mapped);
    return dropped;
  }

  async #reloadTabKeys(tab) {
    this.#replaceTabKeys(tab, []);
    this.loadedTabs.delete(tab);
    const expected = this.boundIdentity.has(tab) ? this.boundIdentity.get(tab) : undefined;
    await this.#ensureHeaderAndLoadKeys(tab, expected);
    this.loadedTabs.add(tab);
  }

  async writeRows(rows) {
    const tabsNeeded = new Set();
    for (const row of rows || []) {
      const tab = this.tabForRow(row);
      if (tab) tabsNeeded.add(tab);
    }
    for (const tab of tabsNeeded) {
      if (!this.loadedTabs.has(tab)) {
        await this.#ensureTabs([tab]);
        await this.#ensureHeaderAndLoadKeys(tab);
        this.loadedTabs.add(tab);
      }
    }

    const { append, patch } = selectSheetWrites(
      this.keys,
      this.incompleteKeys,
      rows,
      (row) => this.tabForRow(row),
    );
    if (!append.length && !patch.length) return 0;

    const appendByTab = new Map();
    for (const row of append) {
      const tab = this.tabForRow(row);
      if (!appendByTab.has(tab)) appendByTab.set(tab, []);
      appendByTab.get(tab).push(row);
    }
    const patchByTab = new Map();
    for (const row of patch) {
      const tab = this.tabForRow(row);
      if (!patchByTab.has(tab)) patchByTab.set(tab, []);
      patchByTab.get(tab).push(row);
    }

    let n = await settledSum([...appendByTab].map(async ([tab, list]) => {
      const stillNew = list.filter((row) => !this.keys.has(sheetRowKey(tab, row.candle_time)));
      if (!stillNew.length) return 0;
      try {
        await withRetry(
          () => this.sheetsApi.spreadsheets.values.append({
            spreadsheetId: this.spreadsheetId,
            range: sheetA1(tab, 'A1'),
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: stillNew.map(rowToSheetValues) },
          }),
          retryOpts(this.log, `append ${tab}`),
        );
        for (const row of stillNew) {
          const k = sheetRowKey(tab, row.candle_time);
          this.keys.add(k);
          if (sheetRowNeedsPatch(SHEET_COLUMNS, rowToSheetValues(row))) this.incompleteKeys.add(k);
          else this.incompleteKeys.delete(k);
        }
        return stillNew.length;
      } catch (err) {
        this.log?.error(`append failed for ${tab}; reloading keys`, err);
        try { await this.#reloadTabKeys(tab); } catch (reloadErr) {
          this.log?.error(`reload keys failed for ${tab}`, reloadErr);
        }
        throw err;
      }
    }));
    n += await settledSum([...patchByTab].map(([tab, list]) => this.#patchTabRows(tab, list)));
    return n;
  }

  async #patchTabRows(tab, rows) {
    const wanted = new Map();
    for (const row of rows || []) {
      if (!rowHasOhlc(row)) continue;
      wanted.set(formatSheetCandleTime(row.candle_time), row);
    }
    if (!wanted.size) return 0;

    const res = await withRetry(
      () => this.sheetsApi.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A:Z'),
      }),
      retryOpts(this.log, `read ${tab} for ohlc patch`),
    );
    const values = res.data.values || [];
    const header = values[0] || [];
    const iTime = header.indexOf('candle_time');
    if (iTime < 0) return 0;

    const body = values.slice(1);
    const data = [];
    for (let i = 0; i < body.length; i += 1) {
      const existing = body[i] || [];
      const t = formatSheetCandleTime(existing[iTime]);
      const next = wanted.get(t);
      const k = t ? sheetRowKey(tab, t) : '';
      if (next && sheetRowNeedsPatch(header, existing)) {
        data.push({
          range: sheetA1(tab, `A${i + 2}`),
          values: [rowToSheetValues(next)],
        });
        if (k) this.incompleteKeys.delete(k);
      } else if (next && k) {
        this.incompleteKeys.delete(k);
      }
    }
    if (!data.length) return 0;

    await withRetry(
      () => this.sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      }),
      retryOpts(this.log, `patch ohlc ${tab}`),
    );
    this.log?.info(`filled missing cells on ${tab} (${data.length} row(s))`);
    return data.length;
  }
}
