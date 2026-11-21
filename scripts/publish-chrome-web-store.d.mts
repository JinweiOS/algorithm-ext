export interface ChromeWebStoreConfig {
  accessToken: string;
  publisherId: string;
  extensionId: string;
  zipPath: string;
}

export interface ChromeWebStorePublishOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface ChromeWebStorePublishResult {
  crxVersion?: string;
  itemId: string;
  state: 'PENDING_REVIEW' | 'PUBLISHED' | 'STAGED';
}

export function readChromeWebStoreConfig(
  environment?: Record<string, string | undefined>,
): Promise<ChromeWebStoreConfig>;

export function publishChromeWebStore(
  config: ChromeWebStoreConfig,
  options?: ChromeWebStorePublishOptions,
): Promise<ChromeWebStorePublishResult>;
