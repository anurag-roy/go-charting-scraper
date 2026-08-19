/**
 * Bundle the `npm start` graph (no tests) with esbuild, then zip a runnable
 * snapshot: one JS file plus package.json, package-lock.json, launchers,
 * proto schemas, and `.env` / `google-service-account.json` when they exist
 * on this machine.
 *
 * Usage: npm run pack
 * Output: dist/go-charting-scraper-<version>.zip
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const packageParent = path.join(distDir, 'package');

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else copyFile(from, to);
  }
}

function* walkFiles(dir, base = dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkFiles(full, base);
    else {
      yield {
        rel: path.relative(base, full).split(path.sep).join('/'),
        data: fs.readFileSync(full),
      };
    }
  }
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function writeZip(files, outPath) {
  const { dosTime, dosDate } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const crc = crc32(data);
    const deflated = data.length ? zlib.deflateRawSync(data) : data;
    const method = data.length && deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localFile = Buffer.concat([local, nameBuf, payload]);
    locals.push(localFile);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFile.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...locals, centralDir, eocd]));
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const folderName = pkg.name;
const staging = path.join(packageParent, folderName);

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src', 'index.js')],
  outfile: path.join(staging, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  metafile: true,
  logLevel: 'info',
  banner: {
    js: '/* go-charting-scraper — bundled npm start entry (tests excluded) */',
  },
});

const bundledInputs = Object.keys(result.metafile.inputs);
const leakedTests = bundledInputs.filter((f) => /\.test\.js$/.test(f));
if (leakedTests.length) {
  throw new Error(`bundle included test files: ${leakedTests.join(', ')}`);
}

copyDir(path.join(root, 'src', 'proto'), path.join(staging, 'proto'));
fs.unlinkSync(path.join(staging, 'proto', 'README.md'));

const distPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  description: pkg.description,
  scripts: {
    start: 'node index.js',
    once: 'ONCE=1 node index.js',
  },
  engines: pkg.engines,
  dependencies: pkg.dependencies,
};
fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify(distPkg, null, 2)}\n`);

copyFile(path.join(root, 'package-lock.json'), path.join(staging, 'package-lock.json'));
const lockSync = spawnSync(
  'npm',
  ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts'],
  { cwd: staging, encoding: 'utf8' },
);
if (lockSync.status !== 0) {
  process.stderr.write(lockSync.stdout || '');
  process.stderr.write(lockSync.stderr || '');
  throw new Error('failed to sync dist package-lock.json with production dependencies');
}

for (const name of ['start.bat', 'start-once.bat', '.env.example', 'WINDOWS.md']) {
  copyFile(path.join(root, name), path.join(staging, name));
}

copyFile(path.join(root, 'logs', '.gitkeep'), path.join(staging, 'logs', '.gitkeep'));
copyFile(path.join(root, 'logs', 'README.md'), path.join(staging, 'logs', 'README.md'));

const secretCopies = [];
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  copyFile(envPath, path.join(staging, '.env'));
  secretCopies.push('.env');
}
const saPath = path.join(root, 'google-service-account.json');
if (fs.existsSync(saPath)) {
  copyFile(saPath, path.join(staging, 'google-service-account.json'));
  secretCopies.push('google-service-account.json');
}

fs.writeFileSync(path.join(staging, 'README.md'), `# GoCharting scraper (runnable snapshot)

This zip is a bundled copy of what \`npm start\` runs. It does not include
git history, tests, or the source tree.

## Setup

1. Unzip to a normal local folder (avoid OneDrive Files On-Demand placeholders).
2. Install Node.js 22 LTS from https://nodejs.org — leave **Add to PATH** checked.
3. If \`.env\` is not already in this folder, copy the one you were given next
   to \`package.json\`. If it points at \`google-service-account.json\`, put
   that file here too.
4. Double-click \`start-once.bat\` once to smoke-test, then \`start.bat\` each
   morning. Leave the window open while you want candles collected.

Or in a terminal from this folder:

\`\`\`
npm ci --omit=dev
npm start
\`\`\`

Laptop details (sleep, gaps, sheet tabs): see \`WINDOWS.md\`.
`);

const zipName = `${pkg.name}-${pkg.version}.zip`;
const zipPath = path.join(distDir, zipName);
const zipFiles = [];
for (const file of walkFiles(staging)) {
  zipFiles.push({ name: `${folderName}/${file.rel}`, data: file.data });
}
zipFiles.sort((a, b) => a.name.localeCompare(b.name));
writeZip(zipFiles, zipPath);

const bundledKb = Math.round(fs.statSync(path.join(staging, 'index.js')).size / 1024);
console.log(`bundled ${bundledInputs.length} source modules → index.js (${bundledKb} KB)`);
console.log(`zip ${path.relative(root, zipPath)} (${zipFiles.length} files)`);
if (secretCopies.length) {
  console.warn(`included secrets from this machine: ${secretCopies.join(', ')}`);
}
