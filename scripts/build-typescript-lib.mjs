// Copies the TypeScript standard library that the offscreen TS service needs
// into public/tslib, following `/// <reference lib="…" />` from the same entry
// point `tsc` uses for a DOM+ES2022 target: modern LeetCode pages offer APIs
// such as Array.prototype.at, and the engine should suggest them too. The service fetches the result at
// boot; nothing here is remote code, it all ships inside the extension package.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const libDirectory = resolve(root, 'node_modules/typescript/lib');
const outputDirectory = resolve(root, 'public/tslib');
const ENTRY = 'lib.es2022.full.d.ts';

async function collectLibFiles() {
  const seen = new Set();
  const queue = [ENTRY];

  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const file = resolve(libDirectory, name);
    if (!existsSync(file)) continue;
    seen.add(name);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/<reference\s+lib="([^"]+)"/g)) {
      queue.push(`lib.${match[1]}.d.ts`);
    }
  }

  return [...seen].sort();
}

const files = await collectLibFiles();
if (files.length === 0) {
  throw new Error('TypeScript lib files were not found; run npm install first.');
}

const bundle = {};
for (const name of files) {
  bundle[name] = await readFile(resolve(libDirectory, name), 'utf8');
}

const payload = JSON.stringify(bundle);
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, 'lib-bundle.json'), payload);

console.info(
  `[tslib] ${files.length} declaration files, ${(Buffer.byteLength(payload) / 1_000_000).toFixed(2)} MB`,
);
