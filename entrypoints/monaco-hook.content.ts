import {
  BRIDGE_CHANNEL,
  isBridgeDiagnosticsPush,
  isBridgeIncomingFrame,
  isBridgeLspControlResult,
  isBridgeReviewPromptClaimResult,
  isBridgeReviewPromptEligible,
  isBridgeStatusPush,
  type BridgeRequest,
  type CompletionResult,
  type DiagnosticsParams,
  type EngineLanguageId,
  type EngineStatusParams,
  type EngineStatusState,
  type FeatureResult,
  type HoverResult,
  type LanguageId,
  type LspControlAction,
  type PositionParams,
  type SignatureHelpResult,
  type StatusLanguageId,
} from '../utils/protocol';
import {
  disableMonacoTypeScriptDiagnostics,
  type TypeScriptLanguageApi,
} from '../lib/monaco/typescript-diagnostics';
import { withSuggestVisibility } from '../lib/monaco/suggest-visibility';
import {
  findLeetCodeStatusMount,
  isEngineLanguage,
  LspStatusIndicator,
} from '../lib/monaco/lsp-status-indicator';
import {
  engineActivationChanged,
  EngineReadyGate,
} from '../lib/monaco/engine-ready-gate';
import { performanceLog } from '../lib/observability/performance-log';

const SUPPORTED_HOSTNAMES = new Set(['leetcode.com', 'leetcode.cn']);
const PYTHON_LANGUAGE_ID = 'python3';
const LEGACY_PYTHON_LANGUAGE_ID = 'python';
const CPP_LANGUAGE_ID = 'cpp';
const JAVASCRIPT_LANGUAGE_ID = 'javascript';
const TYPESCRIPT_LANGUAGE_ID = 'typescript';
const MARKER_OWNER = 'leetsense';
const MONACO_POLL_INTERVAL_MS = 200;
const MONACO_INSTALL_DEFER_MS = 150;
const MONACO_POLL_LIMIT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DOCUMENT_SYNC_DEBOUNCE_MS = 250;
const REVIEW_PROMPT_IDLE_MS = 20_000;

interface Disposable {
  dispose(): void;
}

interface MonacoPosition {
  lineNumber: number;
  column: number;
}

interface MonacoWord {
  startColumn: number;
  endColumn: number;
}

interface MonacoModel {
  getValue(): string;
  getLanguageId(): string;
  getWordUntilPosition(position: MonacoPosition): MonacoWord;
  onDidChangeContent(listener: () => void): Disposable;
  onWillDispose(listener: () => void): Disposable;
  isDisposed?(): boolean;
}

interface MonacoEditor {
  updateOptions(options: Record<string, unknown>): void;
  getModel?(): MonacoModel | null;
  getDomNode?(): HTMLElement | null;
  onDidChangeModel?(listener: () => void): Disposable;
}

type MonacoEditorCreate = (...args: unknown[]) => MonacoEditor;

interface MonacoMarker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  severity: number;
  message: string;
  code?: string;
}

interface MonacoApi {
  MarkerSeverity: {
    Error: number;
    Warning: number;
    Info: number;
    Hint: number;
  };
  editor: {
    create: MonacoEditorCreate;
    getEditors?: () => MonacoEditor[];
    setModelMarkers(
      model: MonacoModel,
      owner: string,
      markers: MonacoMarker[],
    ): void;
    onDidChangeModelLanguage?: (
      listener: (event: { model: MonacoModel; newLanguage: string }) => void,
    ) => Disposable;
  };
  languages: {
    typescript?: TypeScriptLanguageApi;
    CompletionItemKind: Record<string, number> & { Text: number };
    CompletionItemInsertTextRule?: { InsertAsSnippet: number };
    registerCompletionItemProvider(
      languageId: string,
      provider: {
        triggerCharacters: string[];
        provideCompletionItems(
          model: MonacoModel,
          position: MonacoPosition,
        ): Promise<{ suggestions: Record<string, unknown>[] }>;
      },
    ): Disposable;
    registerHoverProvider(
      languageId: string,
      provider: {
        provideHover(
          model: MonacoModel,
          position: MonacoPosition,
        ): Promise<{ contents: Array<{ value: string }> } | null>;
      },
    ): Disposable;
    registerSignatureHelpProvider(
      languageId: string,
      provider: {
        signatureHelpTriggerCharacters: string[];
        provideSignatureHelp(
          model: MonacoModel,
          position: MonacoPosition,
        ): Promise<
          | {
              value: SignatureHelpResult;
              dispose(): void;
            }
          | null
        >;
      },
    ): Disposable;
  };
}

interface PendingRequest {
  resolve(result: FeatureResult): void;
  reject(error: Error): void;
  timeoutId: number;
  method: string;
  startedAt: number;
}

interface PendingControl {
  resolve(): void;
  reject(error: Error): void;
  timeoutId: number;
  language: EngineLanguageId;
  action: LspControlAction;
  startedAt: number;
}

