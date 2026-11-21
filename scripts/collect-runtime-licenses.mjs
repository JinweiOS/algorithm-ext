import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const outputDirectory = resolve(root, 'public/licenses/npm');
const seenPackages = new Set();

await rm(resolve(root, 'public/licenses'), { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const rows = [];
for (const [packagePath, metadata] of Object.entries(lock.packages)) {
  if (!packagePath.startsWith('node_modules/') || metadata.dev) continue;

  const packageDirectory = resolve(root, packagePath);
  const packageJson = JSON.parse(
    await readFile(resolve(packageDirectory, 'package.json'), 'utf8'),
  );
  const packageId = `${packageJson.name}@${packageJson.version}`;
  if (seenPackages.has(packageId)) continue;
  seenPackages.add(packageId);
  const entries = await readdir(packageDirectory);
  const licenseFile = entries.find((entry) =>
    /^(licen[cs]e|copying|notice)(\.[a-z0-9.-]+)?$/i.test(entry),
  );

  const slug = `${packageJson.name.replaceAll('/', '__')}@${packageJson.version}`;
  const destination = licenseFile
    ? `${slug}-${basename(licenseFile)}`
    : `${slug}-LICENSE-METADATA.txt`;
  if (licenseFile) {
    await cp(resolve(packageDirectory, licenseFile), resolve(outputDirectory, destination));
  } else {
    const repository =
      typeof packageJson.repository === 'string'
        ? packageJson.repository
        : packageJson.repository?.url;
    await writeFile(
      resolve(outputDirectory, destination),
      [
        `${packageJson.name} ${packageJson.version}`,
        `Declared license: ${packageJson.license ?? metadata.license ?? 'unknown'}`,
        `Author: ${formatAuthor(packageJson.author)}`,
        `Repository: ${repository ?? 'not declared'}`,
        '',
        'The published npm package does not contain a separate license file.',
        'The license identifier above is reproduced verbatim from package.json.',
        '',
      ].join('\n'),
    );
  }
  rows.push({
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license ?? metadata.license ?? 'See license file',
    destination,
  });
}

rows.sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);

const index = [
  '# Bundled npm runtime licenses',
  '',
  'Generated from `package-lock.json` by `scripts/collect-runtime-licenses.mjs`.',
  '',
  '| Package | Version | License | Full text |',
  '|---|---:|---|---|',
  ...rows.map(
    ({ name, version, license, destination }) =>
      `| ${name} | ${version} | ${license} | [${destination}](./${destination}) |`,
  ),
  '',
].join('\n');

await writeFile(resolve(outputDirectory, 'INDEX.md'), index);
console.log(`Collected ${rows.length} production dependency licenses.`);

function formatAuthor(author) {
  if (!author) return 'not declared';
  if (typeof author === 'string') return author;
  return [author.name, author.email, author.url].filter(Boolean).join(' ');
}
