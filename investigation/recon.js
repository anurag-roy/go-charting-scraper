// Recon: open the target URL, observe whether login is required, and dump the
// page's form structure (inputs/buttons/links) so we can script login safely.
// Does NOT submit any credentials or click terminal buttons.
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = 'https://gocharting.com/terminal/chart/kd5OXEIXs';
const OUT = '/workspace/investigation/out/recon';
fs.mkdirSync(OUT, { recursive: true });

const launchOpts = { headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.PW_CHANNEL) launchOpts.channel = process.env.PW_CHANNEL;

const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

const nav = [];
page.on('framenavigated', (f) => { if (f === page.mainFrame()) nav.push(f.url()); });

console.log('navigating to', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto err', e.message));
await page.waitForTimeout(8000);

console.log('final url:', page.url());
console.log('nav chain:', JSON.stringify(nav));

const info = await page.evaluate(() => {
  const attrs = (el) => {
    const o = {};
    for (const a of el.attributes) o[a.name] = a.value;
    return o;
  };
  const collect = (sel) => Array.from(document.querySelectorAll(sel)).map((el) => ({
    tag: el.tagName.toLowerCase(),
    attrs: attrs(el),
    text: (el.innerText || el.value || '').slice(0, 80),
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  }));
  return {
    title: document.title,
    url: location.href,
    inputs: collect('input,textarea'),
    buttons: collect('button'),
    links: Array.from(document.querySelectorAll('a')).map((a) => ({ href: a.href, text: (a.innerText || '').slice(0, 60) })).filter((a) => a.text),
  };
});

fs.writeFileSync(`${OUT}/page-info.json`, JSON.stringify({ nav, info }, null, 2));
fs.writeFileSync(`${OUT}/page.html`, await page.content());
await page.screenshot({ path: `${OUT}/screen.png`, fullPage: true }).catch(() => {});

console.log('INPUTS:', JSON.stringify(info.inputs, null, 2));
console.log('BUTTONS:', JSON.stringify(info.buttons.slice(0, 30), null, 2));
console.log('LINKS:', JSON.stringify(info.links.slice(0, 40), null, 2));

await browser.close();
console.log('recon done -> ', OUT);
