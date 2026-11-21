import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/check-release-tag.mjs');
const version = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
).version as string;

function checkTag(tag: string) {
  return spawnSync(process.execPath, [script, tag], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('release tag guard', () => {
  it('accepts the exact v-prefixed package version', () => {
    const result = checkTag(`v${version}`);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'PASS',
      tag: `v${version}`,
      version,
    });
  });

  it('rejects a well-formed tag for a different version', () => {
    const [major, minor, patch] = version.split('.').map(Number);
    const result = checkTag(`v${major}.${minor}.${patch + 1}`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `does not match package version ${version}`,
    );
  });

  it('rejects a malformed release tag', () => {
    const result = checkTag(`release-${version}`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must use strict vX.Y.Z syntax');
  });
});
