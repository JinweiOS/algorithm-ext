import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/browser';
import {
  CompletionRequest,
  DiagnosticTag,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  SignatureHelpRequest,
  type CompletionItem as LspCompletionItem,
  type CompletionList,
  type Hover,
  type InitializeParams,
  type MarkedString,
  type MarkupContent,
  type PublishDiagnosticsParams,
  type SignatureHelp,
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
import { withEngineRequestTimeout } from '../shared/request-timeout';

const ROOT_PATH = '/src/';
const ROOT_URI = `file://${ROOT_PATH}`;
const FEATURE_REQUEST_TIMEOUT_MS = 15_000;
const COMPLETION_DOCUMENTATION_LIMIT = 100;
const MAX_PROTOCOL_STRING_LENGTH = 20_000;
const MAX_LABEL_LENGTH = 1_000;
const MAX_DETAIL_LENGTH = 4_000;
const MAX_SORT_TEXT_LENGTH = 1_000;
const MAX_SIGNATURES = 100;
const MAX_PARAMETERS = 100;

interface NewWorkerMessage {
  type: 'browser/newWorker';
  initialData: unknown;
  port: MessagePort;
}

interface PyrightClientOptions {
  onDiagnostics(params: PublishDiagnosticsParams): void;
  onCrash(error: Error, client: PyrightClient): void;
}

export class PyrightClient {
  private readonly workers: Worker[] = [];
  private connection: MessageConnection | undefined;
  private disposed = false;
  private crashReported = false;
  private backgroundWorkerCount = 0;

  private constructor(private readonly options: PyrightClientOptions) {}

  static async create(options: PyrightClientOptions): Promise<PyrightClient> {
    const client = new PyrightClient(options);
    await client.initialize();
    await client.verifyWithScratchCompletion();
    return client;
  }

  async openDocument(uri: string, text: string, version: number): Promise<void> {
    const connection = this.requireConnection();
    await connection.sendNotification('pyright/createFile', { uri });
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId: 'python',
        version,
        text: createEngineDocument(text),
      },
    });
  }

  async updateDocument(uri: string, text: string, version: number): Promise<void> {
    await this.requireConnection().sendNotification(
      DidChangeTextDocumentNotification.type,
      {
        textDocument: { uri, version },
        contentChanges: [{ text: createEngineDocument(text) }],
      },
    );
  }

  async closeDocument(uri: string): Promise<void> {
    if (!this.connection) return;
    await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
      textDocument: { uri },
    });
    await this.connection.sendNotification('pyright/deleteFile', { uri });
  }

  async completion(
    uri: string,
    position: PositionParams,
  ): Promise<CompletionResult> {
    const result = await withEngineRequestTimeout(
      this.requireConnection().sendRequest(CompletionRequest.type, {
        textDocument: { uri },
        position: toEnginePosition(position),
      }),
      FEATURE_REQUEST_TIMEOUT_MS,
      'Pyright',
      'textDocument/completion',
    );
    const items = Array.isArray(result)
      ? result
      : ((result as CompletionList | null)?.items ?? []);

    return {
      items: items.slice(0, MAX_COMPLETION_ITEMS).map(mapCompletionItem),
    };
  }

  async hover(uri: string, position: PositionParams): Promise<HoverResult> {
    const result = (await withEngineRequestTimeout(
      this.requireConnection().sendRequest(HoverRequest.type, {
        textDocument: { uri },
        position: toEnginePosition(position),
      }),
      FEATURE_REQUEST_TIMEOUT_MS,
      'Pyright',
      'textDocument/hover',
    )) as Hover | null;

    return { contents: result ? hoverToMarkdown(result) : null };
  }

  async signatureHelp(
    uri: string,
    position: PositionParams,
  ): Promise<SignatureHelpResult> {
    const result = (await withEngineRequestTimeout(
      this.requireConnection().sendRequest(SignatureHelpRequest.type, {
        textDocument: { uri },
        position: toEnginePosition(position),
      }),
      FEATURE_REQUEST_TIMEOUT_MS,
      'Pyright',
      'textDocument/signatureHelp',
    )) as SignatureHelp | null;

    if (!result) return { signatures: [] };
    return {
      signatures: result.signatures.slice(0, MAX_SIGNATURES).map((signature) => ({
        label: trimProtocolString(signature.label, MAX_LABEL_LENGTH),
        ...(signature.documentation
          ? { documentation: documentationToMarkdown(signature.documentation) }
          : {}),
        ...(signature.parameters
          ? {
              parameters: signature.parameters.slice(0, MAX_PARAMETERS).map((parameter) => ({
                label: Array.isArray(parameter.label)
                  ? [parameter.label[0], parameter.label[1]]
                  : trimProtocolString(parameter.label, MAX_LABEL_LENGTH),
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
    this.connection?.dispose();
    this.connection = undefined;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
  }

  private async initialize(): Promise<void> {
    const workerUrl = browser.runtime.getURL('/pyright/pyright.worker.js');
    const foreground = this.createWorker(workerUrl, 'LeetSense Pyright foreground');

    foreground.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (!isNewWorkerMessage(event.data)) return;

      const background = this.createWorker(
        workerUrl,
        `LeetSense Pyright background ${++this.backgroundWorkerCount}`,
      );
      background.postMessage(
        {
          type: 'browser/boot',
          mode: 'background',
          initialData: event.data.initialData,
          port: event.data.port,
        },
        [event.data.port],
      );
    });

    foreground.postMessage({ type: 'browser/boot', mode: 'foreground' });

    const connection = createMessageConnection(
      new BrowserMessageReader(foreground),
      new BrowserMessageWriter(foreground),
    );
    this.connection = connection;
    connection.onError(([error]) => this.reportCrash(error));
    connection.onClose(() => this.reportCrash(new Error('Pyright connection closed')));
    connection.onRequest('workspace/configuration', () => []);
    connection.onNotification(
      PublishDiagnosticsNotification.type,
      this.options.onDiagnostics,
    );
    connection.listen();

    const initializeParams: InitializeParams = {
      processId: null,
      rootPath: ROOT_PATH,
      rootUri: ROOT_URI,
      capabilities: {
        textDocument: {
          completion: {
            completionItem: {
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {},
          publishDiagnostics: {
            tagSupport: {
              valueSet: [DiagnosticTag.Unnecessary, DiagnosticTag.Deprecated],
            },
            versionSupport: true,
          },
        },
      },
      initializationOptions: {
        files: {
          [`${ROOT_PATH}pyrightconfig.json`]: JSON.stringify({
            typeshedPath: '/typeshed',
            typeCheckingMode: 'standard',
            reportMissingImports: false,
            reportMissingTypeStubs: false,
          }),
        },
      },
    };

    await connection.sendRequest(InitializeRequest.type, initializeParams);
    await connection.sendNotification(InitializedNotification.type, {});
    await connection.sendNotification('workspace/didChangeConfiguration', {
      settings: {},
    });
  }

  private createWorker(url: string, name: string): Worker {
    const worker = new Worker(url, { name });
    worker.addEventListener('error', (event) => {
      this.reportCrash(new Error(event.message || `${name} failed`));
    });
    this.workers.push(worker);
    return worker;
  }

  private async verifyWithScratchCompletion(): Promise<void> {
    const uri = `${ROOT_URI}__leetsense_boot__.py`;
    const text = 'values: list[int] = []\nvalues.';
    await this.openDocument(uri, text, 0);
    try {
      const result = await this.completion(uri, { line: 1, character: 7 });
      if (!result.items.some((item) => item.label === 'append')) {
        throw new Error('Pyright boot check did not return list.append');
      }
      console.info('[LeetSense] basedpyright boot check returned list.append');
    } finally {
      await this.closeDocument(uri);
    }
  }

  private reportCrash(error: Error): void {
    if (this.disposed || this.crashReported) return;
    this.crashReported = true;
    this.options.onCrash(error, this);
  }

  private requireConnection(): MessageConnection {
    if (this.disposed || !this.connection) {
      throw new Error('Pyright is unavailable');
    }
    return this.connection;
  }
}

export function diagnosticsToProtocol(
  params: PublishDiagnosticsParams,
  fallbackVersion: number,
): DiagnosticsParams {
  return {
    uriVersion: params.version ?? fallbackVersion,
    markers: params.diagnostics
      .slice(0, MAX_DIAGNOSTICS)
      .map(diagnosticToMarker)
      .filter((marker) => marker !== null)
      .map((marker) => ({
        ...marker,
        message: trimProtocolString(marker.message),
        ...(marker.code
          ? { code: trimProtocolString(marker.code, MAX_LABEL_LENGTH) }
          : {}),
      })),
  };
}

function mapCompletionItem(
  item: LspCompletionItem,
  index: number,
): CompletionItem {
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
    label: trimProtocolString(item.label, MAX_LABEL_LENGTH),
    kind: item.kind && item.kind > 0 ? item.kind : 1,
    ...(item.detail
      ? { detail: trimProtocolString(item.detail, MAX_DETAIL_LENGTH) }
      : {}),
    ...(documentation ? { documentation } : {}),
    ...(insertText ? { insertText: trimProtocolString(insertText) } : {}),
    ...(item.sortText
      ? { sortText: trimProtocolString(item.sortText, MAX_SORT_TEXT_LENGTH) }
      : {}),
  };
}

function hoverToMarkdown(hover: Hover): string {
  if (Array.isArray(hover.contents)) {
    return trimProtocolString(hover.contents.map(markedStringToMarkdown).join('\n\n'));
  }
  if (typeof hover.contents === 'string') {
    return trimProtocolString(hover.contents);
  }
  if ('kind' in hover.contents) {
    return trimProtocolString(hover.contents.value);
  }
  return trimProtocolString(markedStringToMarkdown(hover.contents));
}

function markedStringToMarkdown(value: MarkedString): string {
  return typeof value === 'string'
    ? value
    : `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

function documentationToMarkdown(value: string | MarkupContent): string {
  return trimProtocolString(typeof value === 'string' ? value : value.value);
}

function trimProtocolString(
  value: string,
  maxLength = MAX_PROTOCOL_STRING_LENGTH,
): string {
  return value.slice(0, maxLength);
}

function isNewWorkerMessage(value: unknown): value is NewWorkerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<NewWorkerMessage>).type === 'browser/newWorker' &&
    (value as Partial<NewWorkerMessage>).port instanceof MessagePort
  );
}
