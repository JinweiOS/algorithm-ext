import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  publishChromeWebStore,
  readChromeWebStoreConfig,
} from '../scripts/publish-chrome-web-store.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const temporaryDirectories: string[] = [];

async function config() {
  const directory = await mkdtemp(join(tmpdir(), 'leetsense-cws-'));
  temporaryDirectories.push(directory);
  const zipPath = join(directory, 'leetsense.zip');
  await writeFile(zipPath, 'zip bytes');
  return {
    accessToken: 'short-lived-token',
    publisherId: 'publisher-123',
    extensionId,
    zipPath,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Chrome Web Store API v2 publisher', () => {
  it('uploads the exact ZIP and submits it with warnings blocked', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({ uploadState: 'SUCCEEDED', crxVersion: '1.2.1' }),
      )
      .mockResolvedValueOnce(
        json({ itemId: extensionId, state: 'PENDING_REVIEW' }),
      );

    await expect(
      publishChromeWebStore(await config(), { fetchImpl }),
    ).resolves.toEqual({
      crxVersion: '1.2.1',
      itemId: extensionId,
      state: 'PENDING_REVIEW',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `https://chromewebstore.googleapis.com/upload/v2/publishers/publisher-123/items/${extensionId}:upload`,
    );
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `https://chromewebstore.googleapis.com/v2/publishers/publisher-123/items/${extensionId}:publish`,
    );
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      blockOnWarnings: true,
      publishType: 'DEFAULT_PUBLISH',
    });
  });

  it('polls an asynchronous upload before submitting exactly once', async () => {
    const sleep = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ uploadState: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(json({ lastAsyncUploadState: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(json({ lastAsyncUploadState: 'SUCCEEDED' }))
      .mockResolvedValueOnce(
        json({ itemId: extensionId, state: 'PENDING_REVIEW' }),
      );

    await publishChromeWebStore(await config(), {
      fetchImpl,
      sleep,
      pollIntervalMs: 1,
      maxPollAttempts: 3,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('fails closed on terminal upload and HTTP failures', async () => {
    await expect(
      publishChromeWebStore(await config(), {
        fetchImpl: vi.fn().mockResolvedValue(json({ uploadState: 'FAILED' })),
      }),
    ).rejects.toThrow('terminal upload state FAILED');

    await expect(
      publishChromeWebStore(await config(), {
        fetchImpl: vi
          .fn()
          .mockResolvedValue(json({ error: { message: 'denied' } }, 403)),
      }),
    ).rejects.toThrow('Chrome Web Store upload failed: denied');
  });

  it('fails closed when an asynchronous upload never finishes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ uploadState: 'IN_PROGRESS' }))
      .mockImplementation(async () =>
        json({ lastAsyncUploadState: 'IN_PROGRESS' }),
      );

    await expect(
      publishChromeWebStore(await config(), {
        fetchImpl,
        sleep: vi.fn(),
        pollIntervalMs: 1,
        maxPollAttempts: 2,
      }),
    ).rejects.toThrow('Chrome Web Store upload status timed out');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects missing configuration before making a request', async () => {
    await expect(readChromeWebStoreConfig({})).rejects.toThrow(
      'Missing required environment variable CWS_ACCESS_TOKEN',
    );
  });
});
