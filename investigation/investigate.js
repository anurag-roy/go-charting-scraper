// Full capture harness for gocharting.com.
//
// - Logs in with GOCHARTING_EMAIL / GOCHARTING_PASSWORD (read from env only;
//   values are never printed).
// - Records every HTTP request/response (with saved bodies for text types),
//   every WebSocket frame (main-thread + worker via CDP), web workers, and
//   console messages while the chart streams data.
// - Does NOT change any profile settings or click chart/terminal buttons
//   beyond dismissing the promo and performing the required login.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const URL = 'https://gocharting.com/terminal/chart/kd5OXEIXs';
const RUN_MS = Number(process.env.RUN_MS || 90000);
const OUT = process.env.OUT_DIR || '/workspace/investigation/out/capture';
const BODIES = path.join(OUT, 'bodies');
fs.mkdirSync(BODIES, { recursive: true });

const email = process.env.GOCHARTING_EMAIL;
const password = process.env.GOCHARTING_PASSWORD;
if (!email || !password) { console.error('missing credentials env'); process.exit(2); }

const reqLog = fs.createWriteStream(path.join(OUT, 'requests.jsonl'));
const respLog = fs.createWriteStream(path.join(OUT, 'responses.jsonl'));
const wsLog = fs.createWriteStream(path.join(OUT, 'websockets.jsonl'));
const consoleLog = fs.createWriteStream(path.join(OUT, 'console.jsonl'));
const jsUrls = new Set();
const wsUrls = new Set();

const now = () => new Date().toISOString();
const j = (o) => JSON.stringify(o);

// Redact secret values so nothing sensitive lands in capture files on disk.
const SECRETS = [password, email, encodeURIComponent(password), encodeURIComponent(email)].filter(Boolean);
function redact(s) {
  if (s == null) return s;
  let out = String(s);
  for (const sec of SECRETS) out = out.split(sec).join('[REDACTED]');
  return out;
}

const launchOpts = { headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;
const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

// ---- HTTP requests / responses (context-level to include workers) ----
context.on('request', (req) => {
  const rt = req.resourceType();
  if (rt === 'script') jsUrls.add(req.url());
  let postData = null;
  try { postData = req.postData(); } catch {}
  reqLog.write(j({ t: now(), method: req.method(), url: redact(req.url()), rt, postData: postData ? redact(postData.slice(0, 4000)) : null }) + '\n');
});

context.on('response', async (resp) => {
  const req = resp.request();
  const rt = req.resourceType();
  const url = resp.url();
  const ct = (resp.headers()['content-type'] || '');
  const rec = { t: now(), status: resp.status(), url, rt, ct };
  // Save text-ish bodies (JSON/text/js) for offline analysis.
  const textish = /json|text|javascript|xml|graphql/i.test(ct) || rt === 'xhr' || rt === 'fetch' || rt === 'script';
  if (textish) {
    try {
      const buf = await resp.body();
      if (buf && buf.length && buf.length < 6_000_000) {
        const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
        const ext = /javascript/i.test(ct) ? 'js' : /json/i.test(ct) ? 'json' : 'txt';
        const fp = path.join(BODIES, `${h}.${ext}`);
        if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
        rec.body = path.basename(fp);
        rec.size = buf.length;
      }
    } catch (e) { rec.bodyErr = e.message; }
  }
  respLog.write(j(rec) + '\n');
});

// ---- WebSockets via Playwright (main-thread) ----
page.on('websocket', (ws) => {
  wsUrls.add(ws.url());
  wsLog.write(j({ t: now(), ev: 'open', url: ws.url() }) + '\n');
  ws.on('framesent', (d) => wsLog.write(j({ t: now(), ev: 'sent', url: ws.url(), payload: framePreview(d.payload) }) + '\n'));
  ws.on('framereceived', (d) => wsLog.write(j({ t: now(), ev: 'recv', url: ws.url(), payload: framePreview(d.payload) }) + '\n'));
  ws.on('close', () => wsLog.write(j({ t: now(), ev: 'close', url: ws.url() }) + '\n'));
});

function framePreview(payload) {
  if (payload == null) return null;
  if (Buffer.isBuffer(payload)) {
    return { enc: 'b64', len: payload.length, data: payload.slice(0, 8000).toString('base64'), utf8: payload.slice(0, 2000).toString('utf8') };
  }
  return { enc: 'utf8', len: payload.length, data: String(payload).slice(0, 8000) };
}

// ---- CDP: capture worker-originated websockets too ----
try {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const enableNet = async (session) => {
    try { await session.send('Network.enable'); } catch {}
    session.on('Network.webSocketCreated', (p) => { wsUrls.add(p.url); wsLog.write(j({ t: now(), ev: 'cdp-open', url: p.url }) + '\n'); });
    session.on('Network.webSocketFrameReceived', (p) => wsLog.write(j({ t: now(), ev: 'cdp-recv', url: p.response?.url, payload: cdpFrame(p) }) + '\n'));
    session.on('Network.webSocketFrameSent', (p) => wsLog.write(j({ t: now(), ev: 'cdp-sent', url: p.response?.url, payload: cdpFrame(p) }) + '\n'));
  };
  await enableNet(cdp);
} catch (e) { console.log('cdp setup err', e.message); }

function cdpFrame(p) {
  const d = p.response?.payloadData;
  if (d == null) return null;
  return { opcode: p.response?.opcode, len: d.length, data: String(d).slice(0, 8000) };
}

// ---- console + workers ----
page.on('console', (m) => consoleLog.write(j({ t: now(), type: m.type(), text: m.text().slice(0, 500) }) + '\n'));
page.on('worker', (w) => consoleLog.write(j({ t: now(), ev: 'worker', url: w.url() }) + '\n'));

// ---- Drive the page ----
console.log('goto');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto err', e.message));
await page.waitForTimeout(6000);

const dismiss = page.locator('button', { hasText: /^Dismiss$/ });
if (await dismiss.count()) { await dismiss.first().click().catch(() => {}); await page.waitForTimeout(800); }

console.log('login');
await page.locator('#login-avatar').click().catch((e) => console.log('avatar err', e.message));
await page.waitForTimeout(2500);
await page.fill('#email_field', email).catch((e) => console.log('email err', e.message));
await page.fill('#password_field', password).catch((e) => console.log('pw err', e.message));
await page.locator('button[type=submit]', { hasText: /Sign In/i }).click().catch((e) => console.log('submit err', e.message));

// Wait for login to resolve (modal disappears).
await page.waitForTimeout(8000);
const loggedIn = (await page.locator('#email_field').count()) === 0;
console.log('loginModalGone=', loggedIn, 'url=', page.url());
await page.screenshot({ path: path.join(OUT, 'after-login.png') }).catch(() => {});

console.log(`capturing for ${RUN_MS}ms...`);
await page.waitForTimeout(RUN_MS);

// snapshot final DOM state + any footprint-related text
await page.screenshot({ path: path.join(OUT, 'final.png') }).catch(() => {});
fs.writeFileSync(path.join(OUT, 'js-urls.txt'), Array.from(jsUrls).join('\n'));
fs.writeFileSync(path.join(OUT, 'ws-urls.txt'), Array.from(wsUrls).join('\n'));
fs.writeFileSync(path.join(OUT, 'workers.txt'), page.workers().map((w) => w.url()).join('\n'));

for (const s of [reqLog, respLog, wsLog, consoleLog]) s.end();
await new Promise((r) => setTimeout(r, 500));
await browser.close();
console.log('DONE ->', OUT);
console.log('jsUrls', jsUrls.size, 'wsUrls', wsUrls.size);
