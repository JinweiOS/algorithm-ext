import {
  ENGINE_PORT_NAME,
  isEngineRequest,
  isOffscreenIdleControlMessage,
  type EngineLanguageId,
  type OffscreenIdleControlMessage,
  type OffscreenIdleProbeResponse,
} from '../../utils/protocol';
import {
  PyrightClient,
  diagnosticsToProtocol,
} from '../../lib/engines/python/pyright-client';
import {
  ClangdClient,
  clangdDiagnosticsToProtocol,
} from '../../lib/engines/cpp/clangd-client';
import {
  TypeScriptClient,
  typescriptDiagnosticsToProtocol,
} from '../../lib/engines/typescript/typescript-client';
import { LanguageEngineBackend } from '../../lib/engines/shared/engine-backend';
import { OffscreenIdleCoordinator } from '../../lib/offscreen/idle-coordinator';
import { performanceLog } from '../../lib/observability/performance-log';
import {
  routeEngineRequest,
  type EngineBackendTable,
  type RoutedLanguageBackend,
} from '../../lib/offscreen/engine-router';

const ENGINE_IDLE_TIMEOUT_MS = 5 * 60_000;
const OFFSCREEN_IDLE_DEBOUNCE_MS = 250;

class EngineRouter {
  private readonly ports = new Set<Browser.runtime.Port>();
  private readonly backends: EngineBackendTable;
  private readonly idle: OffscreenIdleCoordinator;

  constructor() {
    const onLifecycleChange = () => this.idle?.backendStateChanged();
    const python = new LanguageEngineBackend<PyrightClient>({
      language: 'python3',
      extension: 'py',
      eager: false,
      idleTimeoutMs: ENGINE_IDLE_TIMEOUT_MS,
      onLifecycleChange,
      createClient: (callbacks) => PyrightClient.create(callbacks),
      mapDiagnostics: diagnosticsToProtocol,
    });
    const cpp = new LanguageEngineBackend<ClangdClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      idleTimeoutMs: ENGINE_IDLE_TIMEOUT_MS,
      onLifecycleChange,
      createClient: (callbacks) => ClangdClient.create(callbacks),
      mapDiagnostics: clangdDiagnosticsToProtocol,
    });
    const typescript = new LanguageEngineBackend<TypeScriptClient>({
      language: 'typescript',
      extension: 'ts',
      eager: false,
      idleTimeoutMs: ENGINE_IDLE_TIMEOUT_MS,
      onLifecycleChange,
      createClient: (callbacks) =>
        TypeScriptClient.create({ ...callbacks, allowJs: false }),
      mapDiagnostics: typescriptDiagnosticsToProtocol,
    });
    const javascript = new LanguageEngineBackend<TypeScriptClient>({
      language: 'javascript',
      extension: 'js',
      eager: false,
      idleTimeoutMs: ENGINE_IDLE_TIMEOUT_MS,
      onLifecycleChange,
      createClient: (callbacks) =>
        TypeScriptClient.create({ ...callbacks, allowJs: true }),
      mapDiagnostics: typescriptDiagnosticsToProtocol,
    });
    this.backends = new Map<EngineLanguageId, RoutedLanguageBackend>([
      ['python3', python],
      ['cpp', cpp],
      ['typescript', typescript],
      ['javascript', javascript],
    ]);
    this.idle = new OffscreenIdleCoordinator({
      graceMs: ENGINE_IDLE_TIMEOUT_MS,
      debounceMs: OFFSCREEN_IDLE_DEBOUNCE_MS,
      backendActive: () => [...this.backends.values()].some((backend) => backend.isActive),
      signalIdle: () => {
        performanceLog('info', 'offscreen.idle.candidate', {
          idle: true,
          sessions: this.ports.size,
        });
        const message: OffscreenIdleControlMessage = {
          type: 'OFFSCREEN_IDLE',
          action: 'candidate',
        };
        void browser.runtime.sendMessage(message).catch(() => {
          // The extension may be shutting down with the offscreen document.
        });
      },
    });
  }

  connect(port: Browser.runtime.Port): void {
    this.ports.add(port);
    this.idle.connect(port);
    console.info(
      `[LeetSense] engine-host port connected — ${this.ports.size} live session(s)`,
    );
    performanceLog('info', 'engine-port.connected', {
      sessions: this.ports.size,
    });
    port.onMessage.addListener((frame: unknown) => {
      if (!isEngineRequest(frame)) return;
      routeEngineRequest(frame, port, this.backends);
    });
    port.onDisconnect.addListener(() => {
      for (const backend of this.backends.values()) backend.release(port);
      this.ports.delete(port);
      this.idle.disconnect(port);
      console.info(
        `[LeetSense] engine-host port disconnected — ${this.ports.size} live session(s)`,
      );
      performanceLog('info', 'engine-port.disconnected', {
        sessions: this.ports.size,
      });
    });
  }

  get isTrulyIdle(): boolean {
    return this.idle.isTrulyIdle;
  }
}

export function startEngineHost(): void {
  const router = new EngineRouter();
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === ENGINE_PORT_NAME) router.connect(port);
  });
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender,
      sendResponse: (response: OffscreenIdleProbeResponse) => void,
    ) => {
      if (
        !isOffscreenIdleControlMessage(message) ||
        message.action !== 'probe'
      ) {
        return false;
      }
      sendResponse({ idle: router.isTrulyIdle });
      performanceLog('info', 'offscreen.idle.probed', {
        idle: router.isTrulyIdle,
      });
      return false;
    },
  );
}
