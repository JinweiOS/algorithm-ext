import type {
  CompletionItem as LspCompletionItem,
  CompletionList,
  Diagnostic,
  Hover,
  MarkedString,
  MarkupContent,
  PublishDiagnosticsParams,
  SignatureHelp,
} from 'vscode-languageserver-protocol';

import {
  MAX_COMPLETION_ITEMS,
  MAX_DIAGNOSTICS,
  type CompletionItem,
  type CompletionResult,
  type DiagnosticsParams,
  type HoverResult,
  type PositionParams,
  type SignatureHelpResult,
} from '../../../utils/protocol';
import {
  createEngineDocument,
  diagnosticToMarker,
  toEnginePosition,
} from './doc-manager';
import { EngineRequestTimeoutError } from '../shared/request-timeout';

const ROOT_URI = 'file:///src/';
const WARMUP_URI = `${ROOT_URI}warmup.cpp`;
const ENGINE_REQUEST_TIMEOUT_MS = 30_000;
const FEATURE_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROTOCOL_STRING_LENGTH = 20_000;
const MAX_LABEL_LENGTH = 1_000;
const MAX_DETAIL_LENGTH = 4_000;
const MAX_SORT_TEXT_LENGTH = 1_000;
const MAX_SIGNATURES = 100;
const MAX_PARAMETERS = 100;
const COMPLETION_DOCUMENTATION_LIMIT = 100;

