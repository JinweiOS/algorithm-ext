const MINIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MINIMUM_ACTIVE_DAYS = 3;
const MINIMUM_QUALIFIED_SESSIONS = 5;

export interface ReviewPromptState {
  firstQualifiedUseAt: number;
  qualifiedDayCount: number;
  lastQualifiedDay: string;
  qualifiedSessionCount: number;
  promptShownAt?: number;
}

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function recordQualifiedSession(
  current: ReviewPromptState | undefined,
  timestamp: number,
): ReviewPromptState {
  const day = localDayKey(timestamp);
  if (!current) {
    return {
      firstQualifiedUseAt: timestamp,
      qualifiedDayCount: 1,
      lastQualifiedDay: day,
      qualifiedSessionCount: 1,
    };
  }

  return {
    ...current,
    qualifiedDayCount:
      current.lastQualifiedDay === day
        ? current.qualifiedDayCount
        : current.qualifiedDayCount + 1,
    lastQualifiedDay: day,
    qualifiedSessionCount: current.qualifiedSessionCount + 1,
  };
}

export function isReviewPromptEligible(
  state: ReviewPromptState | undefined,
  timestamp: number,
): boolean {
  return Boolean(
    state &&
      state.promptShownAt === undefined &&
      timestamp - state.firstQualifiedUseAt >= MINIMUM_AGE_MS &&
      state.qualifiedDayCount >= MINIMUM_ACTIVE_DAYS &&
      state.qualifiedSessionCount >= MINIMUM_QUALIFIED_SESSIONS,
  );
}

export function claimReviewPrompt(
  state: ReviewPromptState | undefined,
  timestamp: number,
): { state: ReviewPromptState | undefined; claimed: boolean } {
  if (!isReviewPromptEligible(state, timestamp) || !state) {
    return { state, claimed: false };
  }
  return {
    state: { ...state, promptShownAt: timestamp },
    claimed: true,
  };
}
