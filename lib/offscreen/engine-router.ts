import type {
  EngineControlAck,
  EngineFeatureRequest,
  EngineLanguageId,
  EngineRequest,
  LanguageId,
  LspControlAction,
} from '../../utils/protocol';
import { performanceLog } from '../observability/performance-log';

export interface RoutedLanguageBackend {
  readonly isActive: boolean;
  handleSync(
    port: Browser.runtime.Port,
    sync: { text: string; version: number },
  ): void;
  handleFeature(
    port: Browser.runtime.Port,
    request: EngineFeatureRequest,
  ): void;
  control(action: LspControlAction): Promise<void>;
  release(port: Browser.runtime.Port): void;
}

export type EngineBackendTable = ReadonlyMap<
  EngineLanguageId,
  RoutedLanguageBackend
>;

/**
 * LeetCode still reports the legacy `python` language id on older pages; the
 * engine is the same one `python3` uses.
 */
export function engineKeyFor(language: LanguageId): EngineLanguageId {
  return language === 'python' ? 'python3' : language;
}

export function routeEngineRequest(
  frame: EngineRequest,
  port: Browser.runtime.Port,
  backends: EngineBackendTable,
): void {
  const language = engineKeyFor(frame.language);
  const backend = backends.get(language);
  if (!backend) return;

  if (frame.method === 'docSync') {
    // Only one language is live per tab: syncing a document retires the others
    // so their sessions release the port and their idle timers start.
    for (const [key, other] of backends) {
      if (key !== language) other.release(port);
    }
    backend.handleSync(port, frame.params);
    return;
  }
  if (frame.method !== 'control') {
    backend.handleFeature(port, frame);
    return;
  }

  const startedAt = performance.now();
  performanceLog('info', 'engine.control.requested', {
    language: frame.language,
    action: frame.action,
  });
  void backend.control(frame.action).then(
    () => {
      sendControlAck(port, {
        id: frame.id,
        type: 'CONTROL_ACK',
        language: frame.language,
        action: frame.action,
      });
      performanceLog('info', 'engine.control.completed', {
        language: frame.language,
        action: frame.action,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: 'ok',
      });
    },
    (error: unknown) => {
      sendControlAck(port, {
        id: frame.id,
        type: 'CONTROL_ACK',
        language: frame.language,
        action: frame.action,
        error: boundedError(error),
      });
      performanceLog('warn', 'engine.control.completed', {
        language: frame.language,
        action: frame.action,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: 'error',
        errorName: error instanceof Error ? error.name : 'Error',
      });
    },
  );
}

function sendControlAck(
  port: Browser.runtime.Port,
  frame: EngineControlAck,
): void {
  try {
    port.postMessage(frame);
  } catch {
    // The requesting tab or extension context disappeared.
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 240 ? message : `${message.slice(0, 237)}…`;
}
