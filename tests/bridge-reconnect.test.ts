import { describe, expect, it } from 'vitest';

import { BridgeReconnectPolicy } from '../lib/bridge/reconnect-policy';
import { replayEngineSession } from '../lib/bridge/session-replay';

describe('bridge reconnect policy', () => {
  it('limits automatic retries without wedging later user demand', () => {
    const policy = new BridgeReconnectPolicy(1);

    expect(policy.beginConnection('automatic')).toBe(1);
    expect(policy.beginConnection('automatic')).toBeUndefined();
    expect(policy.beginConnection('demand')).toBe(1);

    policy.recordResponse();
    expect(policy.beginConnection('automatic')).toBe(1);
  });

  it('replays the latest document before in-flight features after reconnect', () => {
    const frames: unknown[] = [];
    const sync = {
      language: 'cpp' as const,
      method: 'docSync' as const,
      params: { text: 'vector<int> values;', version: 4 },
    };
    const feature = {
      id: 'completion-1',
      language: 'cpp' as const,
      method: 'completion' as const,
      params: { line: 0, character: 19 },
    };

    replayEngineSession((frame) => frames.push(frame), sync, [feature]);

    expect(frames).toEqual([sync, feature]);
  });

  it('never replays a lifecycle control after reconnect', () => {
    const frames: unknown[] = [];
    const control = {
      id: 'control-1',
      language: 'cpp' as const,
      method: 'control' as const,
      action: 'restart' as const,
    };

    replayEngineSession(
      (frame) => frames.push(frame),
      undefined,
      [control] as never,
    );

    expect(frames).toEqual([]);
  });
});
