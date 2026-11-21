import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

import { readReleaseVersion } from './release-version.mjs';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(root, '.output/chrome-mv3');
const releaseVersion = await readReleaseVersion(root);
const manifest = JSON.parse(
  await readFile(resolve(outputDirectory, 'manifest.json'), 'utf8'),
);
if (manifest.version !== releaseVersion) {
  throw new Error(
    `Built manifest version ${manifest.version} does not match package version ${releaseVersion}`,
  );
}
const archivePath = resolve(
  root,
  `.output/algo-ext-${releaseVersion}.zip`,
);
const checksumPath = `${archivePath}.sha256`;
const fixedTime = new Date('1980-01-01T00:00:00.000Z');
const files = await collectFiles(outputDirectory);

for (const file of files) await utimes(file, fixedTime, fixedTime);
await rm(archivePath, { force: true });
await rm(checksumPath, { force: true });

const zip = spawnSync(
  'zip',
  [
    '-X',
    '-9',
    '-q',
    archivePath,
    ...files.map((file) => relative(outputDirectory, file)),
  ],
  { cwd: outputDirectory, encoding: 'utf8' },
);
if (zip.status !== 0) {
  throw new Error(zip.stderr || zip.stdout || `zip exited with ${zip.status}`);
}

const bytes = await readFile(archivePath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(checksumPath, `${sha256}  ${basename(archivePath)}\n`);

console.log(
  JSON.stringify(
    {
      archive: relative(root, archivePath),
      checksum: relative(root, checksumPath),
      version: releaseVersion,
      bytes: (await stat(archivePath)).size,
      sha256,
      files: files.length,
      normalizedTimestamp: fixedTime.toISOString(),
    },
    null,
    2,
  ),
);

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
