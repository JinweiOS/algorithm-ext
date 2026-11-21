import { describe, expect, it } from 'vitest';

import {
  BRIDGE_CHANNEL,
  MAX_DOCUMENT_LENGTH,
  MAX_STATUS_DETAIL_LENGTH,
  isActionStateMessage,
  isBridgeIncomingFrame,
  isBridgeRequest,
  isEngineControlAck,
  isEngineFrame,
  isEngineRequest,
  isReviewPromptRuntimeMessage,
  isReviewPromptRuntimeResponse,
} from '../utils/protocol';

describe('protocol v3 validators', () => {
  it('accepts all page request methods', () => {
    const base = {
      channel: BRIDGE_CHANNEL,
      direction: 'TO_EXTENSION',
      requestId: 'request-1',
    } as const;

    expect(isBridgeRequest({ ...base, type: 'PING' })).toBe(true);
    for (const type of ['COMPLETION', 'HOVER', 'SIGNATURE_HELP'] as const) {
      expect(
        isBridgeRequest({
          ...base,
          type,
          payload: { language: 'python3', line: 1, character: 2 },
        }),
      ).toBe(true);
    }
    expect(
      isBridgeRequest({
        channel: BRIDGE_CHANNEL,
        direction: 'TO_EXTENSION',
        type: 'DOC_SYNC',
        payload: { language: 'python3', text: 'x = 1', version: 3 },
      }),
    ).toBe(true);
    expect(
      isBridgeRequest({
        ...base,
        type: 'COMPLETION',
        payload: { language: 'python', line: 1, character: 2 },
      }),
    ).toBe(true);
  });

  it('validates correlated lifecycle control frames without treating them as feature results', () => {
    const bridgeRequest = {
      channel: BRIDGE_CHANNEL,
      direction: 'TO_EXTENSION',
      requestId: 'control-1',
      type: 'LSP_CONTROL',
      payload: { language: 'cpp', action: 'restart' },
    };
    expect(isBridgeRequest(bridgeRequest)).toBe(true);
    expect(
      isBridgeRequest({
        ...bridgeRequest,
        payload: { language: 'python', action: 'restart' },
      }),
    ).toBe(false);
    expect(
      isBridgeRequest({
        ...bridgeRequest,
        payload: { language: 'cpp', action: 'reset' },
      }),
    ).toBe(false);

    expect(
      isBridgeIncomingFrame({
        channel: BRIDGE_CHANNEL,
        direction: 'FROM_EXTENSION',
        requestId: 'control-1',
        type: 'LSP_CONTROL_RESULT',
        payload: { language: 'cpp', action: 'restart' },
      }),
    ).toBe(true);

    const engineRequest = {
      id: 'control-1',
      language: 'python3',
      method: 'control',
      action: 'stop',
    };
    expect(isEngineRequest(engineRequest)).toBe(true);
    expect(isEngineRequest({ ...engineRequest, language: 'python' })).toBe(false);

    const ack = {
      id: 'control-1',
      type: 'CONTROL_ACK',
      language: 'python3',
      action: 'stop',
    };
    expect(isEngineControlAck(ack)).toBe(true);
    expect(isEngineFrame(ack)).toBe(true);
    expect(isEngineControlAck({ ...ack, action: 'reset' })).toBe(false);
  });

  it('validates review eligibility and one-time claim messages', () => {
    expect(
      isBridgeRequest({
        channel: BRIDGE_CHANNEL,
        direction: 'TO_EXTENSION',
        requestId: 'review-1',
        type: 'REVIEW_PROMPT_CLAIM',
      }),
    ).toBe(true);
    expect(
      isBridgeIncomingFrame({
        channel: BRIDGE_CHANNEL,
        direction: 'FROM_EXTENSION',
        type: 'REVIEW_PROMPT_ELIGIBLE',
      }),
    ).toBe(true);
    expect(
      isBridgeIncomingFrame({
        channel: BRIDGE_CHANNEL,
        direction: 'FROM_EXTENSION',
        requestId: 'review-1',
        type: 'REVIEW_PROMPT_CLAIM_RESULT',
        payload: {
          claimed: true,
          reviewUrl: 'https://chrome.google.com/webstore/detail/id/reviews',
        },
      }),
    ).toBe(true);
    expect(
      isReviewPromptRuntimeMessage({
        type: 'REVIEW_PROMPT',
        action: 'qualified-session',
      }),
    ).toBe(true);
    expect(
      isReviewPromptRuntimeResponse({ ok: true, claimed: false }),
    ).toBe(true);
  });

  it('rejects malformed and oversized document sync frames', () => {
    const request = {
      channel: BRIDGE_CHANNEL,
      direction: 'TO_EXTENSION',
      type: 'DOC_SYNC',
      payload: { language: 'cpp', text: 'x', version: 1 },
    };

    expect(isBridgeRequest(request)).toBe(true);
    expect(
      isBridgeRequest({ ...request, payload: { text: 'x', version: -1 } }),
    ).toBe(false);
    expect(
      isBridgeRequest({
        ...request,
        payload: { text: 'x'.repeat(MAX_DOCUMENT_LENGTH + 1), version: 1 },
      }),
    ).toBe(false);
  });

  it('validates enriched feature results and diagnostics pushes', () => {
    expect(
      isBridgeIncomingFrame({
        channel: BRIDGE_CHANNEL,
        direction: 'FROM_EXTENSION',
        requestId: 'request-1',
        response: {
          items: [
            {
              label: 'append',
              kind: 2,
              detail: '(object: _T) -> None',
              documentation: 'Append an item.',
              insertText: 'append',
              sortText: '0001',
              filterText: 'append',
              insertTextFormat: 2,
            },
          ],
        },
      }),
    ).toBe(true);

    const diagnostics = {
      method: 'diagnostics',
      params: {
        uriVersion: 4,
        markers: [
          {
            startLine: 0,
            startCol: 0,
            endLine: 0,
            endCol: 1,
            severity: 1,
            message: 'Type error',
            code: 'reportArgumentType',
          },
        ],
      },
    };
    expect(isEngineFrame(diagnostics)).toBe(true);
    expect(
      isBridgeIncomingFrame({
        channel: BRIDGE_CHANNEL,
        direction: 'FROM_EXTENSION',
        type: 'DIAGNOSTICS',
        payload: diagnostics.params,
      }),
    ).toBe(true);
  });

  it('accepts valid status pushes and rejects malformed status state or detail', () => {
    const engineStatus = {
      type: 'STATUS',
      language: 'cpp',
      state: 'restarting',
      detail: 'Engine stopped responding',
    };
    expect(isEngineFrame(engineStatus)).toBe(true);
    expect(
      isBridgeIncomingFrame({
        channel: BRIDGE_CHANNEL,
        direction: 'FROM_EXTENSION',
        ...engineStatus,
      }),
    ).toBe(true);
    expect(isEngineFrame({ ...engineStatus, state: 'retrying' })).toBe(false);
    expect(isEngineFrame({ ...engineStatus, state: 'stopped' })).toBe(true);
    expect(
      isEngineFrame({
        ...engineStatus,
        detail: 'x'.repeat(MAX_STATUS_DETAIL_LENGTH + 1),
      }),
    ).toBe(false);
  });

  it('rejects invalid completion items and diagnostic severities', () => {
    expect(
      isEngineFrame({
        id: 'request-1',
        result: { items: [{ label: 'x', kind: 0 }] },
      }),
    ).toBe(false);
    expect(
      isEngineFrame({
        method: 'diagnostics',
        params: {
          uriVersion: 1,
          markers: [
            {
              startLine: 0,
              startCol: 0,
              endLine: 0,
              endCol: 1,
              severity: 8,
              message: 'bad',
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it('requires correlation only for feature requests', () => {
    expect(
      isEngineRequest({
        language: 'python3',
        method: 'docSync',
        params: { text: '', version: 0 },
      }),
    ).toBe(true);
    expect(
      isEngineRequest({
        language: 'cpp',
        method: 'completion',
        params: { line: 0, character: 0 },
      }),
    ).toBe(false);
  });

  it('requires language routing and rejects removed config frames', () => {
    expect(
      isBridgeRequest({
        channel: BRIDGE_CHANNEL,
        direction: 'TO_EXTENSION',
        requestId: 'request-1',
        type: 'HOVER',
        payload: { line: 0, character: 0 },
      }),
    ).toBe(false);
    expect(
      isEngineRequest({
        method: 'config',
        params: { enabledLanguages: ['python3', 'cpp'] },
      }),
    ).toBe(false);
    expect(
      isBridgeIncomingFrame({
        channel: BRIDGE_CHANNEL,
        direction: 'FROM_EXTENSION',
        type: 'CONFIG',
        payload: { enabledLanguages: ['python3', 'cpp'] },
      }),
    ).toBe(false);
  });

  it('accepts action-state messages for engine and page-owned services', () => {
    expect(
      isActionStateMessage({ type: 'ACTION_STATE', language: 'python3', active: true }),
    ).toBe(true);
    expect(
      isActionStateMessage({ type: 'ACTION_STATE', language: 'cpp', active: false }),
    ).toBe(true);
    expect(
      isActionStateMessage({ type: 'ACTION_STATE', language: 'javascript', active: true }),
    ).toBe(true);
    expect(
      isActionStateMessage({ type: 'ACTION_STATE', language: 'typescript', active: false }),
    ).toBe(true);
    expect(
      isActionStateMessage({ type: 'ACTION_STATE', language: 'cpp', active: 'yes' }),
    ).toBe(false);
    expect(
      isActionStateMessage({ type: 'ACTION_STATE', language: 'java', active: true }),
    ).toBe(false);
    expect(isActionStateMessage({ type: 'STATUS', language: 'cpp', active: true })).toBe(false);
  });

  it('accepts service-state reports only for known status languages', () => {
    expect(
      isBridgeRequest({
        channel: BRIDGE_CHANNEL,
        direction: 'TO_EXTENSION',
        type: 'SERVICE_STATE',
        payload: { language: 'typescript', active: true },
      }),
    ).toBe(true);
    expect(
      isBridgeRequest({
        channel: BRIDGE_CHANNEL,
        direction: 'TO_EXTENSION',
        type: 'SERVICE_STATE',
        payload: { language: 'rust', active: true },
      }),
    ).toBe(false);
    expect(
      isBridgeRequest({
        channel: BRIDGE_CHANNEL,
        direction: 'TO_EXTENSION',
        type: 'SERVICE_STATE',
        payload: { language: 'typescript' },
      }),
    ).toBe(false);
  });
});
