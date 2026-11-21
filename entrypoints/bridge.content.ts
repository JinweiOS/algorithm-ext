import {
  BRIDGE_CHANNEL,
  ENGINE_PORT_NAME,
  isBridgeRequest,
  isEngineControlAck,
  isEngineDiagnosticsPush,
  isEngineResponse,
  isEngineStatusPush,
  isReviewPromptRuntimeResponse,
  type BridgeRequest,
  type BridgeLspControlResult,
  type BridgeResponse,
  type DiagnosticsParams,
  type EngineControlRequest,
  type EngineDocumentSyncRequest,
  type EngineFeatureRequest,
  type EngineLanguageId,
  type EngineStatusPush,
  type EnsureOffscreenResponse,
  type LspControlAction,
  type ReviewPromptRuntimeResponse,
  type StatusLanguageId,
} from '../utils/protocol';
import { performanceLog } from '../lib/observability/performance-log';
import { BridgeReconnectPolicy } from '../lib/bridge/reconnect-policy';
import { replayEngineSession } from '../lib/bridge/session-replay';
import {
  toBridgeControlResult,
  toEngineControlRequest,
} from '../lib/bridge/lsp-control';
import { installCardFont } from '../lib/monaco/card-font';

const RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_ATTEMPTS = 1;
const MAX_OUTSTANDING_REQUESTS = 16;

