import { google } from 'googleapis';
import { COLUMNS, rowKey, rowToValues, selectNewRows } from './columns.js';

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
  }

  existingKeys() {
    return this.keys;
  }

  async init(intervals) {
    const auth = makeAuth(this.authOpts);
    this.sheetsApi = google.sheets({ version: 'v4', auth });

    const meta = await this.sheetsApi.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const listed = meta.data.sheets || [];
    const existing = new Set(listed.map((s) => s.properties?.title).filter(Boolean));
    if (
      listed.length === 1
      && listed[0].properties?.title === 'Sheet1'
      && intervals[0]
      && !existing.has(intervals[0])
    ) {
      await this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: listed[0].properties.sheetId, title: intervals[0] },
              fields: 'title',
            },
          }],
        },
      });
      existing.delete('Sheet1');
      existing.add(intervals[0]);
    }
    const missing = intervals.filter((iv) => !existing.has(iv));
    if (missing.length) {
      await this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
        },
      });
    }

    for (const iv of intervals) {
      await this.#ensureHeaderAndLoadKeys(iv);
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
        requestBody: { values: [COLUMNS] },
      });
      return;
    }
    const header = values[0] || [];
    if (header.length < COLUMNS.length && header.every((h, i) => h === COLUMNS[i])) {
      await this.sheetsApi.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A1'),
        valueInputOption: 'RAW',
        requestBody: { values: [COLUMNS] },
      });
    }
    const iInterval = header.indexOf('interval');
    const iTime = header.indexOf('candle_time');
    for (const row of values.slice(1)) {
      const iv = iInterval >= 0 ? row[iInterval] : tab;
      const t = iTime >= 0 ? row[iTime] : '';
      if (t) this.keys.add(rowKey(iv || tab, t));
    }
  }

  async writeRows(rows) {
    const fresh = selectNewRows(this.keys, rows);
    if (!fresh.length) return 0;

    const byTab = new Map();
    for (const row of fresh) {
      if (!byTab.has(row.interval)) byTab.set(row.interval, []);
      byTab.get(row.interval).push(row);
    }

    let n = 0;
    for (const [tab, list] of byTab) {
      await this.sheetsApi.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: sheetA1(tab, 'A1'),
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: list.map(rowToValues) },
      });
      for (const row of list) this.keys.add(rowKey(row.interval, row.candle_time));
      n += list.length;
    }
    return n;
  }
}
