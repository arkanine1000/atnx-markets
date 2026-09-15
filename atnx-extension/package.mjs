#!/usr/bin/env node
// Builds the Chrome Web Store upload: dist/atnx-capture-v<version>.zip
//
//   node package.mjs
//
// No dependencies (zip is written with node:zlib), so it runs the same on
// Windows, macOS and Linux. Only the files the manifest actually needs are
// included — never the whole folder — so scratch files can't leak into a
// release. Fails loudly if the manifest references a file that is missing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// --- Collect the file list from the manifest -------------------------------

const files = new Set(['manifest.json']);
const add = (p) => {
  if (typeof p === 'string') files.add(p.replace(/^\/+/, ''));
};

add(manifest.background?.service_worker);
add(manifest.side_panel?.default_path);
add(manifest.action?.default_popup);
Object.values(manifest.icons ?? {}).forEach(add);
Object.values(manifest.action?.default_icon ?? {}).forEach(add);
for (const cs of manifest.content_scripts ?? []) {
  (cs.js ?? []).forEach(add);
  (cs.css ?? []).forEach(add);
}
for (const war of manifest.web_accessible_resources ?? []) {
  (war.resources ?? []).forEach(add);
}

// Scripts injected at runtime and assets referenced from HTML aren't in the
// manifest; pull them from the sources we ship.
const HTML_ASSET = /(?:src|href)="(?!https?:|chrome:|#)([^"]+)"/g;
const INJECTED = /files:\s*\[([^\]]*)\]/g;
const scanned = new Set();
const scan = (file) => {
  if (scanned.has(file)) return;
  scanned.add(file);
  const full = path.join(root, file);
  if (!fs.existsSync(full) || !/\.(html|js)$/.test(file)) return;
  const src = fs.readFileSync(full, 'utf8');
  for (const m of src.matchAll(HTML_ASSET)) {
    const ref = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    files.add(ref);
    scan(ref);
  }
  for (const m of src.matchAll(INJECTED)) {
    for (const q of m[1].matchAll(/['"]([^'"]+)['"]/g)) {
      files.add(q[1]);
      scan(q[1]);
    }
  }
};
[...files].forEach(scan);

const missing = [...files].filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error('Missing files referenced by the extension:\n  ' + missing.join('\n  '));
  process.exit(1);
}

// --- Minimal zip writer ----------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosDateTime(new Date());

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

// --- Write ---------------------------------------------------------------

const sorted = [...files].sort();
const entries = sorted.map((name) => ({
  name,
  data: fs.readFileSync(path.join(root, name))
}));

const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const out = path.join(distDir, `atnx-capture-v${manifest.version}.zip`);
fs.writeFileSync(out, zip(entries));

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`${manifest.name} v${manifest.version}`);
for (const f of sorted) console.log(`  + ${f}`);
console.log(`→ ${path.relative(process.cwd(), out)} (${kb} KB)`);
