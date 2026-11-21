import { describe, expect, it } from 'vitest';

import {
  claimReviewPrompt,
  isReviewPromptEligible,
  recordQualifiedSession,
  type ReviewPromptState,
} from '../lib/review/review-prompt-state';
import { chromeWebStoreReviewUrl } from '../lib/review/chrome-web-store';

const DAY = 24 * 60 * 60 * 1_000;
const START = new Date(2026, 7, 1, 10).getTime();

describe('earned review reminder', () => {
  it('becomes eligible after five sessions across three days and one week', () => {
    let state: ReviewPromptState | undefined;
    for (const offset of [0, 0, 2 * DAY, 2 * DAY, 7 * DAY]) {
      state = recordQualifiedSession(state, START + offset);
    }

    expect(isReviewPromptEligible(state, START + 7 * DAY)).toBe(true);
    expect(state).toMatchObject({
      qualifiedDayCount: 3,
      qualifiedSessionCount: 5,
    });
  });

  it('claims the reminder once and never becomes eligible again', () => {
    const eligible: ReviewPromptState = {
      firstQualifiedUseAt: START,
      qualifiedDayCount: 3,
      lastQualifiedDay: '2026-08-08',
      qualifiedSessionCount: 5,
    };
    const first = claimReviewPrompt(eligible, START + 7 * DAY);
    const second = claimReviewPrompt(first.state, START + 8 * DAY);

    expect(first.claimed).toBe(true);
    expect(first.state?.promptShownAt).toBe(START + 7 * DAY);
    expect(second.claimed).toBe(false);
  });

  it('builds the official direct review URL from the runtime extension id', () => {
    expect(chromeWebStoreReviewUrl('abc123')).toBe(
      'https://chrome.google.com/webstore/detail/abc123/reviews',
    );
  });
});
