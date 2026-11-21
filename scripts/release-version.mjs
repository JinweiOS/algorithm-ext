import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHROME_VERSION_PART_MAX = 65_535;
const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export async function readReleaseVersion(root) {
  const packageJson = await readJson(resolve(root, 'package.json'));
  const packageLock = await readJson(resolve(root, 'package-lock.json'));
  const version = packageJson.version;

  assert(
    typeof version === 'string' && RELEASE_VERSION_PATTERN.test(version),
    `package.json version must be three dot-separated integers, got ${JSON.stringify(version)}`,
  );

  for (const part of version.split('.').map(Number)) {
    assert(
      part <= CHROME_VERSION_PART_MAX,
      `Chrome manifest version components must not exceed ${CHROME_VERSION_PART_MAX}: ${version}`,
    );
  }

  assert(
    packageLock.version === version,
    `package-lock.json version ${JSON.stringify(packageLock.version)} does not match ${version}`,
  );
  assert(
    packageLock.packages?.['']?.version === version,
    `package-lock.json root package version ${JSON.stringify(packageLock.packages?.['']?.version)} does not match ${version}`,
  );

  return version;
}

export function assertReleaseTag(version, tag) {
  assert(
    typeof tag === 'string' && RELEASE_TAG_PATTERN.test(tag),
    `Release tag ${JSON.stringify(tag)} must use strict vX.Y.Z syntax`,
  );
  assert(
    tag === `v${version}`,
    `Release tag ${tag} does not match package version ${version}`,
  );

  return tag;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
