// Capture FULL (untruncated) binary WebSocket frames after login, so we can
// decode a real FOOTPRINT/V2 protobuf message offline.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'https://gocharting.com/terminal/chart/kd5OXEIXs';
const OUT = '/workspace/investigation/out/frames';
fs.mkdirSync(OUT, { recursive: true });

const email = process.env.GOCHARTING_EMAIL, password = process.env.GOCHARTING_PASSWORD;
if (!email || !password) { console.error('missing creds'); process.exit(2); }

const launchOpts = { headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;
const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

let n = 0;
const meta = [];
page.on('websocket', (ws) => {
  ws.on('framereceived', (d) => {
    const p = d.payload;
    if (Buffer.isBuffer(p)) {
      const fp = path.join(OUT, `recv_${String(n).padStart(4, '0')}.bin`);
      fs.writeFileSync(fp, p);
      meta.push({ i: n, file: path.basename(fp), len: p.length, b0: p[0], head: p.slice(0, 40).toString('latin1') });
      n++;
    }
  });
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto', e.message));
await page.waitForTimeout(6000);
const dismiss = page.locator('button', { hasText: /^Dismiss$/ });
if (await dismiss.count()) { await dismiss.first().click().catch(() => {}); await page.waitForTimeout(600); }
await page.locator('#login-avatar').click().catch(() => {});
await page.waitForTimeout(2000);
await page.fill('#email_field', email).catch(() => {});
await page.fill('#password_field', password).catch(() => {});
await page.locator('button[type=submit]', { hasText: /Sign In/i }).click().catch(() => {});
await page.waitForTimeout(9000);
console.log('logged in; capturing frames...');
await page.waitForTimeout(45000);

fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
console.log('saved', n, 'binary frames ->', OUT);
await browser.close();
