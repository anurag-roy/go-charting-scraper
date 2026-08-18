import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  COLUMNS,
  csvRowKey,
  parseCsvLine,
  rowToCsvLine,
  selectNewCsvRows,
  shouldRewriteHeader,
} from './columns.js';

function readHeaderLine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text.replace(/\r$/, '') : text.slice(0, nl).replace(/\r$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

function rewriteHeaderLine(filePath, newHeader) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const sep = raw.includes('\r\n') ? '\r\n' : '\n';
  const nl = raw.indexOf(sep);
  const rest = nl === -1 ? '' : raw.slice(nl + sep.length);
  fs.writeFileSync(filePath, `${newHeader.join(',')}${sep}${rest}`);
}

export class CsvSink {
  constructor(filePath) {
    this.filePath = filePath;
    this.keys = new Set();
  }

  async init() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0) {
      const header = parseCsvLine(readHeaderLine(this.filePath));
      if (shouldRewriteHeader(header, COLUMNS)) {
        rewriteHeaderLine(this.filePath, COLUMNS);
      }
      await this.#loadKeys();
      return;
    }
    fs.writeFileSync(this.filePath, `${COLUMNS.join(',')}\n`);
  }

  async #loadKeys() {
    const rl = readline.createInterface({
      input: fs.createReadStream(this.filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let header = null;
    let iInterval = -1;
    let iTime = -1;
    let iSymbol = -1;
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      if (!header) {
        header = cols;
        iInterval = header.indexOf('interval');
        iTime = header.indexOf('candle_time');
        iSymbol = header.indexOf('symbol');
        continue;
      }
      if (iInterval >= 0 && iTime >= 0 && cols[iTime]) {
        this.keys.add(csvRowKey(iSymbol >= 0 ? cols[iSymbol] : '', cols[iInterval], cols[iTime]));
      }
    }
  }

  writeRows(rows) {
    const fresh = selectNewCsvRows(this.keys, rows);
    if (!fresh.length) return 0;
    const chunk = `${fresh.map((row) => rowToCsvLine(row)).join('\n')}\n`;
    fs.appendFileSync(this.filePath, chunk);
    for (const row of fresh) this.keys.add(csvRowKey(row.symbol, row.interval, row.candle_time));
    return fresh.length;
  }
}
