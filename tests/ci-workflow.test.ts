import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface CiWorkflow {
  concurrency?: Record<string, unknown>;
  jobs?: {
    verify?: {
      permissions?: Record<string, string>;
      'runs-on'?: string;
      steps?: WorkflowStep[];
      'timeout-minutes'?: number;
    };
  };
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
}

const root = resolve(import.meta.dirname, '..');
const workflow = parse(
  readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
) as CiWorkflow;
const verify = workflow.jobs?.verify;
const steps = verify?.steps ?? [];

function step(name: string) {
  return steps.find((candidate) => candidate.name === name);
}

describe('CI workflow', () => {
  it('runs the complete gate for main pushes and pull requests', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      pull_request: { branches: ['main'] },
    });
    expect(steps.flatMap((candidate) => candidate.run ?? [])).toEqual(
      expect.arrayContaining(['npm ci', 'npm run check']),
    );
  });

  it('uses pinned runtimes, least privilege, and bounded superseded runs', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(verify?.permissions).toBeUndefined();
    expect(verify?.['runs-on']).toBe('ubuntu-24.04');
    expect(verify?.['timeout-minutes']).toBe(30);
    expect(workflow.concurrency).toEqual({
      group:
        'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': true,
    });
    expect(step('Check out source')).toMatchObject({
      uses:
        'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      with: { 'persist-credentials': false },
    });
    expect(step('Set up Node.js')).toMatchObject({
      uses:
        'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
      with: { 'node-version': 24, cache: 'npm' },
    });
    expect(step('Set up Deno')).toMatchObject({
      uses:
        'denoland/setup-deno@667a34cdef165d8d2b2e98dde39547c9daac7282',
      with: { 'deno-version': 'v2.7.14' },
    });
  });
});
