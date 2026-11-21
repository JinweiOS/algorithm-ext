import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://chromewebstore.googleapis.com';
const IN_PROGRESS_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const SUCCESS_STATES = new Set(['SUCCEEDED', 'UPLOAD_SUCCEEDED']);
const SUBMISSION_STATES = new Set(['PENDING_REVIEW', 'PUBLISHED', 'STAGED']);

function requireValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function validateIdentifier(value, name, pattern) {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export async function readChromeWebStoreConfig(environment = process.env) {
  const accessToken = requireValue(environment, 'CWS_ACCESS_TOKEN');
  const publisherId = validateIdentifier(
    requireValue(environment, 'CWS_PUBLISHER_ID'),
    'CWS_PUBLISHER_ID',
    /^[A-Za-z0-9_-]+$/,
  );
  const extensionId = validateIdentifier(
    requireValue(environment, 'CWS_EXTENSION_ID'),
    'CWS_EXTENSION_ID',
    /^[a-p]{32}$/,
  );
  const zipPath = requireValue(environment, 'CWS_ZIP_PATH');
  const zipStat = await stat(zipPath);

  if (!zipStat.isFile() || !zipPath.endsWith('.zip')) {
    throw new Error('CWS_ZIP_PATH must point to a ZIP file');
  }

  return { accessToken, publisherId, extensionId, zipPath };
}

async function responseJson(response, operation) {
  const raw = await response.text();
  let body = {};

  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(`${operation} returned invalid JSON (${response.status})`);
    }
  }

  if (!response.ok) {
    const apiMessage = body?.error?.message;
    const detail =
      typeof apiMessage === 'string'
        ? apiMessage.slice(0, 500)
        : `HTTP ${response.status}`;
    throw new Error(`${operation} failed: ${detail}`);
  }

  return body;
}

function uploadState(value, source) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${source} did not return an upload state`);
  }
  if (SUCCESS_STATES.has(value) || IN_PROGRESS_STATES.has(value)) return value;
  throw new Error(`${source} returned terminal upload state ${value}`);
}

export async function publishChromeWebStore(
  config,
  {
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pollIntervalMs = 5_000,
    maxPollAttempts = 120,
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const itemName = `publishers/${config.publisherId}/items/${config.extensionId}`;
  const authorization = `Bearer ${config.accessToken}`;
  const zip = await readFile(config.zipPath);
  const uploadUrl = `${API_ORIGIN}/upload/v2/${itemName}:upload`;

  const uploaded = await responseJson(
    await fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/zip',
      },
      body: zip,
    }),
    'Chrome Web Store upload',
  );

  let currentUploadState = uploadState(
    uploaded.uploadState,
    'Chrome Web Store upload',
  );

  if (IN_PROGRESS_STATES.has(currentUploadState)) {
    const statusUrl = `${API_ORIGIN}/v2/${itemName}:fetchStatus`;

    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      await sleep(pollIntervalMs);
      const status = await responseJson(
        await fetchImpl(statusUrl, {
          headers: { Authorization: authorization },
        }),
        'Chrome Web Store upload status',
      );
      currentUploadState = uploadState(
        status.lastAsyncUploadState,
        'Chrome Web Store upload status',
      );
      if (SUCCESS_STATES.has(currentUploadState)) break;
    }

    if (!SUCCESS_STATES.has(currentUploadState)) {
      throw new Error('Chrome Web Store upload status timed out');
    }
  }

  const published = await responseJson(
    await fetchImpl(`${API_ORIGIN}/v2/${itemName}:publish`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        blockOnWarnings: true,
        publishType: 'DEFAULT_PUBLISH',
      }),
    }),
    'Chrome Web Store submission',
  );

  if (!SUBMISSION_STATES.has(published.state)) {
    throw new Error(
      `Chrome Web Store submission returned unknown state ${String(published.state)}`,
    );
  }

  return {
    crxVersion: uploaded.crxVersion,
    itemId: published.itemId ?? config.extensionId,
    state: published.state,
  };
}

async function main() {
  const result = await publishChromeWebStore(
    await readChromeWebStoreConfig(process.env),
  );
  console.log(JSON.stringify({ status: 'PASS', ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
