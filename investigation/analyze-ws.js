import fs from 'node:fs';
const lines = fs.readFileSync('/workspace/investigation/out/capture/websockets.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const text = (p) => {
  if (!p) return '';
  if (p.enc === 'utf8') return p.data || '';
  if (p.enc === 'b64') return p.utf8 || '';
  return p.data || '';
};

console.log('=== SENT frames (client -> server) ===');
for (const l of lines) {
  if (l.ev === 'sent' || l.ev === 'cdp-sent') {
    console.log(text(l.payload).slice(0, 300));
  }
}

console.log('\n=== RECV message-type histogram (first token) ===');
const hist = {};
const samples = {};
for (const l of lines) {
  if (l.ev === 'recv' || l.ev === 'cdp-recv') {
    const t = text(l.payload);
    // socket.io style is often "42[\"event\",{...}]" ; classify by leading chars / event name
    let key = t.slice(0, 2);
    const m = t.match(/^\d+\[\"([^\"]+)\"/);
    if (m) key = 'event:' + m[1];
    hist[key] = (hist[key] || 0) + 1;
    if (!samples[key]) samples[key] = t.slice(0, 400);
  }
}
for (const k of Object.keys(hist).sort((a, b) => hist[b] - hist[a])) {
  console.log(`${String(hist[k]).padStart(5)}  ${k}`);
}
console.log('\n=== one sample per type ===');
for (const k of Object.keys(samples)) {
  console.log(`\n--- ${k} ---`);
  console.log(samples[k]);
}
