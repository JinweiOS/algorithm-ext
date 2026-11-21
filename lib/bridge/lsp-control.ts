import {
  BRIDGE_CHANNEL,
  type BridgeLspControlRequest,
  type BridgeLspControlResult,
  type EngineControlAck,
  type EngineControlRequest,
} from '../../utils/protocol';

export function toEngineControlRequest(
  request: BridgeLspControlRequest,
): EngineControlRequest {
  return {
    id: request.requestId,
    language: request.payload.language,
    method: 'control',
    action: request.payload.action,
  };
}

export function toBridgeControlResult(
  ack: EngineControlAck,
): BridgeLspControlResult {
  return {
    channel: BRIDGE_CHANNEL,
    direction: 'FROM_EXTENSION',
    requestId: ack.id,
    type: 'LSP_CONTROL_RESULT',
    payload: { language: ack.language, action: ack.action },
    ...(ack.error ? { error: ack.error } : {}),
  };
}
