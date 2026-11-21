export function chromeWebStoreReviewUrl(extensionId: string): string {
  return `https://chrome.google.com/webstore/detail/${encodeURIComponent(extensionId)}/reviews`;
}
