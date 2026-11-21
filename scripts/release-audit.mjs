import { access, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { readReleaseVersion } from './release-version.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.output/chrome-mv3');
const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
const releaseVersion = await readReleaseVersion(root);

const expectedContentScriptMatches = [
  'https://leetcode.com/problems/*',
  'https://leetcode.cn/problems/*',
];

const expected = {
  name: '速写 - LeetCode 智能补全（Python / C++ / JS / TS）',
  description:
    '为 LeetCode 编辑器提供 Python、C++、JavaScript 与 TypeScript 的智能补全、悬停提示与实时诊断，语言服务全部在本机运行。',
};

assert(manifest.name === expected.name, `Unexpected extension name: ${manifest.name}`);
assert(
  manifest.version === releaseVersion,
  `Built manifest version ${manifest.version} does not match package version ${releaseVersion}`,
);
assert(manifest.description === expected.description, 'Unexpected extension description');
assert(manifest.description.length <= 132, 'Description exceeds 132 characters');
assert(
  JSON.stringify(manifest.permissions) ===
    JSON.stringify(['offscreen', 'scripting', 'activeTab']),
  `Unexpected permissions: ${JSON.stringify(manifest.permissions)}`,
);
assert(!manifest.host_permissions, 'Host permissions must not be declared');
assert(!manifest.optional_permissions, 'Optional permissions must not be declared');
/**
 * Everything LeetCode's document may fetch from the package. The panel page is
 * framed by the injected wrapper, and the MiSans subset is referenced by the
 * `@font-face` rule the isolated bridge injects for our own menu. Both are
 * inert assets; anything scriptable is a hard failure.
 */
const ALLOWED_WEB_RESOURCES = new Set(['panel.html', 'fonts/*.woff2']);
const webResources = manifest.web_accessible_resources ?? [];
const webResourceNames = webResources.flatMap((entry) => entry.resources ?? []);
assert(
  webResources.length === 2 &&
    webResourceNames.length === ALLOWED_WEB_RESOURCES.size &&
    webResourceNames.every((name) => ALLOWED_WEB_RESOURCES.has(name)) &&
    webResources.every((entry) => JSON.stringify(entry.matches) === JSON.stringify(['<all_urls>'])),
  `Unexpected web-accessible resources: ${JSON.stringify(webResourceNames)}`,
);
assert(manifest.minimum_chrome_version === '116', 'Unexpected Chrome version floor');
assert(
  !manifest.action?.default_popup,
  'The action must not declare a default popup (clicks inject the floating panel)',
);
assert(
  manifest.action?.default_icon?.['16']?.includes('inactive'),
  'Toolbar icon must start in the grey inactive state',
);
assert(manifest.content_scripts?.length === 2, 'Expected exactly two content scripts');
for (const contentScript of manifest.content_scripts) {
  assert(
    JSON.stringify([...contentScript.matches].sort()) ===
      JSON.stringify([...expectedContentScriptMatches].sort()),
    `Unexpected content-script scope: ${JSON.stringify(contentScript.matches)}`,
  );
}

for (const size of ['16', '32', '48', '128']) {
  assert(manifest.icons?.[size], `Manifest icon ${size}px is missing`);
  assert(
    manifest.action?.default_icon?.[size],
    `Inactive toolbar icon ${size}px is missing`,
  );
  for (const path of [manifest.icons[size], manifest.action.default_icon[size]]) {
    const icon = await readFile(resolve(output, path));
    const { width, height, colorType } = parsePng(icon);
    assert(width === Number(size) && height === Number(size), `${size}px icon has wrong dimensions`);
    if (size === '128') {
      assert(colorType === 4 || colorType === 6, '128px store icon must have an alpha channel');
    }
  }
}

const requiredFiles = [
  'THIRD_PARTY_NOTICES.md',
  'PRIVACY.md',
  'panel.html',
  'licenses/npm/INDEX.md',
  'licenses/LLVM-LICENSE.txt',
  'licenses/TypeFox-LICENSE.txt',
  'licenses/GPL-3.0.txt',
  'licenses/NOTICE',
  'licenses/leetsense-MIT.txt',
  'licenses/reactbits-LICENSE.md',
  'pyright/pyright.worker.js',
  'clangd/clangd.js',
  'clangd/clangd.wasm',
  'clangd/clangd.worker.mjs',
  'clangd/clang-resource-headers.pack.gz',
];
for (const path of requiredFiles) await access(resolve(output, path));

const expectedHashes = new Map([
  ['clangd/clangd.js', '54def94a3e4f52e78434c9837c614e4cda52bb369dfee69bc514c9e4cd871812'],
  ['clangd/clangd.wasm', '6ab3801712c12703855afec9a71e24f93a2011c607ae0758d901650cde8989d6'],
  ['clangd/clangd.worker.mjs', '1cc2a32ec98449aad387610bcacb0ec62601b2187223e851e7dd2798fe7bde70'],
  ['clangd/clang-resource-headers.pack.gz', 'cdf7b51f2d750c45724eca2710dd4dbd02da83745f0a3b505f77cf5dfd0ca803'],
]);
for (const [path, expectedHash] of expectedHashes) {
  const bytes = await readFile(resolve(output, path));
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert(actualHash === expectedHash, `${path} provenance hash mismatch`);
}

const licenseFiles = await readdir(resolve(output, 'licenses/npm'));
assert(licenseFiles.length > 1, 'Bundled npm license texts are missing');

const emittedBytes = await directorySize(output);
console.log(
  JSON.stringify(
    {
      status: 'PASS',
      version: releaseVersion,
      emittedBytes,
      productionLicenseFiles: licenseFiles.length - 1,
      permissions: manifest.permissions,
      hostPermissions: manifest.host_permissions ?? [],
      webAccessibleResources: manifest.web_accessible_resources ?? [],
    },
    null,
    2,
  ),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parsePng(bytes) {
  const signature = '89504e470d0a1a0a';
  assert(bytes.subarray(0, 8).toString('hex') === signature, 'Icon is not a PNG');
  assert(bytes.subarray(12, 16).toString('ascii') === 'IHDR', 'PNG IHDR is missing');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

async function directorySize(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name);
    total += entry.isDirectory()
      ? await directorySize(entryPath)
      : (await stat(entryPath)).size;
  }
  return total;
}
