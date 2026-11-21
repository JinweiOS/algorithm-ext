import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function extractReleaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headings = [
    ...changelog.matchAll(
      new RegExp(`^## ${escaped}(?:[ \\t]+[^\\r\\n]*)?$`, 'gm'),
    ),
  ];
  if (headings.length !== 1) {
    throw new Error(
      `Expected exactly one CHANGELOG section for ${version}, found ${headings.length}`,
    );
  }

  const start = headings[0].index;
  const nextHeading = changelog.slice(start + 1).search(/^## /m);
  const end =
    nextHeading === -1 ? changelog.length : start + 1 + nextHeading;
  const section = changelog.slice(start, end).trim();
  if (!section.replace(headings[0][0], '').trim()) {
    throw new Error(`CHANGELOG section for ${version} is empty`);
  }
  return section;
}

async function main() {
  const rawVersion = process.argv[2];
  if (!rawVersion) throw new Error('Usage: release-notes.mjs <vX.Y.Z|X.Y.Z>');
  const version = rawVersion.startsWith('v') ? rawVersion.slice(1) : rawVersion;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8');
  const notes = extractReleaseNotes(changelog, version);
  const output = resolve(root, '.output/release-notes.md');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${notes}\n`, 'utf8');
  console.log(output);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