declare global {
  interface Window {
    monaco?: MonacoApi;
    __leetsense_cleanup?: () => void;
  }
}

const FORCED_EDITOR_OPTIONS: Record<string, unknown> = {
  quickSuggestions: { other: true, comments: false, strings: false },
  suggestOnTriggerCharacters: true,
  suggest: withSuggestVisibility(undefined),
  hover: { enabled: true },
  parameterHints: { enabled: true },
};

export default defineContentScript({
  matches: [
    'https://leetcode.com/problems/*',
    'https://leetcode.cn/problems/*',
  ],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    if (!SUPPORTED_HOSTNAMES.has(location.hostname)) return;

    window.__leetsense_cleanup?.();

    let stopped = false;
    let activeMonaco: MonacoApi | undefined;
    let activeModel: MonacoModel | undefined;
    let activeEditor: MonacoEditor | undefined;
    let activeStatusLanguage: StatusLanguageId | undefined;
    let pollTimer: number | undefined;
    let syncTimer: number | undefined;
    let reviewPromptTimer: number | undefined;
    let reviewPromptClaimRequestId: string | undefined;
    let reviewPromptEligible = false;
    let observer: MutationObserver | undefined;
    let observerArmed = false;
    let restoreCreate: (() => void) | undefined;
    let restoreMonacoProperty: (() => void) | undefined;
    let languageChangeDisposable: Disposable | undefined;
    let pageTypeScriptDiagnostics: Disposable | undefined;
    let releaseProviderInterception: ((replay: boolean) => void) | undefined;
    let interceptionTarget: Record<string, unknown> | undefined;
    /** Set while LeetSense registers its own providers, so the guard lets them through. */
    let registeringOwnProviders = false;
    let documentVersion = 0;
    let lastSyncedVersion = -1;
    let pendingSyncVersion = -1;
    const providerDisposables = new Set<Disposable>();
    const cppProviderDisposables = new Set<Disposable>();
    const webProviderDisposables = new Set<Disposable>();
    const modelDisposables = new Map<MonacoModel, Disposable[]>();
    const restoreEditors = new Set<() => void>();
    const wrappedEditors = new WeakSet<MonacoEditor>();
    const pendingRequests = new Map<string, PendingRequest>();
    const pendingControls = new Map<string, PendingControl>();
    const engineStatuses = new Map<
      StatusLanguageId,
      { state: EngineStatusState; detail?: string }
    >();
    const engineReadyGate = new EngineReadyGate();
    const statusIndicator = new LspStatusIndicator(
      document,
      findLeetCodeStatusMount,
      (callback) => new MutationObserver(callback),
      (language, action) => requestLspControl(language, action),
    );

    function nextRequestId(): string {
      return (
        globalThis.crypto?.randomUUID?.() ??
        `leetsense-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
    }

    function requestLspControl(
      language: EngineLanguageId,
      action: LspControlAction,
    ): Promise<void> {
      if (stopped) return Promise.reject(new Error('速写已重新加载'));
      return new Promise((resolve, reject) => {
        const requestId = nextRequestId();
        const startedAt = performance.now();
        const timeoutId = window.setTimeout(() => {
          pendingControls.delete(requestId);
          performanceLog('debug', 'hook.request.complete', {
            language,
            method: 'LSP_CONTROL',
            durationMs: Math.round(performance.now() - startedAt),
            outcome: 'timeout',
          });
          reject(new Error('语言服务操作超时'));
        }, REQUEST_TIMEOUT_MS);
        pendingControls.set(requestId, {
          resolve,
          reject,
          timeoutId,
          language,
          action,
          startedAt,
        });
        const request: BridgeRequest = {
          channel: BRIDGE_CHANNEL,
          direction: 'TO_EXTENSION',
          requestId,
          type: 'LSP_CONTROL',
          payload: { language, action },
        };
        window.postMessage(request, location.origin);
      });
    }

    function activeEngineIsReady(): boolean {
      return Boolean(
        activeStatusLanguage &&
          isEngineLanguage(activeStatusLanguage) &&
          engineStatuses.get(activeStatusLanguage)?.state === 'ready',
      );
    }

    function clearReviewPromptTimer(): void {
      if (reviewPromptTimer === undefined) return;
      window.clearTimeout(reviewPromptTimer);
      reviewPromptTimer = undefined;
    }

    function scheduleReviewPrompt(): void {
      clearReviewPromptTimer();
      if (
        stopped ||
        !reviewPromptEligible ||
        reviewPromptClaimRequestId ||
        !activeEngineIsReady()
      ) {
        return;
      }
      reviewPromptTimer = window.setTimeout(() => {
        reviewPromptTimer = undefined;
        if (!reviewPromptEligible || !activeEngineIsReady()) return;
        const requestId = nextRequestId();
        reviewPromptClaimRequestId = requestId;
        const request: BridgeRequest = {
          channel: BRIDGE_CHANNEL,
          direction: 'TO_EXTENSION',
          requestId,
          type: 'REVIEW_PROMPT_CLAIM',
        };
        window.postMessage(request, location.origin);
      }, REVIEW_PROMPT_IDLE_MS);
    }

    function noteReviewPromptActivity(): void {
      if (reviewPromptEligible) scheduleReviewPrompt();
    }

    const handleEditorActivity = (event: Event): void => {
      const target = event.target;
      const editorTarget = activeEditor?.getDomNode?.();
      if (
        target instanceof Node &&
        editorTarget?.contains(target)
      ) {
        noteReviewPromptActivity();
      }
    };

    function postDocumentSync(model: MonacoModel): void {
      if (stopped || model !== activeModel) return;
      if (syncTimer !== undefined) {
        window.clearTimeout(syncTimer);
        syncTimer = undefined;
      }
      if (pendingSyncVersion <= lastSyncedVersion) return;
      const language = engineLanguageForModel(model);
      if (!language) return;

      const request: BridgeRequest = {
        channel: BRIDGE_CHANNEL,
        direction: 'TO_EXTENSION',
        type: 'DOC_SYNC',
        payload: {
          language,
          text: model.getValue(),
          version: pendingSyncVersion,
        },
      };
      const statusLanguage = canonicalStatusLanguage(language);
      const currentStatus = engineStatuses.get(statusLanguage);
      if (!currentStatus || currentStatus.state === 'off') {
        updateServiceStatus(statusLanguage, 'starting', '正在启动语言引擎');
      }
      window.postMessage(request, location.origin);
      lastSyncedVersion = pendingSyncVersion;
    }

    function scheduleDocumentSync(model: MonacoModel, immediate = false): void {
      if (model !== activeModel || !engineLanguageForModel(model)) {
        return;
      }
      pendingSyncVersion = ++documentVersion;
      if (syncTimer !== undefined) window.clearTimeout(syncTimer);
      if (immediate) {
        postDocumentSync(model);
      } else {
        syncTimer = window.setTimeout(
          () => postDocumentSync(model),
          DOCUMENT_SYNC_DEBOUNCE_MS,
        );
      }
    }

    function flushDocumentSync(model: MonacoModel): void {
      if (model !== activeModel) activateModel(model);
      postDocumentSync(model);
    }

    async function requestFeature(
      type: 'COMPLETION' | 'HOVER' | 'SIGNATURE_HELP',
      model: MonacoModel,
      payload: PositionParams,
    ): Promise<FeatureResult> {
      noteReviewPromptActivity();
      activateModel(model);
      const language = engineLanguageForModel(model);
      if (!language) throw new Error('当前语言的补全已关闭');
      flushDocumentSync(model);

      return new Promise((resolve, reject) => {
        const requestId = nextRequestId();
        const startedAt = performance.now();
        const timeoutId = window.setTimeout(() => {
          pendingRequests.delete(requestId);
          performanceLog('debug', 'hook.request.complete', {
            language,
            method: type,
            durationMs: Math.round(performance.now() - startedAt),
            outcome: 'timeout',
          });
          reject(new Error('速写请求超时'));
        }, REQUEST_TIMEOUT_MS);

        pendingRequests.set(requestId, {
          resolve,
          reject,
          timeoutId,
          method: type,
          startedAt,
        });
        const request: BridgeRequest = {
          channel: BRIDGE_CHANNEL,
          direction: 'TO_EXTENSION',
          requestId,
          type,
          payload: { ...payload, language },
        };
        window.postMessage(request, location.origin);
      });
    }

    function handleBridgeFrame(event: MessageEvent<unknown>): void {
      if (event.source !== window || !isBridgeIncomingFrame(event.data)) return;

      if (isBridgeDiagnosticsPush(event.data)) {
        applyDiagnostics(event.data.payload);
        return;
      }
      if (isBridgeStatusPush(event.data)) {
        applyEngineStatus(event.data);
        return;
      }
      if (isBridgeReviewPromptEligible(event.data)) {
        reviewPromptEligible = true;
        scheduleReviewPrompt();
        return;
      }
      if (isBridgeReviewPromptClaimResult(event.data)) {
        if (event.data.requestId !== reviewPromptClaimRequestId) return;
        reviewPromptClaimRequestId = undefined;
        reviewPromptEligible = false;
        clearReviewPromptTimer();
        if (event.data.payload.claimed && event.data.payload.reviewUrl) {
          statusIndicator.showReviewPrompt(event.data.payload.reviewUrl);
        }
        return;
      }
      if (isBridgeLspControlResult(event.data)) {
        const pending = pendingControls.get(event.data.requestId);
        if (
          !pending ||
          pending.language !== event.data.payload.language ||
          pending.action !== event.data.payload.action
        ) {
          return;
        }
        pendingControls.delete(event.data.requestId);
        window.clearTimeout(pending.timeoutId);
        performanceLog('debug', 'hook.request.complete', {
          language: pending.language,
          method: 'LSP_CONTROL',
          durationMs: Math.round(performance.now() - pending.startedAt),
          outcome: event.data.error ? 'error' : 'ok',
        });
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve();
        return;
      }
      const pending = pendingRequests.get(event.data.requestId);
      if (!pending) return;
      pendingRequests.delete(event.data.requestId);
      window.clearTimeout(pending.timeoutId);
      performanceLog('debug', 'hook.request.complete', {
        method: pending.method,
        durationMs: Math.round(performance.now() - pending.startedAt),
        outcome: event.data.error ? 'error' : 'ok',
      });

      if (event.data.error) {
        pending.reject(new Error(event.data.error));
      } else if (event.data.response) {
        pending.resolve(event.data.response);
      } else {
        pending.reject(new Error('速写返回了空响应'));
      }
    }

    function applyDiagnostics(params: DiagnosticsParams): void {
      const monaco = activeMonaco;
      const model = activeModel;
      if (
        !monaco ||
        !model ||
        !engineLanguageForModel(model) ||
        !engineReadyGate.acceptDiagnostics(
          params.uriVersion,
          documentVersion,
        )
      ) {
        return;
      }

      monaco.editor.setModelMarkers(
        model,
        MARKER_OWNER,
        params.markers.map((marker) => ({
          startLineNumber: marker.startLine + 1,
          startColumn: marker.startCol + 1,
          endLineNumber: marker.endLine + 1,
          endColumn: marker.endCol + 1,
          severity: markerSeverity(monaco, marker.severity),
          message: marker.message,
          ...(marker.code ? { code: marker.code } : {}),
        })),
      );
      renderActiveStatus();
    }

    function applyEngineStatus(params: EngineStatusParams): void {
      updateServiceStatus(
        canonicalStatusLanguage(params.language),
        params.state,
        params.detail,
      );
    }

    /**
     * Single source of truth for every status the indicator can show. Every
     * language, JavaScript and TypeScript included, reports the state of a
     * LeetSense engine — nothing here is inferred from the page any more.
     */
    function updateServiceStatus(
      language: StatusLanguageId,
      state: EngineStatusState,
      detail?: string,
    ): void {
      if (state !== 'ready' && activeStatusLanguage === language) {
        engineReadyGate.reset();
      }
      engineStatuses.set(language, { state, detail });
      performanceLog('info', 'ui.status', {
        language,
        state,
      });
      renderActiveStatus();
      if (state === 'ready') scheduleReviewPrompt();
      else clearReviewPromptTimer();
    }

    function renderActiveStatus(): void {
      const model = activeModel;
      const target = activeEditor?.getDomNode?.();
      const language = model ? statusLanguageForModel(model) : undefined;
      if (!model || !target || !language) {
        clearReviewPromptTimer();
        statusIndicator.clear();
        return;
      }
      const status = engineStatuses.get(language);
      if (!status) {
        clearReviewPromptTimer();
        statusIndicator.clear();
        return;
      }
      if (
        isEngineLanguage(language) &&
        !engineReadyGate.canRender(status.state)
      ) {
        statusIndicator.render(
          target,
          language,
          'starting',
          '正在分析当前文档',
        );
        return;
      }
      statusIndicator.render(
        target,
        language,
        status.state,
        status.detail,
      );
    }

    function markerSeverity(monaco: MonacoApi, severity: number): number {
      if (severity === 1) return monaco.MarkerSeverity.Error;
      if (severity === 2) return monaco.MarkerSeverity.Warning;
      if (severity === 4) return monaco.MarkerSeverity.Hint;
      return monaco.MarkerSeverity.Info;
    }

    /**
     * Languages answered by a LeetSense engine (bridge round-trip). JavaScript
     * and TypeScript included: they are served by the offscreen TypeScript
     * service, so their completions no longer depend on the page loading its
     * own language pack.
     */
    function engineLanguageForModel(model: MonacoModel): LanguageId | undefined {
      const language = model.getLanguageId();
      if (
        language === PYTHON_LANGUAGE_ID ||
        language === LEGACY_PYTHON_LANGUAGE_ID ||
        language === CPP_LANGUAGE_ID ||
        language === JAVASCRIPT_LANGUAGE_ID ||
        language === TYPESCRIPT_LANGUAGE_ID
      ) {
        return language;
      }
      return undefined;
    }

    /** Every engine language also owns a status surface. */
    function statusLanguageForModel(
      model: MonacoModel,
    ): StatusLanguageId | undefined {
      const engineLanguage = engineLanguageForModel(model);
      return engineLanguage
        ? canonicalStatusLanguage(engineLanguage)
        : undefined;
    }

    function disposeProviders(disposables: Set<Disposable>): void {
      for (const disposable of disposables) disposable.dispose();
      disposables.clear();
    }

    function ensureCppProviders(monaco: MonacoApi): void {
      if (cppProviderDisposables.size === 0) {
        for (const disposable of registerProviders(monaco, CPP_LANGUAGE_ID)) {
          cppProviderDisposables.add(disposable);
        }
      }
    }

    function clearMarkers(model = activeModel): void {
      if (activeMonaco && model) {
        activeMonaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      }
    }

    function activateModel(model: MonacoModel): void {
      const statusLanguage = statusLanguageForModel(model);
      if (!statusLanguage) {
        if (model === activeModel) deactivateModel();
        return;
      }
      if (
        !engineActivationChanged(
          activeModel,
          activeStatusLanguage,
          model,
          statusLanguage,
        )
      ) {
        activeEditor = findEditorForModel(model) ?? activeEditor;
        renderActiveStatus();
        return;
      }

      clearMarkers();
      engineReadyGate.reset();
      activeModel = model;
      activeStatusLanguage = statusLanguage;
      activeEditor = findEditorForModel(model);
      lastSyncedVersion = -1;
      pendingSyncVersion = -1;
      renderActiveStatus();
      scheduleDocumentSync(model, true);
    }

    function deactivateModel(): void {
      clearMarkers();
      activeModel = undefined;
      activeEditor = undefined;
      activeStatusLanguage = undefined;
      engineReadyGate.reset();
      statusIndicator.clear();
      lastSyncedVersion = -1;
      pendingSyncVersion = -1;
      if (syncTimer !== undefined) {
        window.clearTimeout(syncTimer);
        syncTimer = undefined;
      }
      armDiscoveryObserver();
    }

    function trackModel(model: MonacoModel, preferActive: boolean): void {
      if (modelDisposables.has(model)) {
        if (
          statusLanguageForModel(model) &&
          (preferActive || !activeModel)
        ) {
          activateModel(model);
        }
        return;
      }

      const disposables = [
        model.onDidChangeContent(() => {
          noteReviewPromptActivity();
          if (model === activeModel) scheduleDocumentSync(model);
        }),
        model.onWillDispose(() => {
          clearMarkers(model);
          if (model === activeModel) deactivateModel();
          for (const disposable of modelDisposables.get(model) ?? []) {
            disposable.dispose();
          }
          modelDisposables.delete(model);
          const replacementExists = activeMonaco?.editor
            .getEditors?.()
            .some((editor) => {
              const candidate = editor.getModel?.();
              return (
                candidate !== null &&
                candidate !== undefined &&
                candidate !== model &&
                !candidate.isDisposed?.()
              );
            });
          if (!replacementExists) armDiscoveryObserver();
        }),
      ];
      modelDisposables.set(model, disposables);

      if (
        statusLanguageForModel(model) &&
        (preferActive || !activeModel)
      ) {
        activateModel(model);
      }
    }

    function wrapEditor(editor: MonacoEditor): void {
      if (wrappedEditors.has(editor)) return;
      const currentUpdateOptions = editor.updateOptions;
      if (typeof currentUpdateOptions !== 'function') return;

      function wrappedUpdateOptions(
        this: MonacoEditor,
        options: Record<string, unknown>,
      ): void {
        currentUpdateOptions.call(this, {
          ...options,
          ...FORCED_EDITOR_OPTIONS,
          // `suggest` is a nested object, so the blanket spread above would
          // throw away everything the page configured except our flags.
          suggest: withSuggestVisibility(options.suggest),
        });
      }

      wrappedEditors.add(editor);
      editor.updateOptions = wrappedUpdateOptions;
      editor.updateOptions(FORCED_EDITOR_OPTIONS);
      const modelChangeDisposable = editor.onDidChangeModel?.(() => {
        const model = editor.getModel?.();
        if (model) {
          activeEditor = editor;
          trackModel(model, true);
          if (!statusLanguageForModel(model)) deactivateModel();
        }
        else deactivateModel();
      });
      const model = editor.getModel?.();
      if (model) {
        if (!activeModel) activeEditor = editor;
        trackModel(model, !activeModel);
      }

      const restore = () => {
        modelChangeDisposable?.dispose();
        if (editor.updateOptions === wrappedUpdateOptions) {
          editor.updateOptions = currentUpdateOptions;
        }
        wrappedEditors.delete(editor);
        restoreEditors.delete(restore);
      };
      restoreEditors.add(restore);
    }

    function registerProviders(
      monaco: MonacoApi,
      language: LanguageId,
    ): Disposable[] {
      registeringOwnProviders = true;
      try {
        return registerProviderSet(monaco, language);
      } finally {
        registeringOwnProviders = false;
      }
    }

    function registerProviderSet(
      monaco: MonacoApi,
      language: LanguageId,
    ): Disposable[] {
      const completion = monaco.languages.registerCompletionItemProvider(
        language,
        {
          triggerCharacters:
            language === CPP_LANGUAGE_ID ? ['.', '>', ':'] : ['.'],
          async provideCompletionItems(model, position) {
            try {
              const result = await requestFeature(
                'COMPLETION',
                model,
                toProtocolPosition(position),
              );
              if (!isCompletionResult(result)) return { suggestions: [] };
              const word = model.getWordUntilPosition(position);

              return {
                suggestions: result.items.map((item) => ({
                  // The label object form is what LeetCode's own
                  // monaco-typescript build uses: the name stays the
                  // highlighted token and `description` renders the type
                  // signature beside it on every row.
                  label: item.detail
                    ? { label: item.label, description: item.detail }
                    : item.label,
                  kind: completionKind(monaco, item.kind),
                  ...(item.detail ? { detail: item.detail } : {}),
                  ...(item.documentation
                    ? { documentation: { value: item.documentation } }
                    : {}),
                  insertText: item.insertText ?? item.label,
                  ...(item.sortText ? { sortText: item.sortText } : {}),
                  filterText: item.filterText ?? item.label,
                  ...(item.insertTextFormat === 2 &&
                  monaco.languages.CompletionItemInsertTextRule
                    ? {
                        insertTextRules:
                          monaco.languages.CompletionItemInsertTextRule
                            .InsertAsSnippet,
                      }
                    : {}),
                  range: {
                    startLineNumber: position.lineNumber,
                    startColumn: word.startColumn,
                    endLineNumber: position.lineNumber,
                    endColumn: word.endColumn,
                  },
                })),
              };
            } catch {
              return { suggestions: [] };
            }
          },
        },
      );

      const hover = monaco.languages.registerHoverProvider(language, {
        async provideHover(model, position) {
          try {
            const result = await requestFeature(
              'HOVER',
              model,
              toProtocolPosition(position),
            );
            if (!isHoverResult(result) || !result.contents) return null;
            return { contents: [{ value: result.contents }] };
          } catch {
            return null;
          }
        },
      });

      const signature = monaco.languages.registerSignatureHelpProvider(
        language,
        {
          signatureHelpTriggerCharacters: ['(', ','],
          async provideSignatureHelp(model, position) {
            try {
              const result = await requestFeature(
                'SIGNATURE_HELP',
                model,
                toProtocolPosition(position),
              );
              if (!isSignatureHelpResult(result) || result.signatures.length === 0) {
                return null;
              }
              return {
                value: {
                  ...result,
                  activeSignature: result.activeSignature ?? 0,
                  activeParameter: result.activeParameter ?? 0,
                },
                dispose() {},
              };
            } catch {
              return null;
            }
          },
        },
      );

      return [completion, hover, signature];
    }

    function ensureWebProviders(monaco: MonacoApi): void {
      if (webProviderDisposables.size > 0) return;
      for (const language of [
        JAVASCRIPT_LANGUAGE_ID,
        TYPESCRIPT_LANGUAGE_ID,
      ] as const) {
        for (const disposable of registerProviders(monaco, language)) {
          webProviderDisposables.add(disposable);
        }
      }
    }

    function activateMonaco(monaco: MonacoApi): void {
      if (stopped) return;

      for (const editor of monaco.editor.getEditors?.() ?? []) wrapEditor(editor);
      if (providerDisposables.size === 0) {
        for (const language of [
          PYTHON_LANGUAGE_ID,
          LEGACY_PYTHON_LANGUAGE_ID,
        ] as const) {
          for (const disposable of registerProviders(monaco, language)) {
            providerDisposables.add(disposable);
          }
        }
      }
      ensureCppProviders(monaco);
      ensureWebProviders(monaco);
      languageChangeDisposable ??= monaco.editor.onDidChangeModelLanguage?.(
        ({ model }) => {
          trackModel(model, false);
          if (statusLanguageForModel(model)) activateModel(model);
          else if (model === activeModel) deactivateModel();
          else clearMarkers(model);
        },
      );
      quiesceDiscovery();
    }

    /**
     * @param replayProviders hand the page's own JS/TS providers back — only
     * correct when LeetSense is leaving for good, never between re-installs.
     */
    function deactivateForCodeMirror(replayProviders = false): void {
      disposeProviders(providerDisposables);
      disposeProviders(cppProviderDisposables);
      disposeProviders(webProviderDisposables);
      languageChangeDisposable?.dispose();
      languageChangeDisposable = undefined;
      pageTypeScriptDiagnostics?.dispose();
      pageTypeScriptDiagnostics = undefined;
      releaseProviderInterception?.(replayProviders);
      engineStatuses.delete(JAVASCRIPT_LANGUAGE_ID);
      engineStatuses.delete(TYPESCRIPT_LANGUAGE_ID);
      deactivateModel();
      for (const restore of [...restoreEditors]) restore();
    }

    function installMonaco(monaco: MonacoApi): void {
      if (activeMonaco === monaco) {
        installTypeScriptConfiguration(monaco);
        interceptPageTypeScriptProviders(monaco);
        if (document.querySelector('.monaco-editor')) activateMonaco(monaco);
        return;
      }
      if (
        stopped ||
        typeof monaco.editor?.create !== 'function' ||
        typeof monaco.editor?.setModelMarkers !== 'function' ||
        typeof monaco.languages?.registerCompletionItemProvider !== 'function' ||
        typeof monaco.languages?.registerHoverProvider !== 'function' ||
        typeof monaco.languages?.registerSignatureHelpProvider !== 'function'
      ) {
        return;
      }
      deactivateForCodeMirror();
      restoreCreate?.();
      activeMonaco = monaco;
      installTypeScriptConfiguration(monaco);
      interceptPageTypeScriptProviders(monaco);
      const originalCreate = monaco.editor.create;
      const wrappedCreate: MonacoEditorCreate = (...args) => {
        const editor = originalCreate.apply(monaco.editor, args);
        wrapEditor(editor);
        const model = editor.getModel?.();
        if (model) trackModel(model, true);
        activateMonaco(monaco);
        return editor;
      };

      monaco.editor.create = wrappedCreate;
      restoreCreate = () => {
        if (monaco.editor.create === wrappedCreate) {
          monaco.editor.create = originalCreate;
        }
      };

      const existingEditors = monaco.editor.getEditors?.() ?? [];
      if (existingEditors.length > 0 || document.querySelector('.monaco-editor')) {
        activateMonaco(monaco);
      }
    }

    function findEditorForModel(model: MonacoModel): MonacoEditor | undefined {
      return activeMonaco?.editor
        .getEditors?.()
        .find((editor) => editor.getModel?.() === model);
    }

    /**
     * LeetSense now answers JavaScript and TypeScript itself, so the page's own
     * TypeScript worker is reduced to a language definition: its validators are
     * switched off (no duplicate squiggles) and its providers are intercepted
     * below so the suggest widget is not fed two copies of every member.
     */
    function installTypeScriptConfiguration(monaco: MonacoApi): void {
      if (pageTypeScriptDiagnostics) return;
      const typescript = monaco.languages.typescript;
      if (
        !typescript ||
        !isTypeScriptDefaults(typescript.typescriptDefaults) ||
        !isTypeScriptDefaults(typescript.javascriptDefaults)
      ) {
        return;
      }
      pageTypeScriptDiagnostics = disableMonacoTypeScriptDiagnostics(typescript);
    }

    /**
     * LeetCode lazily registers the JavaScript/TypeScript language packs, and
     * each pack contributes its own completion/hover/signature providers. Those
     * would duplicate every LeetSense answer, so registration calls for those
     * two languages are swallowed and replayed if the extension goes away.
     *
     * The guard stays installed for the lifetime of the page: removing it
     * between monaco re-installs is what let the page's providers back in and
     * doubled every suggestion row. LeetSense's own registrations pass through
     * `registeringOwnProviders`.
     */
    function interceptPageTypeScriptProviders(monaco: MonacoApi): void {
      const languages = monaco.languages as unknown as Record<string, unknown>;
      if (interceptionTarget === languages) return;
      releaseProviderInterception?.(false);
      const methods = [
        'registerCompletionItemProvider',
        'registerHoverProvider',
        'registerSignatureHelpProvider',
      ];
      const originals = new Map<string, (...args: unknown[]) => unknown>();
      const intercepted: Array<{
        method: string;
        language: string;
        provider: unknown;
      }> = [];

      for (const method of methods) {
        const original = languages[method];
        if (typeof original !== 'function') continue;
        originals.set(method, original as (...args: unknown[]) => unknown);
        languages[method] = function (
          this: unknown,
          language: string,
          provider: unknown,
        ) {
          if (
            !registeringOwnProviders &&
            (language === JAVASCRIPT_LANGUAGE_ID ||
              language === TYPESCRIPT_LANGUAGE_ID)
          ) {
            intercepted.push({ method, language, provider });
            return { dispose() {} };
          }
          return (original as (...args: unknown[]) => unknown).call(
            languages,
            language,
            provider,
          );
        };
      }

      if (originals.size === 0) return;
      interceptionTarget = languages;

      releaseProviderInterception = (replay: boolean) => {
        for (const [method, original] of originals) {
          if (languages[method] !== original) languages[method] = original;
        }
        const providers = [...intercepted];
        intercepted.length = 0;
        interceptionTarget = undefined;
        releaseProviderInterception = undefined;
        if (!replay) return;
        for (const entry of providers) {
          const original = originals.get(entry.method);
          if (original) original.call(languages, entry.language, entry.provider);
        }
      };
    }

    function discoverMonaco(): void {
      if (
        document.querySelector('.cm-editor') &&
        !document.querySelector('.monaco-editor')
      ) {
        deactivateForCodeMirror();
        return;
      }

      const candidate = window.monaco;
      if (candidate) installMonaco(candidate);
    }

    function armDiscoveryObserver(): void {
      if (stopped || observerArmed || !observer || !document.documentElement) return;
      observer.observe(document.documentElement, { childList: true, subtree: true });
      observerArmed = true;
    }

    function quiesceDiscovery(): void {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
      observer?.disconnect();
      observerArmed = false;
    }

    /**
     * LeetCode assigns `window.monaco` part-way through its own bootstrap, so
     * touching provider registration or option updates in that same task can
     * race its service registry (leetcode.cn's trimmed build then throws
     * "depends on UNKNOWN service"). Let the page finish its current work
     * first; the editor discovery poll covers the delay.
     */
    const pendingInstalls = new WeakSet<MonacoApi>();

    function scheduleInstall(monaco: MonacoApi): void {
      if (stopped || pendingInstalls.has(monaco)) return;
      pendingInstalls.add(monaco);
      window.setTimeout(() => {
        pendingInstalls.delete(monaco);
        if (!stopped) installMonaco(monaco);
      }, MONACO_INSTALL_DEFER_MS);
    }

    function installMonacoTrap(): void {
      const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'monaco');
      let captured = window.monaco;

      try {
        Object.defineProperty(window, 'monaco', {
          configurable: true,
          enumerable: originalDescriptor?.enumerable ?? true,
          get: () => captured,
          set: (value: MonacoApi | undefined) => {
            captured = value;
            if (value) {
              // Runs synchronously, before LeetCode's own bootstrap registers
              // the JS/TS language packs and their duplicate providers.
              interceptPageTypeScriptProviders(value);
              scheduleInstall(value);
            }
          },
        });
      } catch {
        return;
      }

      restoreMonacoProperty = () => {
        const latest = captured;
        try {
          delete window.monaco;
          if (originalDescriptor) {
            Object.defineProperty(window, 'monaco', originalDescriptor);
            if ('value' in originalDescriptor && latest) window.monaco = latest;
          } else if (latest) {
            window.monaco = latest;
          }
        } catch {
          // The page replaced the descriptor after our trap; leave it intact.
        }
      };

      if (captured) installMonaco(captured);
    }

    function cleanup(): void {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      if (syncTimer !== undefined) window.clearTimeout(syncTimer);
      clearReviewPromptTimer();
      observer?.disconnect();
      observerArmed = false;
      deactivateForCodeMirror(true);
      for (const disposables of modelDisposables.values()) {
        for (const disposable of disposables) disposable.dispose();
      }
      modelDisposables.clear();
      restoreCreate?.();
      restoreMonacoProperty?.();
      window.removeEventListener('message', handleBridgeFrame);
      window.removeEventListener('pagehide', cleanup);
      window.removeEventListener('keydown', handleEditorActivity, true);
      window.removeEventListener('pointerdown', handleEditorActivity, true);

      for (const pending of pendingRequests.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error('速写已重新加载'));
      }
      pendingRequests.clear();
      for (const pending of pendingControls.values()) {
        window.clearTimeout(pending.timeoutId);
        pending.reject(new Error('速写已重新加载'));
      }
      pendingControls.clear();
      statusIndicator.clear();
      engineStatuses.clear();
      if (window.__leetsense_cleanup === cleanup) {
        delete window.__leetsense_cleanup;
      }
    }

    window.__leetsense_cleanup = cleanup;
    window.addEventListener('message', handleBridgeFrame);
    window.addEventListener('pagehide', cleanup, { once: true });
    window.addEventListener('keydown', handleEditorActivity, true);
    window.addEventListener('pointerdown', handleEditorActivity, true);
    observer = new MutationObserver(() => discoverMonaco());
    armDiscoveryObserver();

    const pollingStartedAt = Date.now();
    pollTimer = window.setInterval(() => {
      if (Date.now() - pollingStartedAt >= MONACO_POLL_LIMIT_MS) {
        if (pollTimer !== undefined) window.clearInterval(pollTimer);
        pollTimer = undefined;
        return;
      }
      discoverMonaco();
    }, MONACO_POLL_INTERVAL_MS);

    installMonacoTrap();
    discoverMonaco();
  },
});

function toProtocolPosition(position: MonacoPosition): PositionParams {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

function isCompletionResult(result: FeatureResult): result is CompletionResult {
  return 'items' in result;
}

function isHoverResult(result: FeatureResult): result is HoverResult {
  return 'contents' in result;
}

function isSignatureHelpResult(
  result: FeatureResult,
): result is SignatureHelpResult {
  return 'signatures' in result;
}

function completionKind(monaco: MonacoApi, lspKind: number): number {
  const names = [
    'Text',
    'Method',
    'Function',
    'Constructor',
    'Field',
    'Variable',
    'Class',
    'Interface',
    'Module',
    'Property',
    'Unit',
    'Value',
    'Enum',
    'Keyword',
    'Snippet',
    'Color',
    'File',
    'Reference',
    'Folder',
    'EnumMember',
    'Constant',
    'Struct',
    'Event',
    'Operator',
    'TypeParameter',
  ];
  return (
    monaco.languages.CompletionItemKind[names[lspKind - 1] ?? 'Text'] ??
    monaco.languages.CompletionItemKind.Text
  );
}

function isTypeScriptDefaults(
  defaults: TypeScriptLanguageApi['typescriptDefaults'],
): boolean {
  return (
    typeof defaults?.getDiagnosticsOptions === 'function' &&
    typeof defaults?.setDiagnosticsOptions === 'function'
  );
}

function canonicalStatusLanguage(language: LanguageId): StatusLanguageId {
  if (language === 'cpp') return 'cpp';
  if (language === 'javascript') return 'javascript';
  if (language === 'typescript') return 'typescript';
  return 'python3';
}
