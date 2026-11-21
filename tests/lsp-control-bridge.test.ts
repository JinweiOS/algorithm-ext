import { describe, expect, it } from 'vitest';

import {
  toBridgeControlResult,
  toEngineControlRequest,
} from '../lib/bridge/lsp-control';
import { BRIDGE_CHANNEL } from '../utils/protocol';

describe('LSP lifecycle control bridge', () => {
  it('preserves correlation, language, and action across both trust boundaries', () => {
    const engine = toEngineControlRequest({
      channel: BRIDGE_CHANNEL,
      direction: 'TO_EXTENSION',
      requestId: 'control-7',
      type: 'LSP_CONTROL',
      payload: { language: 'cpp', action: 'restart' },
    });
    expect(engine).toEqual({
      id: 'control-7',
      language: 'cpp',
      method: 'control',
      action: 'restart',
    });

    expect(
      toBridgeControlResult({
        id: engine.id,
        type: 'CONTROL_ACK',
        language: engine.language,
        action: engine.action,
        error: 'Restart failed',
      }),
    ).toEqual({
      channel: BRIDGE_CHANNEL,
      direction: 'FROM_EXTENSION',
      requestId: 'control-7',
      type: 'LSP_CONTROL_RESULT',
      payload: { language: 'cpp', action: 'restart' },
      error: 'Restart failed',
    });
  });
});
