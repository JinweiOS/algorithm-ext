export type PerformanceLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type PerformanceEvent =
  | 'action.nativePopup.failed'
  | 'bridge.connect.failed'
  | 'bridge.connect.ready'
  | 'bridge.connect.started'
  | 'bridge.disconnected'
  | 'bridge.reconnect.scheduled'
  | 'bridge.request.complete'
  | 'diagnostics.received'
  | 'engine-port.connected'
  | 'engine-port.disconnected'
  | 'engine.boot.failed'
  | 'engine.boot.ready'
  | 'engine.boot.started'
  | 'engine.control.completed'
  | 'engine.control.requested'
  | 'engine.memory.restart.skipped'
  | 'engine.memory.sample'
  | 'engine.restart.failed'
  | 'engine.restart.fatal'
  | 'engine.restart.started'
  | 'engine.status'
  | 'engine.teardown'
  | 'engine.unresponsive'
  | 'feature.complete'
  | 'hook.request.complete'
  | 'offscreen.close.checked'
  | 'offscreen.close.failed'
  | 'offscreen.ensure.complete'
  | 'offscreen.ensure.failed'
  | 'offscreen.idle.candidate'
  | 'offscreen.idle.probed'
  | 'sync.complete'
  | 'ui.status';

const ALLOWED_METADATA_KEYS = new Set([
  'language',
  'method',
  'version',
  'durationMs',
  'outcome',
  'resultCount',
  'markerCount',
  'heapMb',
  'sessions',
  'state',
  'reason',
  'attempt',
  'idle',
  'created',
  'closed',
  'errorName',
  'action',
]);

export function performanceLog(
  level: PerformanceLogLevel,
  event: PerformanceEvent,
  metadata: Record<string, unknown> = {},
): void {
  const safeMetadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      ALLOWED_METADATA_KEYS.has(key) &&
      (typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean')
    ) {
      safeMetadata[key] = value;
    }
  }

  const line = `[LeetSense][perf] ${event} ${JSON.stringify(safeMetadata)}`;
  if (level === 'debug') console.debug(line);
  else if (level === 'info') console.info(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);
}
