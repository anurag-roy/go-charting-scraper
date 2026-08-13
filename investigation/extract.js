import fs from 'node:fs';
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const needles = process.argv.slice(3);
for (const n of needles) {
  console.log(`\n================= NEEDLE: ${JSON.stringify(n)} =================`);
  let idx = 0, count = 0;
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  let m;
  while ((m = re.exec(src)) && count < 6) {
    const start = Math.max(0, m.index - 600);
    const end = Math.min(src.length, m.index + 600);
    console.log(`\n--- match @${m.index} ---`);
    console.log(src.slice(start, end));
    count++;
  }
  if (count === 0) console.log('(no matches)');
}
