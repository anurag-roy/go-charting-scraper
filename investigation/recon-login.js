// Recon step 2: open the login UI (clicking the login avatar is part of the
// required login flow) and dump the resulting form so we can script it.
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = 'https://gocharting.com/terminal/chart/kd5OXEIXs';
const OUT = '/workspace/investigation/out/recon-login';
fs.mkdirSync(OUT, { recursive: true });

const launchOpts = { headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;

const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto err', e.message));
await page.waitForTimeout(6000);

// Dismiss the promo if present (Dismiss is not a profile/settings change).
const dismiss = page.locator('button', { hasText: /^Dismiss$/ });
if (await dismiss.count()) { await dismiss.first().click().catch(() => {}); await page.waitForTimeout(1000); }

console.log('clicking login avatar...');
await page.locator('#login-avatar').click().catch((e) => console.log('login click err', e.message));
await page.waitForTimeout(5000);

const dump = await page.evaluate(() => {
  const attrs = (el) => { const o = {}; for (const a of el.attributes) o[a.name] = a.value; return o; };
  const collect = (root, sel) => Array.from(root.querySelectorAll(sel)).map((el) => ({
    tag: el.tagName.toLowerCase(), attrs: attrs(el), text: (el.innerText || el.value || '').slice(0, 60),
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  }));
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => ({ src: f.src, name: f.name }));
  return {
    url: location.href,
    inputs: collect(document, 'input,textarea'),
    buttons: collect(document, 'button').filter((b) => b.visible && b.text),
    iframes: frames,
    modalText: (document.querySelector('[class*=modal],[role=dialog]')?.innerText || '').slice(0, 500),
  };
});

fs.writeFileSync(`${OUT}/login-info.json`, JSON.stringify(dump, null, 2));
await page.screenshot({ path: `${OUT}/login.png`, fullPage: false }).catch(() => {});
console.log(JSON.stringify(dump, null, 2));

await browser.close();
