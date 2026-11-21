import type { Diagnostic, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';

import {
  MAX_DIAGNOSTICS,
  type CompletionResult,
  type DiagnosticMarker,
  type DiagnosticsParams,
  type HoverResult,
  type PositionParams,
  type SignatureHelpResult,
} from '../../../utils/protocol';
import { createDocumentMapper } from '../shared/document-mapper';
import { withEngineRequestTimeout } from '../shared/request-timeout';

const FEATURE_REQUEST_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 20_000;
const BOOT_CHECK_URI = 'file:///src/__leetsense_boot__.ts';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface WorkerMessage {
  id?: number;
  result?: unknown;
  error?: string;
  type?: 'diagnostics';
  uri?: string;
  version?: number;
  markers?: Array<{
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    severity: 1 | 2 | 3 | 4;
    message: string;
    code?: string;
  }>;
}

export interface TypeScriptClientOptions {
  onDiagnostics(params: PublishDiagnosticsParams): void;
  onCrash(error: Error, client: TypeScriptClient): void;
  /** JavaScript keeps JSX/JS semantics and skips type errors. */
  allowJs?: boolean;
}

/**
 * Speaks to the offscreen TypeScript language-service worker. Unlike the Pyright
 * and clangd clients this is not LSP-over-postMessage: the worker runs the
 * compiler API directly, and this class adapts its four answers into the same
 * `LanguageClient` shape the shared backend already drives.
 */
export class TypeScriptClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private disposed = false;
  private crashReported = false;

  private constructor(private readonly options: TypeScriptClientOptions) {
    this.worker = new Worker(new URL('./ts-service.worker.ts', import.meta.url), {
      type: 'module',
      name: 'LeetSense TypeScript',
    });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      this.handleMessage(event.data);
    });
    this.worker.addEventListener('error', (event) => {
      this.reportCrash(new Error(event.message || 'TypeScript worker failed'));
    });
  }

  static async create(options: TypeScriptClientOptions): Promise<TypeScriptClient> {
    const client = new TypeScriptClient(options);
    await client.initialize();
    await client.verifyWithScratchCompletion();
    return client;
  }

  async openDocument(uri: string, text: string, version: number): Promise<void> {
    await this.request('open', { uri, text, version });
  }

  async updateDocument(uri: string, text: string, version: number): Promise<void> {
    await this.request('update', { uri, text, version });
  }

  async closeDocument(uri: string): Promise<void> {
    if (this.disposed) return;
    await this.request('close', { uri }).catch(() => {});
  }

  async completion(uri: string, position: PositionParams): Promise<CompletionResult> {
    return (await this.request('completion', { uri, ...position })) as CompletionResult;
  }

  async hover(uri: string, position: PositionParams): Promise<HoverResult> {
    return (await this.request('hover', { uri, ...position })) as HoverResult;
  }

  async signatureHelp(
    uri: string,
    position: PositionParams,
  ): Promise<SignatureHelpResult> {
    return (await this.request('signatureHelp', {
      uri,
      ...position,
    })) as SignatureHelpResult;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.reject(new Error('TypeScript service disposed'));
    }
    this.pending.clear();
  }

  private async initialize(): Promise<void> {
    // WXT narrows `getURL` to its own public paths; the lib bundle is added to
    // `public/` by scripts/build-typescript-lib.mjs, so the cast is safe.
    const publicUrl = browser.runtime.getURL as (path: string) => string;
    await this.request('init', {
      libBaseUrl: publicUrl('/tslib/'),
      allowJs: this.options.allowJs === true,
    });
  }

  private async verifyWithScratchCompletion(): Promise<void> {
    const text = 'const values = [];\nvalues.';
    await this.openDocument(BOOT_CHECK_URI, text, 0);
    try {
      const result = await this.completion(BOOT_CHECK_URI, { line: 2, character: 8 });
      if (!result.items.some((item) => item.label === 'concat')) {
        throw new Error('TypeScript boot check did not return Array.concat');
      }
      console.info('[LeetSense] TypeScript service boot check returned Array.concat');
    } finally {
      await this.closeDocument(BOOT_CHECK_URI);
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('TypeScript service disposed'));
    const id = ++this.nextId;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params });
    });
    return withEngineRequestTimeout(
      response,
      FEATURE_REQUEST_TIMEOUT_MS,
      'TypeScript',
      method,
    ).finally(() => {
      this.pending.delete(id);
    });
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.type === 'diagnostics') {
      if (typeof message.uri !== 'string' || !Array.isArray(message.markers)) return;
      this.options.onDiagnostics({
        uri: message.uri,
        version: message.version,
        diagnostics: message.markers
          .slice(0, MAX_DIAGNOSTICS)
          .map(toLspDiagnostic),
      });
      return;
    }

    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  private reportCrash(error: Error): void {
    if (this.disposed || this.crashReported) return;
    this.crashReported = true;
    this.options.onCrash(error, this);
  }
}

function toLspDiagnostic(marker: NonNullable<WorkerMessage['markers']>[number]): Diagnostic {
  return {
    range: {
      start: { line: marker.startLine, character: marker.startCol },
      end: { line: marker.endLine, character: marker.endCol },
    },
    severity: marker.severity,
    message: marker.message,
    ...(marker.code ? { code: marker.code } : {}),
    source: '速写',
  };
}

const identityMapper = createDocumentMapper({ prelude: '', preludeLineCount: 0 });

export function typescriptDiagnosticsToProtocol(
  params: PublishDiagnosticsParams,
  fallbackVersion: number,
): DiagnosticsParams {
  const markers: DiagnosticMarker[] = [];
  for (const diagnostic of params.diagnostics.slice(0, MAX_DIAGNOSTICS)) {
    const marker = identityMapper.diagnosticToMarker(diagnostic);
    if (!marker) continue;
    markers.push({
      ...marker,
      message: marker.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
      ...(marker.code ? { code: marker.code.slice(0, 1_000) } : {}),
    });
  }
  return {
    uriVersion: params.version ?? fallbackVersion,
    markers,
  };
}
