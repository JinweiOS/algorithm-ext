import { buildLeetCodeAmbientTypes } from '../../monaco/typescript-diagnostics';
import {
  createTypeScriptService,
  type TypeScriptService,
} from './ts-language-service';
import type { DiagnosticMarker } from '../../../utils/protocol';

const DIAGNOSTICS_DEBOUNCE_MS = 250;

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
}

type WorkerRequest =
  | { id: number; method: 'init'; params: { libBaseUrl: string; allowJs: boolean } }
  | { id: number; method: 'open' | 'update'; params: { uri: string; text: string; version: number } }
  | { id: number; method: 'close'; params: { uri: string } }
  | {
      id: number;
      method: 'completion' | 'hover' | 'signatureHelp';
      params: { uri: string; line: number; character: number };
    };

interface DiagnosticsPush {
  type: 'diagnostics';
  uri: string;
  version: number;
  markers: DiagnosticMarker[];
}

const scope = globalThis as unknown as WorkerScope;
let service: TypeScriptService | undefined;
let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
const pendingDiagnostics = new Map<string, { uri: string; version: number }>();

scope.onmessage = (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isWorkerRequest(request)) return;
  void handle(request);
};

async function handle(request: WorkerRequest): Promise<void> {
  try {
    const result = await dispatch(request);
    scope.postMessage({ id: request.id, result });
  } catch (error) {
    scope.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function dispatch(request: WorkerRequest): Promise<unknown> {
  if (request.method === 'init') {
    return initialize(request.params.libBaseUrl, request.params.allowJs);
  }

  if (!service) throw new Error('TypeScript service is not initialized');

  switch (request.method) {
    case 'open':
    case 'update': {
      const fileName = fileNameOf(request.params.uri);
      if (request.method === 'open') {
        service.open(fileName, request.params.text, request.params.version);
      } else {
        service.update(fileName, request.params.text, request.params.version);
      }
      scheduleDiagnostics(fileName, request.params.uri, request.params.version);
      return null;
    }
    case 'close': {
      const fileName = fileNameOf(request.params.uri);
      service.close(fileName);
      pendingDiagnostics.delete(fileName);
      return null;
    }
    case 'completion': {
      const fileName = fileNameOf(request.params.uri);
      return service.completion(fileName, {
        line: request.params.line,
        character: request.params.character,
      });
    }
    case 'hover': {
      const fileName = fileNameOf(request.params.uri);
      return service.hover(fileName, {
        line: request.params.line,
        character: request.params.character,
      });
    }
    case 'signatureHelp': {
      const fileName = fileNameOf(request.params.uri);
      return service.signatureHelp(fileName, {
        line: request.params.line,
        character: request.params.character,
      });
    }
  }
}

async function initialize(libBaseUrl: string, allowJs: boolean): Promise<unknown> {
  const response = await fetch(new URL('lib-bundle.json', libBaseUrl));
  if (!response.ok) {
    throw new Error(`TypeScript lib bundle unavailable (${response.status})`);
  }
  const sources = (await response.json()) as Record<string, string>;
  service?.dispose();
  service = createTypeScriptService({
    libSources: new Map(Object.entries(sources)),
    allowJs,
    ambientTypes: buildLeetCodeAmbientTypes,
  });
  return { libs: Object.keys(sources).length };
}

function scheduleDiagnostics(fileName: string, uri: string, version: number): void {
  pendingDiagnostics.set(fileName, { uri, version });
  if (diagnosticsTimer !== undefined) clearTimeout(diagnosticsTimer);
  diagnosticsTimer = setTimeout(() => {
    diagnosticsTimer = undefined;
    if (!service) return;
    for (const [pendingFile, pending] of pendingDiagnostics) {
      const markers = service.diagnostics(pendingFile);
      const push: DiagnosticsPush = {
        type: 'diagnostics',
        uri: pending.uri,
        version: pending.version,
        markers,
      };
      scope.postMessage(push);
    }
    pendingDiagnostics.clear();
  }, DIAGNOSTICS_DEBOUNCE_MS);
}

function fileNameOf(uri: string): string {
  try {
    return new URL(uri).pathname;
  } catch {
    return uri;
  }
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'number' &&
    typeof (value as { method?: unknown }).method === 'string' &&
    typeof (value as { params?: unknown }).params === 'object'
  );
}
