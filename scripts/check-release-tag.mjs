import { resolve } from 'node:path';

import {
  assertReleaseTag,
  readReleaseVersion,
} from './release-version.mjs';

const root = resolve(import.meta.dirname, '..');
const version = await readReleaseVersion(root);
const tag = assertReleaseTag(version, process.argv[2]);

console.log(JSON.stringify({ status: 'PASS', tag, version }, null, 2));
