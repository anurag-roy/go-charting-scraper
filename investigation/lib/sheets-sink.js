import { google } from 'googleapis';
import {
  SHEET_COLUMNS,
  rowToSheetValues,
  selectNewSheetRows,
  sheetRowKey,
  sheetTabName,
  isPrefixHeader,
  isLegacyVwapHeader,
} from './columns.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export function sheetA1(tab, range) {
  const quoted = `'${String(tab).replace(/'/g, "''")}'`;
  return `${quoted}!${range}`;
}

function makeAuth({ googleCredentialsPath, googleCredentialsJson, googleClientEmail, googlePrivateKey }) {
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

export class SheetsSink {
  constructor(cfg) {
    this.spreadsheetId = cfg.sheetId;
    this.authOpts = cfg;
    this.keys = new Set();
    this.sheetsApi = null;
    this.symbol = '';
  }

  existingKeys() {
    return this.keys;
  }

  tabName(interval) {
    return this.symbol ? sheetTabName(this.symbol, interval) : String(interval || '');
  }

  async init(intervals, symbol = '') {
    this.symbol = String(symbol || '');
    const tabs = (intervals || []).map((iv) => this.tabName(iv));
    const auth = makeAuth(this.authOpts);
    this.sheetsApi = google.sheets({ version: 'v4', auth });

    const meta = await this.sheetsApi.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const listed = meta.data.sheets || [];
    const existing = new Set(listed.map((s) => s.properties?.title).filter(Boolean));
    if (
      listed.length === 1
      && listed[0].properties?.title === 'Sheet1'
      && tabs[0]
      && !existing.has(tabs[0])
    ) {
      await this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: listed[0].properties.sheetId, title: tabs[0] },
              fields: 'title',
            },
          }],
        },
      });
      existing.delete('Sheet1');
      existing.add(tabs[0]);
    }
    const missing = tabs.filter((title) => title && !existing.has(title));
    if (missing.length) {
      await this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      });
    }

    for (const tab of tabs) {
      if (tab) await this.#ensureHeaderAndLoadKeys(tab);
    }
  }

  async #ensureHeaderAndLoadKeys(tab) {
    const res = await this.sheetsApi.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: sheetA1(tab, 'A:AZ'),
    });
    const values = res.data.values || [];
    if (!values.length) {
      await this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A1'),
        valueInputOption: 'RAW',
        requestBody: { values: [SHEET_COLUMNS] },
      });
      return;
    }
    const header = values[0] || [];
    if (isPrefixHeader(header, SHEET_COLUMNS) || isLegacyVwapHeader(header, SHEET_COLUMNS)) {
      await this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A1'),
        valueInputOption: 'RAW',
        requestBody: { values: [SHEET_COLUMNS] },
      });
    }
    const iTime = header.indexOf('candle_time');
    for (const row of values.slice(1)) {
      const t = iTime >= 0 ? row[iTime] : '';
      if (t) this.keys.add(sheetRowKey(tab, t));
    }
  }

  async writeRows(rows) {
    const fresh = selectNewSheetRows(this.keys, rows, (row) => this.tabName(row.interval));
    if (!fresh.length) return 0;

    const byTab = new Map();
    for (const row of fresh) {
      const tab = this.tabName(row.interval);
      if (!byTab.has(tab)) byTab.set(tab, []);
      byTab.get(tab).push(row);
    }

    let n = 0;
    for (const [tab, list] of byTab) {
      await this.sheetsApi.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A1'),
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: list.map(rowToSheetValues) },
      });
      for (const row of list) this.keys.add(sheetRowKey(tab, row.candle_time));
      n += list.length;
    }
    return n;
  }
}
