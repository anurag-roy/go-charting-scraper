import { createHash } from 'node:crypto';
import net from 'node:net';

export function instancePort(sheetId) {
  return 20_000 + createHash('sha256').update(sheetId).digest().readUInt32BE(0) % 10_000;
}

/**
 * Reserve one loopback socket per spreadsheet across checkouts on this host.
 * The OS releases it after a crash or reboot; there are no stale PID files.
 * A port collision fails closed rather than allowing concurrent Sheet writers.
 */
export async function acquireInstanceGuard(sheetId) {
  const port = instancePort(sheetId);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(new Error(err.code === 'EADDRINUSE'
        ? `Cannot acquire scraper instance guard on 127.0.0.1:${port}. Another scraper for this spreadsheet, or another local process, is already running.`
        : `Cannot acquire scraper instance guard: ${err.code || err.message}`));
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return () => new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}
