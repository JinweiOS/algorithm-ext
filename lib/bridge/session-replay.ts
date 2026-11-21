import type {
  EngineDocumentSyncRequest,
  EngineFeatureRequest,
  EngineRequest,
} from '../../utils/protocol';

export function replayEngineSession(
  postMessage: (frame: EngineRequest) => void,
  document: EngineDocumentSyncRequest | undefined,
  features: EngineFeatureRequest[],
): void {
  if (document) postMessage(document);
  for (const feature of features) {
    if (
      feature.method === 'completion' ||
      feature.method === 'hover' ||
      feature.method === 'signatureHelp'
    ) {
      postMessage(feature);
    }
  }
}
