import { resolve } from 'node:path';

import { readReleaseVersion } from './release-version.mjs';

const root = resolve(import.meta.dirname, '..');
const version = await readReleaseVersion(root);

console.log(JSON.stringify({ status: 'PASS', version }, null, 2));
