import { afterEach, describe, expect, it, vi } from 'vitest';

import { performanceLog } from '../lib/observability/performance-log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('performance logger', () => {
  it('emits structured metadata while dropping user content and objects', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    performanceLog('debug', 'feature.complete', {
      language: 'cpp',
      method: 'completion',
      durationMs: 123,
      outcome: 'ok',
      text: 'private user source',
      response: { items: ['private completion'] },
    });

    expect(debug).toHaveBeenCalledWith(
      '[LeetSense][perf] feature.complete {"language":"cpp","method":"completion","durationMs":123,"outcome":"ok"}',
    );
  });
});
