import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface ReleaseWorkflow {
  concurrency?: {
    'cancel-in-progress'?: boolean;
    group?: string;
  };
  jobs?: {
    deploy_chrome?: {
      environment?: string;
      needs?: string;
      permissions?: Record<string, string>;
      'runs-on'?: string;
      steps?: WorkflowStep[];
      'timeout-minutes'?: number;
    };
    release?: {
      permissions?: Record<string, string>;
      'runs-on'?: string;
      steps?: WorkflowStep[];
      'timeout-minutes'?: number;
    };
  };
  on?: {
    push?: {
      tags?: string[];
    };
  };
  permissions?: Record<string, string>;
}

const root = resolve(import.meta.dirname, '..');
const workflow = parse(
  readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8'),
) as ReleaseWorkflow;
const releaseJob = workflow.jobs?.release;
const steps = releaseJob?.steps ?? [];
const deployJob = workflow.jobs?.deploy_chrome;
const deploySteps = deployJob?.steps ?? [];

function step(name: string) {
  return steps.find((candidate) => candidate.name === name);
}

function deployStep(name: string) {
  return deploySteps.find((candidate) => candidate.name === name);
}

describe('GitHub release workflow', () => {
  it('runs only for version tags with minimal write permission', () => {
    expect(workflow.on).toEqual({
      push: { tags: ['v*.*.*'] },
    });
    expect(workflow.permissions).toEqual({});
    expect(releaseJob?.permissions).toEqual({ contents: 'write' });
    expect(releaseJob?.['runs-on']).toBe('ubuntu-24.04');
    expect(workflow.concurrency).toEqual({
      group: 'release-${{ github.ref }}',
      'cancel-in-progress': false,
    });
  });

  it('pins runtimes and runs every release gate before publishing', () => {
    expect(step('Check out tagged source')?.uses).toBe(
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
    );
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

    const commands = steps.flatMap((candidate) =>
      candidate.run ? [candidate.run] : [],
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        'npm run release:check-tag -- "$GITHUB_REF_NAME"',
        'npm ci',
        'npm run check',
        'npm run zip',
        'npm run release:notes -- "$GITHUB_REF_NAME"',
      ]),
    );
    expect(releaseJob?.['timeout-minutes']).toBe(30);
  });

  it('publishes the deterministic ZIP and checksum without creating or clobbering tags', () => {
    const publish = step('Publish GitHub Release')?.run ?? '';

    expect(publish).toContain('gh release create "$GITHUB_REF_NAME"');
    expect(publish).toContain('"$archive#Chrome MV3 package"');
    expect(publish).toContain('"$checksum#SHA-256 checksum"');
    expect(publish).toContain('--verify-tag');
    expect(publish).toContain('--notes-file .output/release-notes.md');
    expect(publish).toContain('--fail-on-no-commits');
    expect(publish).not.toContain('--generate-notes');
    expect(publish).not.toContain('--clobber');
    expect(publish).not.toContain('chrome-webstore');
    expect(step('Publish GitHub Release')?.env).toEqual({
      GH_TOKEN: '${{ github.token }}',
    });
  });

  it('gates Chrome deployment after the GitHub Release with scoped OIDC', () => {
    expect(deployJob).toMatchObject({
      needs: 'release',
      environment: 'chrome-web-store',
      permissions: { contents: 'read', 'id-token': 'write' },
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 15,
    });
    expect(releaseJob?.permissions).toEqual({ contents: 'write' });

    const download = deployStep('Download exact GitHub Release package');
    expect(download?.run).toContain(
      'archive=".output/algo-ext-${version}.zip"',
    );
    expect(download?.run).toContain('gh release download "$GITHUB_REF_NAME"');
    expect(download?.run).not.toContain('.output/*');
    expect(download?.env).toEqual({ GH_TOKEN: '${{ github.token }}' });

    expect(deployStep('Authenticate to Google Cloud')).toMatchObject({
      uses:
        'google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093',
      with: {
        token_format: 'access_token',
        workload_identity_provider:
          '${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}',
        service_account: '${{ vars.GCP_SERVICE_ACCOUNT }}',
        access_token_scopes:
          'https://www.googleapis.com/auth/chromewebstore',
        create_credentials_file: false,
        export_environment_variables: false,
      },
    });

    expect(deployStep('Upload and submit to Chrome Web Store')).toMatchObject({
      run: 'node scripts/publish-chrome-web-store.mjs',
      env: {
        CWS_ACCESS_TOKEN: '${{ steps.google_auth.outputs.access_token }}',
        CWS_PUBLISHER_ID: '${{ vars.CWS_PUBLISHER_ID }}',
        CWS_EXTENSION_ID: '${{ vars.CWS_EXTENSION_ID }}',
        CWS_ZIP_PATH: '${{ steps.package.outputs.archive }}',
      },
    });
  });
});
