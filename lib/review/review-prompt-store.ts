import {
  claimReviewPrompt,
  isReviewPromptEligible,
  recordQualifiedSession,
  type ReviewPromptState,
} from './review-prompt-state';

const DATABASE_NAME = 'leetsense-local';
const DATABASE_VERSION = 1;
const STORE_NAME = 'review-prompt';
const STATE_KEY = 'state';

export class ReviewPromptStore {
  private database: Promise<IDBDatabase> | undefined;

  recordQualifiedSession(timestamp = Date.now()): Promise<boolean> {
    return this.mutate((current) => {
      const state = recordQualifiedSession(current, timestamp);
      return {
        state,
        result: isReviewPromptEligible(state, timestamp),
      };
    });
  }

  claim(timestamp = Date.now()): Promise<boolean> {
    return this.mutate((current) => {
      const claim = claimReviewPrompt(current, timestamp);
      return { state: claim.state, result: claim.claimed };
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('Unable to open local review state'));
    });
    return this.database;
  }

  private async mutate<Result>(
    update: (
      current: ReviewPromptState | undefined,
    ) => { state: ReviewPromptState | undefined; result: Result },
  ): Promise<Result> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(STATE_KEY);
      let result: Result;

      request.onsuccess = () => {
        const next = update(asReviewPromptState(request.result));
        result = next.result;
        if (next.state) store.put(next.state, STATE_KEY);
      };
      request.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(result!);
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error('Unable to update local review state'),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error('Unable to update local review state'),
        );
    });
  }
}

function asReviewPromptState(value: unknown): ReviewPromptState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const state = value as Partial<ReviewPromptState>;
  if (
    !Number.isFinite(state.firstQualifiedUseAt) ||
    !Number.isSafeInteger(state.qualifiedDayCount) ||
    !Number.isSafeInteger(state.qualifiedSessionCount) ||
    typeof state.lastQualifiedDay !== 'string' ||
    (state.promptShownAt !== undefined && !Number.isFinite(state.promptShownAt))
  ) {
    return undefined;
  }
  return state as ReviewPromptState;
}
