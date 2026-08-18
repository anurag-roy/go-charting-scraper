import { google } from 'googleapis';
import {
  SHEET_COLUMNS,
  mapSheetRow,
  rowToSheetValues,
  selectNewSheetRows,
  sheetCandleDate,
  sheetRowKey,
  sheetTabName,
  shouldRewriteHeader,
} from './columns.js';
import { parseConfigRows } from './instruments.js';
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
        range: sheetA1(this.tab, 'A1:B50'),
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
    this.loadedTabs = new Set();
  }

  tabForRow(row) {
    return sheetTabName(row.contract, row.interval);
  }

  dropInstrument(contract, intervals) {
    for (const iv of intervals || []) {
      const tab = sheetTabName(contract, iv);
      this.loadedTabs.delete(tab);
      for (const k of [...this.keys]) {
        if (k.startsWith(`${tab}\t`)) this.keys.delete(k);
      }
    }
  }

  async ensureInstrument(contract, intervals) {
    const tabs = (intervals || []).map((iv) => sheetTabName(contract, iv)).filter(Boolean);
    await this.#ensureTabs(tabs);
    for (const tab of tabs) {
      if (!this.loadedTabs.has(tab)) {
        await this.#ensureHeaderAndLoadKeys(tab);
        this.loadedTabs.add(tab);
      }
    }
  }

  /**
   * Keep only rows whose `candle_time` date is `dateStr` (`YYYY-MM-DD`).
   * Also rewrites a legacy `vwap1`/`vwap2` header to `vwap`.
   * Returns how many data rows were removed.
   */
  async retainSession(contract, intervals, dateStr) {
    const tabs = (intervals || []).map((iv) => sheetTabName(contract, iv)).filter(Boolean);
    await this.#ensureTabs(tabs);
    let dropped = 0;
    for (const tab of tabs) {
      dropped += await this.#retainTabDate(tab, dateStr);
      this.loadedTabs.add(tab);
    }
    return dropped;
  }

  async #titles() {
    const meta = await withRetry(
      () => this.sheetsApi.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'sheets.properties.title',
      }),
      retryOpts(this.log, 'spreadsheet meta'),
    );
    return new Set((meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean));
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

  #replaceTabKeys(tab, times) {
    for (const k of [...this.keys]) {
      if (k.startsWith(`${tab}\t`)) this.keys.delete(k);
    }
    for (const t of times || []) {
      if (t) this.keys.add(sheetRowKey(tab, t));
    }
  }

  async #ensureHeaderAndLoadKeys(tab) {
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
      return;
    }
    const header = values[0] || [];
    if (shouldRewriteHeader(header, SHEET_COLUMNS)) {
      await this.#writeHeader(tab);
    }
    const iTime = header.indexOf('candle_time');
    for (const row of values.slice(1)) {
      const t = iTime >= 0 ? row[iTime] : '';
      if (t) this.keys.add(sheetRowKey(tab, t));
    }
  }

  async #retainTabDate(tab, dateStr) {
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
    const mapped = kept.map((row) => mapSheetRow(header, row));
    const extraCols = data.some((row) => (row?.length || 0) > SHEET_COLUMNS.length);
    if (rewriteHeader || dropped > 0 || extraCols) {
      if (rewriteHeader) await this.#writeHeader(tab);
      await withRetry(
        () => this.sheetsApi.spreadsheets.values.clear({
          spreadsheetId: this.spreadsheetId,
          range: sheetA1(tab, 'A2:Z'),
        }),
        retryOpts(this.log, `clear ${tab}`),
      );
      if (mapped.length) {
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
    }
    this.#replaceTabKeys(tab, mapped.map((row) => row[0]));
    return dropped;
  }

  async #reloadTabKeys(tab) {
    this.#replaceTabKeys(tab, []);
    this.loadedTabs.delete(tab);
    await this.#ensureHeaderAndLoadKeys(tab);
    this.loadedTabs.add(tab);
  }

  async writeRows(rows) {
    const fresh = selectNewSheetRows(this.keys, rows, (row) => this.tabForRow(row));
    if (!fresh.length) return 0;

    const byTab = new Map();
    for (const row of fresh) {
      const tab = this.tabForRow(row);
      if (!byTab.has(tab)) byTab.set(tab, []);
      byTab.get(tab).push(row);
    }

    let n = 0;
    for (const [tab, list] of byTab) {
      if (!this.loadedTabs.has(tab)) {
        await this.#ensureTabs([tab]);
        await this.#ensureHeaderAndLoadKeys(tab);
        this.loadedTabs.add(tab);
      }
      const stillNew = list.filter((row) => !this.keys.has(sheetRowKey(tab, row.candle_time)));
      if (!stillNew.length) continue;
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
        for (const row of stillNew) this.keys.add(sheetRowKey(tab, row.candle_time));
        n += stillNew.length;
      } catch (err) {
        this.log?.error(`append failed for ${tab}; reloading keys`, err);
        try { await this.#reloadTabKeys(tab); } catch (reloadErr) {
          this.log?.error(`reload keys failed for ${tab}`, reloadErr);
        }
        throw err;
      }
    }
    return n;
  }
}