interface ClangdClientOptions {
  onDiagnostics(params: PublishDiagnosticsParams): void;
  onCrash(error: Error, client: ClangdClient): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WorkerFrame {
  type: 'ready' | 'lsp' | 'crash';
  message?: Record<string, unknown>;
  error?: string;
}

export class ClangdClient {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnosticsWaiters = new Map<
    string,
    {
      resolve(): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private nextRequestId = 1;
  private disposed = false;
  private crashReported = false;

  private constructor(private readonly options: ClangdClientOptions) {}

  static async create(options: ClangdClientOptions): Promise<ClangdClient> {
    const client = new ClangdClient(options);
    await client.initialize();
    await client.warmup();
    return client;
  }

  async openDocument(uri: string, text: string, version: number): Promise<void> {
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'cpp',
        version,
        text: createEngineDocument(text),
      },
    });
  }

  async updateDocument(uri: string, text: string, version: number): Promise<void> {
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: createEngineDocument(text) }],
    });
  }

  async closeDocument(uri: string): Promise<void> {
    if (!this.worker || this.disposed) return;
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  async completion(
    uri: string,
    position: PositionParams,
  ): Promise<CompletionResult> {
    const result = (await this.featureRequest('textDocument/completion', {
      textDocument: { uri },
      position: toEnginePosition(position),
    })) as CompletionList | LspCompletionItem[] | null;
    const items = Array.isArray(result) ? result : (result?.items ?? []);
    return {
      items: items.slice(0, MAX_COMPLETION_ITEMS).map(mapCompletionItem),
    };
  }

  async hover(uri: string, position: PositionParams): Promise<HoverResult> {
    const result = (await this.featureRequest('textDocument/hover', {
      textDocument: { uri },
      position: toEnginePosition(position),
    })) as Hover | null;
    return { contents: result ? hoverToMarkdown(result) : null };
  }

  async signatureHelp(
    uri: string,
    position: PositionParams,
  ): Promise<SignatureHelpResult> {
    const result = (await this.featureRequest('textDocument/signatureHelp', {
      textDocument: { uri },
      position: toEnginePosition(position),
    })) as SignatureHelp | null;
    if (!result) return { signatures: [] };
    return {
      signatures: result.signatures.slice(0, MAX_SIGNATURES).map((signature) => ({
        label: trim(signature.label, MAX_LABEL_LENGTH),
        ...(signature.documentation
          ? { documentation: documentationToMarkdown(signature.documentation) }
          : {}),
        ...(signature.parameters
          ? {
              parameters: signature.parameters
                .slice(0, MAX_PARAMETERS)
                .map((parameter) => ({
                  label: Array.isArray(parameter.label)
                    ? [parameter.label[0], parameter.label[1]] as [number, number]
                    : trim(parameter.label, MAX_LABEL_LENGTH),
                  ...(parameter.documentation
                    ? {
                        documentation: documentationToMarkdown(
                          parameter.documentation,
                        ),
                      }
                    : {}),
                })),
            }
          : {}),
      })),
      ...(result.activeSignature === undefined
        ? {}
        : { activeSignature: result.activeSignature }),
      ...(result.activeParameter === undefined || result.activeParameter === null
        ? {}
        : { activeParameter: result.activeParameter }),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('clangd was disposed'));
    }
    this.pending.clear();
    for (const waiter of this.diagnosticsWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('clangd was disposed'));
    }
    this.diagnosticsWaiters.clear();
    this.worker?.terminate();
    this.worker = undefined;
  }

  private async initialize(): Promise<void> {
    const worker = new Worker(
      new URL('./clangd-host.worker.ts', import.meta.url),
      { type: 'module', name: 'LeetSense clangd host' },
    );
    this.worker = worker;

    const ready = new Promise<void>((resolve, reject) => {
      const handleReady = (event: MessageEvent<WorkerFrame>) => {
        if (event.data.type === 'ready') {
          worker.removeEventListener('message', handleReady);
          resolve();
        } else if (event.data.type === 'crash') {
          worker.removeEventListener('message', handleReady);
          reject(new Error(event.data.error ?? 'clangd failed to boot'));
        }
      };
      worker.addEventListener('message', handleReady);
    });
    worker.addEventListener('message', (event: MessageEvent<WorkerFrame>) => {
      this.handleWorkerFrame(event.data);
    });
    worker.addEventListener('error', (event) => {
      this.reportCrash(new Error(event.message || 'clangd worker failed'));
    });
    worker.postMessage({
      type: 'boot',
      clangdJsUrl: browser.runtime.getURL('/clangd/clangd.js'),
      wasmUrl: browser.runtime.getURL('/clangd/clangd.wasm'),
      pthreadWorkerUrl: browser.runtime.getURL('/clangd/clangd.worker.mjs'),
      resourcePackUrl: browser.runtime.getURL(
        '/clangd/clang-resource-headers.pack.gz',
      ),
    });
    await ready;

    await this.request('initialize', {
      processId: null,
      rootUri: ROOT_URI,
      capabilities: {
        textDocument: {
          completion: {
            completionItem: {
              snippetSupport: true,
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {},
          publishDiagnostics: { versionSupport: true },
        },
      },
      workspaceFolders: [{ uri: ROOT_URI, name: 'src' }],
    });
    this.notify('initialized', {});
  }

  private async warmup(): Promise<void> {
    const parsed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.diagnosticsWaiters.delete(WARMUP_URI);
        reject(new Error('clangd prelude warmup timed out'));
      }, ENGINE_REQUEST_TIMEOUT_MS);
      this.diagnosticsWaiters.set(WARMUP_URI, { resolve, reject, timeout });
    });
    await this.openDocument(WARMUP_URI, '', 0);
    await parsed;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.requestWithTimeout(method, params, ENGINE_REQUEST_TIMEOUT_MS);
  }

  private featureRequest(method: string, params: unknown): Promise<unknown> {
    return this.requestWithTimeout(
      method,
      params,
      FEATURE_REQUEST_TIMEOUT_MS,
      true,
    );
  }

  private requestWithTimeout(
    method: string,
    params: unknown,
    timeoutMs: number,
    featureRequest = false,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          featureRequest
            ? new EngineRequestTimeoutError('clangd', method)
            : new Error(`${method} timed out`),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.post({ jsonrpc: '2.0', method, params });
  }

  private post(message: Record<string, unknown>): void {
    if (!this.worker || this.disposed) throw new Error('clangd is unavailable');
    this.worker.postMessage({ type: 'send', message });
  }

  private handleWorkerFrame(frame: WorkerFrame): void {
    if (frame.type === 'crash') {
      this.reportCrash(new Error(frame.error ?? 'clangd crashed'));
      return;
    }
    if (frame.type !== 'lsp' || !frame.message) return;
    const message = frame.message;
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as PublishDiagnosticsParams;
      this.options.onDiagnostics(params);
      const waiter = this.diagnosticsWaiters.get(params.uri);
      if (waiter) {
        this.diagnosticsWaiters.delete(params.uri);
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
      return;
    }
    if (typeof message.method === 'string' && message.id !== undefined) {
      const result = message.method === 'workspace/configuration' ? [] : null;
      this.post({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (isRecord(message.error)) {
      pending.reject(new Error(String(message.error.message ?? 'clangd error')));
    } else {
      pending.resolve(message.result);
    }
  }

  private reportCrash(error: Error): void {
    if (this.disposed || this.crashReported) return;
    this.crashReported = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.diagnosticsWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.diagnosticsWaiters.clear();
    this.options.onCrash(error, this);
  }
}

export function clangdDiagnosticsToProtocol(
  params: PublishDiagnosticsParams,
  fallbackVersion: number,
): DiagnosticsParams {
  return {
    uriVersion: params.version ?? fallbackVersion,
    markers: params.diagnostics
      .slice(0, MAX_DIAGNOSTICS)
      .map((diagnostic: Diagnostic) => diagnosticToMarker(diagnostic))
      .filter((marker) => marker !== null)
      .map((marker) => ({
        ...marker,
        message: trim(marker.message),
        ...(marker.code ? { code: trim(marker.code, MAX_LABEL_LENGTH) } : {}),
      })),
  };
}

function mapCompletionItem(item: LspCompletionItem, index: number): CompletionItem {
  const documentation =
    index < COMPLETION_DOCUMENTATION_LIMIT && item.documentation
      ? documentationToMarkdown(item.documentation)
      : undefined;
  const insertText =
    item.insertText ??
    (item.textEdit && 'newText' in item.textEdit
      ? item.textEdit.newText
      : undefined);
  return {
    label: trim(item.label, MAX_LABEL_LENGTH),
    kind: item.kind && item.kind > 0 ? item.kind : 1,
    ...(item.detail ? { detail: trim(item.detail, MAX_DETAIL_LENGTH) } : {}),
    ...(documentation ? { documentation } : {}),
    ...(insertText ? { insertText: trim(insertText) } : {}),
    ...(item.sortText
      ? { sortText: trim(item.sortText, MAX_SORT_TEXT_LENGTH) }
      : {}),
    ...(item.filterText
      ? { filterText: trim(item.filterText, MAX_SORT_TEXT_LENGTH) }
      : {}),
    ...(item.insertTextFormat === 1 || item.insertTextFormat === 2
      ? { insertTextFormat: item.insertTextFormat }
      : {}),
  };
}

function hoverToMarkdown(hover: Hover): string {
  if (Array.isArray(hover.contents)) {
    return trim(hover.contents.map(markedStringToMarkdown).join('\n\n'));
  }
  if (typeof hover.contents === 'string') return trim(hover.contents);
  if ('kind' in hover.contents) return trim(hover.contents.value);
  return trim(markedStringToMarkdown(hover.contents));
}

function markedStringToMarkdown(value: MarkedString): string {
  return typeof value === 'string'
    ? value
    : `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

function documentationToMarkdown(value: string | MarkupContent): string {
  return trim(typeof value === 'string' ? value : value.value);
}

function trim(value: string, maxLength = MAX_PROTOCOL_STRING_LENGTH): string {
  return value.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