export default defineContentScript({
  matches: [
    'https://leetcode.com/problems/*',
    'https://leetcode.cn/problems/*',
  ],
  runAt: 'document_start',
  world: 'ISOLATED',
  main(ctx) {
    // The status strip is drawn from the MAIN world, which cannot resolve an
    // extension URL; this isolated context can, and the injected `@font-face`
    // applies to the page either way.
    const publicUrl = browser.runtime.getURL as (path: string) => string;
    const removeCardFont = installCardFont(
      document,
      publicUrl('/fonts/MiSans-VF.woff2'),
    );
    let port: ReturnType<typeof browser.runtime.connect> | undefined;
    let connection: Promise<ReturnType<typeof browser.runtime.connect>> | undefined;
    let forwarding = Promise.resolve();
    let reconnectScheduled = false;
    const reconnectPolicy = new BridgeReconnectPolicy(MAX_RECONNECT_ATTEMPTS);
    let stopped = false;
    let qualifiedSessionRecorded = false;
    let lastDocumentSync: EngineDocumentSyncRequest | undefined;
    const reportedActionState = new Map<StatusLanguageId, boolean>();
    type OutstandingRequest =
      | {
          kind: 'feature';
          method: string;
          startedAt: number;
          frame?: EngineFeatureRequest;
        }
      | {
          kind: 'control';
          method: 'LSP_CONTROL';
          startedAt: number;
          language: EngineLanguageId;
          action: LspControlAction;
        };
    const outstandingRequests = new Map<string, OutstandingRequest>();

    function extensionIsAlive(): boolean {
      if (stopped || !ctx.isValid) return false;
      try {
        return Boolean(browser.runtime.id);
      } catch {
        return false;
      }
    }

    function respond(response: BridgeResponse): void {
      window.postMessage(response, location.origin);
    }

    function respondControl(
      requestId: string,
      language: EngineLanguageId,
      action: LspControlAction,
      error?: string,
    ): void {
      const response: BridgeLspControlResult = toBridgeControlResult({
        id: requestId,
        type: 'CONTROL_ACK',
        language,
        action,
        ...(error ? { error } : {}),
      });
      window.postMessage(response, location.origin);
    }

    function respondRequestError(request: BridgeRequest, error: string): void {
      if (request.type === 'LSP_CONTROL') {
        respondControl(
          request.requestId,
          request.payload.language,
          request.payload.action,
          error,
        );
      } else if ('requestId' in request) {
        respond({
          channel: BRIDGE_CHANNEL,
          direction: 'FROM_EXTENSION',
          requestId: request.requestId,
          error,
        });
      }
    }

    function pushDiagnostics(params: DiagnosticsParams): void {
      window.postMessage(
        {
          channel: BRIDGE_CHANNEL,
          direction: 'FROM_EXTENSION',
          type: 'DIAGNOSTICS',
          payload: params,
        },
        location.origin,
      );
    }

    function pushStatus(frame: EngineStatusPush): void {
      window.postMessage(
        {
          channel: BRIDGE_CHANNEL,
          direction: 'FROM_EXTENSION',
          ...frame,
        },
        location.origin,
      );
      reportActionState(frame);
    }

    /**
     * The toolbar icon is grey until a language service is actually running for
     * this tab. Only transitions are forwarded so status pushes stay cheap.
     */
    function reportActionState(frame: EngineStatusPush): void {
      const language: StatusLanguageId =
        frame.language === 'python' ? 'python3' : frame.language;
      sendActionState(
        language,
        frame.state === 'ready' ||
          frame.state === 'starting' ||
          frame.state === 'restarting',
      );
    }

    function sendActionState(
      language: StatusLanguageId,
      active: boolean,
    ): void {
      if (reportedActionState.get(language) === active) return;
      reportedActionState.set(language, active);
      if (!extensionIsAlive()) return;
      void browser.runtime
        .sendMessage({ type: 'ACTION_STATE', language, active })
        .catch(() => {
          reportedActionState.delete(language);
        });
    }

    async function recordQualifiedSession(): Promise<void> {
      if (qualifiedSessionRecorded || !extensionIsAlive()) return;
      qualifiedSessionRecorded = true;
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'REVIEW_PROMPT',
          action: 'qualified-session',
        })) as ReviewPromptRuntimeResponse | undefined;
        if (
          isReviewPromptRuntimeResponse(response) &&
          response.ok &&
          'eligible' in response &&
          response.eligible
        ) {
          window.postMessage(
            {
              channel: BRIDGE_CHANNEL,
              direction: 'FROM_EXTENSION',
              type: 'REVIEW_PROMPT_ELIGIBLE',
            },
            location.origin,
          );
        }
      } catch {
        qualifiedSessionRecorded = false;
      }
    }

    async function claimReviewPrompt(requestId: string): Promise<void> {
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'REVIEW_PROMPT',
          action: 'claim',
        })) as ReviewPromptRuntimeResponse | undefined;
        if (
          !isReviewPromptRuntimeResponse(response) ||
          !response.ok ||
          !('claimed' in response)
        ) {
          throw new Error(
            response && !response.ok
              ? response.error
              : 'Unable to claim review prompt',
          );
        }
        window.postMessage(
          {
            channel: BRIDGE_CHANNEL,
            direction: 'FROM_EXTENSION',
            requestId,
            type: 'REVIEW_PROMPT_CLAIM_RESULT',
            payload: {
              claimed: response.claimed,
              ...(response.reviewUrl ? { reviewUrl: response.reviewUrl } : {}),
            },
          },
          location.origin,
        );
      } catch {
        window.postMessage(
          {
            channel: BRIDGE_CHANNEL,
            direction: 'FROM_EXTENSION',
            requestId,
            type: 'REVIEW_PROMPT_CLAIM_RESULT',
            payload: { claimed: false },
          },
          location.origin,
        );
      }
    }

    function failOutstanding(error: string): void {
      for (const [requestId, request] of outstandingRequests) {
        performanceLog('debug', 'bridge.request.complete', {
          method: request.method,
          durationMs: Math.round(performance.now() - request.startedAt),
          outcome: 'connection-closed',
        });
        if (request.kind === 'control') {
          respondControl(requestId, request.language, request.action, error);
        } else {
          respond({
            channel: BRIDGE_CHANNEL,
            direction: 'FROM_EXTENSION',
            requestId,
            error,
          });
        }
      }
      outstandingRequests.clear();
    }

    async function openPort(
      attempt: number,
    ): Promise<ReturnType<typeof browser.runtime.connect>> {
      if (!extensionIsAlive()) throw new Error('Extension context invalidated');

      const startedAt = performance.now();
      performanceLog('info', 'bridge.connect.started', {
        attempt,
      });

      const result = (await browser.runtime.sendMessage({
        type: 'ENSURE_OFFSCREEN',
      })) as EnsureOffscreenResponse | undefined;

      if (!result?.ok) {
        performanceLog('error', 'bridge.connect.failed', {
          attempt,
          durationMs: Math.round(performance.now() - startedAt),
          outcome: 'ensure-failed',
        });
        throw new Error(result?.error ?? 'Unable to create offscreen engine host');
      }
      if (!extensionIsAlive()) throw new Error('Extension context invalidated');

      const nextPort = browser.runtime.connect({ name: ENGINE_PORT_NAME });
      nextPort.onMessage.addListener((frame: unknown) => {
        if (isEngineDiagnosticsPush(frame)) {
          pushDiagnostics(frame.params);
          return;
        }
        if (isEngineStatusPush(frame)) {
          pushStatus(frame);
          return;
        }
        if (isEngineControlAck(frame)) {
          const request = outstandingRequests.get(frame.id);
          if (
            request?.kind !== 'control' ||
            request.language !== frame.language ||
            request.action !== frame.action
          ) {
            return;
          }
          reconnectPolicy.recordResponse();
          outstandingRequests.delete(frame.id);
          performanceLog('debug', 'bridge.request.complete', {
            method: request.method,
            durationMs: Math.round(performance.now() - request.startedAt),
            outcome: frame.error === undefined ? 'ok' : 'error',
          });
          respondControl(
            frame.id,
            frame.language,
            frame.action,
            frame.error,
          );
          return;
        }
        if (!isEngineResponse(frame)) return;

        const request = outstandingRequests.get(frame.id);
        if (request?.kind === 'control') return;
        reconnectPolicy.recordResponse();
        outstandingRequests.delete(frame.id);
        if (request) {
          performanceLog('debug', 'bridge.request.complete', {
            method: request.method,
            durationMs: Math.round(performance.now() - request.startedAt),
            outcome: frame.error === undefined ? 'ok' : 'error',
          });
        }
        if (request?.kind === 'feature' && frame.error === undefined) {
          void recordQualifiedSession();
        }
        respond({
          channel: BRIDGE_CHANNEL,
          direction: 'FROM_EXTENSION',
          requestId: frame.id,
          ...(frame.result !== undefined ? { response: frame.result } : {}),
          ...(frame.error !== undefined ? { error: frame.error } : {}),
        });
      });
      nextPort.onDisconnect.addListener(() => {
        try {
          void browser.runtime.lastError;
        } catch {
          // The extension context was invalidated.
        }
        if (port === nextPort) port = undefined;
        connection = undefined;
        const alive = extensionIsAlive();

        performanceLog('info', 'bridge.disconnected', {
          attempt: reconnectPolicy.attemptCount,
          outcome: alive ? 'recoverable' : 'context-invalid',
        });

        if (
          !alive ||
          reconnectScheduled ||
          !reconnectPolicy.canAutomaticallyReconnect
        ) {
          if (!alive || !reconnectPolicy.canAutomaticallyReconnect) {
            failOutstanding('Engine connection closed');
          }
          return;
        }
        reconnectScheduled = true;
        performanceLog('info', 'bridge.reconnect.scheduled', {
          attempt: reconnectPolicy.attemptCount + 1,
        });
        ctx.setTimeout(() => {
          reconnectScheduled = false;
          if (extensionIsAlive() && !port) {
            void getPort('automatic').catch(() => {
              failOutstanding('Engine connection closed');
            });
          }
        }, RECONNECT_DELAY_MS);
      });

      port = nextPort;
      replayEngineSession(
        (frame) => nextPort.postMessage(frame),
        lastDocumentSync,
        [...outstandingRequests.values()].flatMap((request) =>
          request.kind === 'feature' && request.frame ? [request.frame] : [],
        ),
      );
      performanceLog('info', 'bridge.connect.ready', {
        attempt,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return nextPort;
    }

    function getPort(
      kind: 'automatic' | 'demand' = 'demand',
    ): Promise<ReturnType<typeof browser.runtime.connect>> {
      if (port) return Promise.resolve(port);
      if (!connection) {
        const attempt = reconnectPolicy.beginConnection(kind);
        if (attempt === undefined) {
          return Promise.reject(new Error('Automatic reconnect budget exhausted'));
        }
        connection = openPort(attempt).finally(() => {
          connection = undefined;
        });
      }
      return connection;
    }

    async function forwardRequest(request: BridgeRequest): Promise<void> {
      if (!extensionIsAlive()) {
        respondRequestError(request, 'Extension context invalidated');
        return;
      }

      if (request.type === 'PING') {
        respond({
          channel: BRIDGE_CHANNEL,
          direction: 'FROM_EXTENSION',
          requestId: request.requestId,
          pong: true,
        });
        return;
      }

      if (request.type === 'REVIEW_PROMPT_CLAIM') {
        await claimReviewPrompt(request.requestId);
        return;
      }

      if (request.type === 'SERVICE_STATE') {
        // Page-owned services (Monaco TypeScript) never need the engine port.
        sendActionState(request.payload.language, request.payload.active);
        return;
      }

      if (request.type !== 'DOC_SYNC') {
        if (outstandingRequests.size >= MAX_OUTSTANDING_REQUESTS) {
          respondRequestError(request, 'Too many outstanding language requests');
          return;
        }
        if (outstandingRequests.has(request.requestId)) {
          respondRequestError(request, 'Duplicate language request id');
          return;
        }
        outstandingRequests.set(
          request.requestId,
          request.type === 'LSP_CONTROL'
            ? {
                kind: 'control',
                method: request.type,
                startedAt: performance.now(),
                language: request.payload.language,
                action: request.payload.action,
              }
            : {
                kind: 'feature',
                method: request.type,
                startedAt: performance.now(),
              },
        );
      }

      try {
        const enginePort = await getPort();
        if (request.type === 'DOC_SYNC') {
          const { language, text, version } = request.payload;
          const frame: EngineDocumentSyncRequest = {
            language,
            method: 'docSync',
            params: { text, version },
          };
          lastDocumentSync = frame;
          enginePort.postMessage(frame);
        } else if (request.type === 'LSP_CONTROL') {
          const frame: EngineControlRequest = toEngineControlRequest(request);
          enginePort.postMessage(frame);
        } else {
          const { language, line, character } = request.payload;
          const frame: EngineFeatureRequest = {
            id: request.requestId,
            language,
            method:
              request.type === 'COMPLETION'
                ? 'completion'
                : request.type === 'HOVER'
                  ? 'hover'
                  : 'signatureHelp',
            params: { line, character },
          };
          const pending = outstandingRequests.get(request.requestId);
          if (pending?.kind === 'feature') pending.frame = frame;
          enginePort.postMessage(frame);
        }
      } catch (error) {
        if (request.type === 'DOC_SYNC') return;
        const pending = outstandingRequests.get(request.requestId);
        outstandingRequests.delete(request.requestId);
        if (pending) {
          performanceLog('debug', 'bridge.request.complete', {
            method: pending.method,
            durationMs: Math.round(performance.now() - pending.startedAt),
            outcome: 'connect-failed',
            errorName: error instanceof Error ? error.name : 'Error',
          });
        }
        if (!extensionIsAlive()) return;
        respondRequestError(
          request,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window || !isBridgeRequest(event.data)) return;
      const request = event.data;
      forwarding = forwarding
        .then(() => forwardRequest(request))
        .catch(() => {
          // An individual request failure is returned to the page when possible.
        });
    };
    ctx.addEventListener(window, 'message', handleWindowMessage);

    ctx.onInvalidated(() => {
      removeCardFont();
      stopped = true;
      reconnectScheduled = false;
      failOutstanding('Extension context invalidated');
      try {
        port?.disconnect();
      } catch {
        // The extension context is already gone.
      }
      port = undefined;
      connection = undefined;
    });
  },
});
