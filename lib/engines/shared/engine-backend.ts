import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol';

import type {
  DiagnosticsParams,
  EngineDiagnosticsPush,
  EngineFeatureRequest,
  EngineResponse,
  EngineStatusPush,
  EngineStatusState,
  FeatureResult,
  LanguageId,
  LspControlAction,
} from '../../../utils/protocol';
import { isEngineRequestTimeout } from './request-timeout';
import { performanceLog } from '../../observability/performance-log';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const AUTO_REBOOT_COOLDOWN_MS = 5 * 60_000;
const HANG_TIMEOUT_THRESHOLD = 2;

type DocumentSync = { text: string; version: number };

export interface LanguageClient {
  openDocument(uri: string, text: string, version: number): Promise<void>;
  updateDocument(uri: string, text: string, version: number): Promise<void>;
  closeDocument(uri: string): Promise<void>;
  completion(uri: string, position: EngineFeatureRequest['params']): Promise<FeatureResult>;
  hover(uri: string, position: EngineFeatureRequest['params']): Promise<FeatureResult>;
  signatureHelp(uri: string, position: EngineFeatureRequest['params']): Promise<FeatureResult>;
  dispose(): void;
}

export interface ClientCallbacks<T extends LanguageClient> {
  onDiagnostics(params: PublishDiagnosticsParams): void;
  onCrash(error: Error, client: T): void;
  onMemorySample?(bytes: number, client: T): void;
}

interface MemoryRestartOptions {
  thresholdBytes: number;
  minimumIntervalMs: number;
  recheckMs?: number;
}

export interface BackendOptions<T extends LanguageClient> {
  language: LanguageId;
  extension: 'py' | 'cpp' | 'js' | 'ts';
  eager: boolean;
  idleTimeoutMs?: number;
  memoryRestart?: MemoryRestartOptions;
  onLifecycleChange?(): void;
  onStatusChange?(status: EngineStatusPush): void;
  createClient(callbacks: ClientCallbacks<T>): Promise<T>;
  mapDiagnostics(
    params: PublishDiagnosticsParams,
    fallbackVersion: number,
  ): DiagnosticsParams;
}

interface EngineSession {
  port: Browser.runtime.Port;
  uri: string;
  text: string;
  version: number;
  targetText: string;
  targetVersion: number;
  opened: boolean;
  disconnected: boolean;
  diagnosticsReady: boolean;
  pendingSync?: DocumentSync;
  syncPromise?: Promise<void>;
  syncError?: Error;
}

export class LanguageEngineBackend<T extends LanguageClient> {
  private readonly sessions = new Map<Browser.runtime.Port, EngineSession>();
  private clientPromise: Promise<T> | undefined;
  private client: T | undefined;
  private lastAutoRebootAt: number | undefined;
  private consecutiveFeatureTimeouts = 0;
  private fatalError: Error | undefined;
  private sessionCounter = 0;
  private generation = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private status: EngineStatusState = 'off';
  private statusDetail: string | undefined;
  private inFlightFeatureRequests = 0;
  private plannedRestartTimer: ReturnType<typeof setTimeout> | undefined;
  private plannedRestartClient: T | undefined;
  private lastPlannedRestartAt: number | undefined;
  private lastMemorySampleBytes: number | undefined;
  private intentionallyStopped = false;
  private stopEpoch = 0;
  private controlQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: BackendOptions<T>) {
    if (options.eager) {
      this.startClientBoot(true);
    }
  }

  handleSync(port: Browser.runtime.Port, sync: DocumentSync): void {
    if (this.intentionallyStopped) {
      const session = this.ensureSession(port);
      this.cacheStoppedSync(session, sync);
      this.sendStatus(session);
      return;
    }
    if (!this.clientPromise && !this.fatalError) this.setStatus('starting');
    const session = this.ensureSession(port);
    this.sendStatus(session);
    this.queueSync(session, sync);
  }

  get isActive(): boolean {
    return this.clientPromise !== undefined;
  }

  handleFeature(port: Browser.runtime.Port, request: EngineFeatureRequest): void {
    const session = this.sessions.get(port);
    if (!session) {
      this.send(port, {
        id: request.id,
        error: `${this.options.language} document has not been synchronized`,
      });
      return;
    }
    void this.runFeature(session, request);
  }

  control(action: LspControlAction): Promise<void> {
    if (action === 'stop') {
      this.stopManually();
      return Promise.resolve();
    }

    const scheduledStopEpoch = this.stopEpoch;
    const operation = this.controlQueue.then(() => {
      if (scheduledStopEpoch !== this.stopEpoch) return;
      return action === 'start' ? this.startManually() : this.restartManually();
    });
    this.controlQueue = operation.catch(() => {});
    return operation;
  }

  release(port: Browser.runtime.Port): void {
    const session = this.sessions.get(port);
    if (!session) return;
    session.disconnected = true;
    session.pendingSync = undefined;
    this.sessions.delete(port);
    void this.closeSession(session);
    this.maybePublishReady();
    this.scheduleIdleTeardown();
  }

  private ensureSession(port: Browser.runtime.Port): EngineSession {
    const existing = this.sessions.get(port);
    if (existing) return existing;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const sessionId = port.sender?.tab?.id ?? ++this.sessionCounter;
    const session: EngineSession = {
      port,
      uri: `file:///src/tab-${sessionId}.${this.options.extension}`,
      text: '',
      version: 0,
      targetText: '',
      targetVersion: 0,
      opened: false,
      disconnected: false,
      diagnosticsReady: false,
    };
    this.sessions.set(port, session);
    this.notifyLifecycleChange();
    return session;
  }

  private queueSync(session: EngineSession, sync: DocumentSync): void {
    if (session.disconnected) return;
    if (sync.version < session.targetVersion) return;
    session.targetVersion = sync.version;
    session.targetText = sync.text;
    session.pendingSync = sync;
    session.syncError = undefined;
    if (session.syncPromise) return;

    const generation = this.generation;
    session.syncPromise = Promise.resolve()
      .then(() => this.drainSync(session))
      .catch((error: unknown) => {
        if (this.intentionallyStopped || generation !== this.generation) return;
        session.syncError = toError(error);
        this.sendDiagnostics(session, {
          uriVersion: session.version,
          markers: [],
        });
        console.error(
          `[LeetSense] ${this.options.language} document sync failed`,
          error,
        );
      })
      .finally(() => {
        session.syncPromise = undefined;
        if (session.pendingSync && !session.disconnected) {
          this.queueSync(session, session.pendingSync);
        }
        void this.maybeRunPlannedRestart();
      });
  }

  private async drainSync(session: EngineSession): Promise<void> {
    while (session.pendingSync && !session.disconnected) {
      const sync = session.pendingSync;
      session.pendingSync = undefined;
      const startedAt = performance.now();
      try {
        const client = await this.getClient();
        if (session.opened) {
          await client.updateDocument(session.uri, sync.text, sync.version);
        } else {
          await client.openDocument(session.uri, sync.text, sync.version);
          session.opened = true;
        }
        if (this.intentionallyStopped) return;
        session.text = sync.text;
        session.version = sync.version;
        performanceLog('debug', 'sync.complete', {
          language: this.options.language,
          version: sync.version,
          durationMs: Math.round(performance.now() - startedAt),
          outcome: 'ok',
        });
      } catch (error) {
        performanceLog('debug', 'sync.complete', {
          language: this.options.language,
          version: sync.version,
          durationMs: Math.round(performance.now() - startedAt),
          outcome: 'error',
          errorName: toError(error).name,
        });
        throw error;
      }
    }
  }

  private async flushSync(session: EngineSession): Promise<void> {
    if (session.pendingSync && !session.syncPromise) {
      this.queueSync(session, session.pendingSync);
    }
    await session.syncPromise;
    if (session.syncError) throw session.syncError;
  }

  private async runFeature(
    session: EngineSession,
    request: EngineFeatureRequest,
  ): Promise<void> {
    let client: T | undefined;
    let outcome = 'error';
    let resultCount = 0;
    let errorName: string | undefined;
    const startedAt = performance.now();
    if (this.intentionallyStopped) {
      this.send(session.port, {
        id: request.id,
        error: 'Language server is stopped',
      });
      return;
    }
    this.inFlightFeatureRequests += 1;
    try {
      await this.flushSync(session);
      if (!session.opened) throw new Error('Document has not been synchronized');
      client = await this.getClient();
      const result =
        request.method === 'completion'
          ? await client.completion(session.uri, request.params)
          : request.method === 'hover'
            ? await client.hover(session.uri, request.params)
            : await client.signatureHelp(session.uri, request.params);
      if (this.intentionallyStopped || client !== this.client) {
        throw new Error('Language server is stopped');
      }
      if (client === this.client) this.consecutiveFeatureTimeouts = 0;
      outcome = 'ok';
      resultCount = featureResultCount(result);
      this.send(session.port, { id: request.id, result });
    } catch (error) {
      const requestError = toError(error);
      outcome = isEngineRequestTimeout(error) ? 'timeout' : 'error';
      errorName = requestError.name;
      this.send(session.port, { id: request.id, error: requestError.message });
      if (client && isEngineRequestTimeout(error)) {
        await this.handleFeatureTimeout(requestError, client);
      }
    } finally {
      this.inFlightFeatureRequests -= 1;
      performanceLog('debug', 'feature.complete', {
        language: this.options.language,
        method: request.method,
        durationMs: Math.round(performance.now() - startedAt),
        outcome,
        resultCount,
        ...(errorName ? { errorName } : {}),
      });
      await this.maybeRunPlannedRestart();
    }
  }

  private async handleFeatureTimeout(error: Error, client: T): Promise<void> {
    if (client !== this.client) return;
    this.consecutiveFeatureTimeouts += 1;
    if (this.consecutiveFeatureTimeouts < HANG_TIMEOUT_THRESHOLD) return;

    this.consecutiveFeatureTimeouts = 0;
    console.warn(
      `[LeetSense] ${this.options.language} engine unresponsive — restarting`,
    );
    performanceLog('warn', 'engine.unresponsive', {
      language: this.options.language,
      reason: 'consecutive-feature-timeouts',
      ...(this.lastMemorySampleBytes === undefined
        ? {}
        : { heapMb: Math.round(this.lastMemorySampleBytes / 1_048_576) }),
    });
    await this.handleCrash(error, client, 'Engine stopped responding');
  }

  private async closeSession(session: EngineSession): Promise<void> {
    try {
      await session.syncPromise;
      if (session.opened && this.clientPromise) {
        await (await this.clientPromise).closeDocument(session.uri);
      }
    } catch {
      // The engine may already be gone during extension or tab teardown.
    }
  }

  private async bootClient(): Promise<T> {
    const generation = this.generation;
    const startedAt = performance.now();
    performanceLog('info', 'engine.boot.started', {
      language: this.options.language,
    });
    const client = await this.options.createClient({
      onDiagnostics: (params) => {
        const session = [...this.sessions.values()].find(
          (candidate) => candidate.uri === params.uri,
        );
        if (!session || session.disconnected) return;
        this.consecutiveFeatureTimeouts = 0;
        const diagnostics = this.options.mapDiagnostics(params, session.version);
        const diagnosticsAreStale =
          diagnostics.uriVersion < session.targetVersion;
        performanceLog('debug', 'diagnostics.received', {
          language: this.options.language,
          version: diagnostics.uriVersion,
          markerCount: diagnostics.markers.length,
          outcome: diagnosticsAreStale ? 'stale' : 'current',
        });
        this.sendDiagnostics(session, diagnostics);
        if (diagnosticsAreStale) return;
        session.diagnosticsReady = true;
        if (this.status === 'ready') {
          this.sendStatus(session);
        } else {
          this.maybePublishReady();
        }
      },
      onCrash: (error, crashedClient) => {
        void this.handleCrash(error, crashedClient);
      },
      onMemorySample: (bytes, sampledClient) => {
        this.handleMemorySample(bytes, sampledClient);
      },
    });
    if (generation !== this.generation) {
      client.dispose();
      throw new Error(`${this.options.language} engine was disposed during boot`);
    }
    this.client = client;
    console.info(
      `[LeetSense] ${this.options.language} ready in ${Math.round(performance.now() - startedAt)} ms`,
    );
    performanceLog('info', 'engine.boot.ready', {
      language: this.options.language,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return client;
  }

  private async handleCrash(
    error: Error,
    crashedClient: T,
    detail = 'Recovering after an engine failure',
  ): Promise<void> {
    if (this.intentionallyStopped) return;
    await this.restartClient(error, crashedClient, 'failure', detail);
  }

  private async restartClient(
    error: Error,
    crashedClient: T,
    kind: 'failure' | 'planned',
    detail: string,
  ): Promise<void> {
    if (this.intentionallyStopped) return;
    if (crashedClient !== this.client) return;
    this.cancelPlannedRestart();
    for (const session of this.sessions.values()) {
      session.diagnosticsReady = false;
    }
    this.setStatus('restarting', detail);
    performanceLog('warn', 'engine.restart.started', {
      language: this.options.language,
      reason: kind,
    });
    this.consecutiveFeatureTimeouts = 0;
    crashedClient.dispose();
    this.client = undefined;
    this.clientPromise = undefined;
    this.notifyLifecycleChange();
    for (const session of this.sessions.values()) {
      this.sendDiagnostics(session, {
        uriVersion: session.version,
        markers: [],
      });
    }
    if (kind === 'failure') {
      const now = Date.now();
      const rebootIsCoolingDown =
        this.lastAutoRebootAt !== undefined &&
        now - this.lastAutoRebootAt < AUTO_REBOOT_COOLDOWN_MS;
      if (
        rebootIsCoolingDown ||
        (this.sessions.size === 0 && !this.options.eager)
      ) {
        this.fatalError = error;
        this.setStatus('unavailable', toStatusDetail(error));
        performanceLog('error', 'engine.restart.fatal', {
          language: this.options.language,
          reason: 'failure-cooldown',
          errorName: error.name,
        });
        return;
      }
      this.lastAutoRebootAt = now;
    } else if (this.sessions.size === 0 && !this.options.eager) {
      this.teardown(false);
      return;
    }
    const reboot = this.startClientBoot(false);
    let rebootedClient: T | undefined;
    try {
      const client = await reboot;
      rebootedClient = client;
      for (const session of this.sessions.values()) {
        if (session.opened && !session.disconnected) {
          await client.openDocument(session.uri, session.text, session.version);
        }
      }
    } catch (rebootError) {
      if (this.intentionallyStopped) return;
      rebootedClient?.dispose();
      if (!rebootedClient || this.client === rebootedClient) {
        this.client = undefined;
      }
      if (this.clientPromise === reboot) this.clientPromise = undefined;
      this.fatalError = toError(rebootError);
      this.setStatus('unavailable', toStatusDetail(this.fatalError));
      this.notifyLifecycleChange();
      performanceLog('error', 'engine.restart.failed', {
        language: this.options.language,
        reason: kind,
        errorName: this.fatalError.name,
      });
    }
  }

  private handleMemorySample(bytes: number, client: T): void {
    if (
      this.intentionallyStopped ||
      client !== this.client ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) {
      return;
    }
    this.lastMemorySampleBytes = bytes;
    performanceLog('debug', 'engine.memory.sample', {
      language: this.options.language,
      heapMb: Math.round(bytes / 1_048_576),
    });
    const policy = this.options.memoryRestart;
    if (!policy || bytes < policy.thresholdBytes || this.plannedRestartClient) {
      return;
    }
    const now = Date.now();
    if (
      this.lastPlannedRestartAt !== undefined &&
      now - this.lastPlannedRestartAt < policy.minimumIntervalMs
    ) {
      performanceLog('debug', 'engine.memory.restart.skipped', {
        language: this.options.language,
        reason: 'planned-rate-limit',
        heapMb: Math.round(bytes / 1_048_576),
      });
      return;
    }

    this.plannedRestartClient = client;
    console.warn(
      `[LeetSense] ${this.options.language} engine memory ${Math.round(bytes / 1_048_576)} MB — scheduled restart`,
    );
    this.setStatus('restarting', 'Reducing engine memory use');
    void this.maybeRunPlannedRestart();
  }

  private async maybeRunPlannedRestart(): Promise<void> {
    if (this.intentionallyStopped) {
      this.cancelPlannedRestart();
      return;
    }
    const client = this.plannedRestartClient;
    if (!client) return;
    if (client !== this.client) {
      this.cancelPlannedRestart();
      return;
    }
    if (!this.isQuiescent()) {
      if (!this.plannedRestartTimer) {
        this.plannedRestartTimer = setTimeout(() => {
          this.plannedRestartTimer = undefined;
          void this.maybeRunPlannedRestart();
        }, this.options.memoryRestart?.recheckMs ?? 250);
      }
      return;
    }

    this.plannedRestartClient = undefined;
    if (this.plannedRestartTimer) clearTimeout(this.plannedRestartTimer);
    this.plannedRestartTimer = undefined;
    this.lastPlannedRestartAt = Date.now();
    await this.restartClient(
      new Error('Planned engine memory restart'),
      client,
      'planned',
      'Reducing engine memory use',
    );
  }

  private isQuiescent(): boolean {
    return (
      this.inFlightFeatureRequests === 0 &&
      [...this.sessions.values()].every(
        (session) => !session.syncPromise && !session.pendingSync,
      )
    );
  }

  private cancelPlannedRestart(): void {
    if (this.plannedRestartTimer) clearTimeout(this.plannedRestartTimer);
    this.plannedRestartTimer = undefined;
    this.plannedRestartClient = undefined;
  }

  private getClient(): Promise<T> {
    if (this.intentionallyStopped) {
      return Promise.reject(new Error('Language server is stopped'));
    }
    if (this.fatalError) return Promise.reject(this.fatalError);
    return this.clientPromise ?? this.startClientBoot(true);
  }

  private startClientBoot(emitStarting: boolean): Promise<T> {
    if (this.intentionallyStopped) {
      return Promise.reject(new Error('Language server is stopped'));
    }
    if (emitStarting) this.setStatus('starting');
    const boot = this.bootClient();
    this.clientPromise = boot;
    this.notifyLifecycleChange();
    void boot.catch((error: unknown) => {
      if (this.clientPromise !== boot) return;
      this.clientPromise = undefined;
      this.client = undefined;
      this.fatalError = toError(error);
      this.setStatus('unavailable', toStatusDetail(this.fatalError));
      performanceLog('error', 'engine.boot.failed', {
        language: this.options.language,
        errorName: this.fatalError.name,
      });
      this.notifyLifecycleChange();
    });
    return boot;
  }

  private scheduleIdleTeardown(): void {
    if (
      this.options.eager ||
      this.sessions.size > 0 ||
      !this.clientPromise ||
      this.idleTimer
    ) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.sessions.size === 0) this.teardown(false);
    }, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  }

  private teardown(clearDiagnostics: boolean): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const session of this.sessions.values()) {
      session.disconnected = true;
      session.pendingSync = undefined;
      if (clearDiagnostics) {
        this.sendDiagnostics(session, {
          uriVersion: session.version,
          markers: [],
        });
      }
    }
    this.sessions.clear();
    this.generation += 1;
    this.fatalError = undefined;
    this.lastAutoRebootAt = undefined;
    this.consecutiveFeatureTimeouts = 0;
    this.cancelPlannedRestart();
    this.lastPlannedRestartAt = undefined;
    this.lastMemorySampleBytes = undefined;
    this.intentionallyStopped = false;
    this.setStatus('off');
    performanceLog('info', 'engine.teardown', {
      language: this.options.language,
      reason: 'idle',
    });
    const client = this.client;
    const pendingClient = this.clientPromise;
    this.client = undefined;
    this.clientPromise = undefined;
    this.notifyLifecycleChange();
    client?.dispose();
    if (!client) {
      void pendingClient?.then((resolved) => resolved.dispose()).catch(() => {});
    }
  }

  private sendDiagnostics(session: EngineSession, params: DiagnosticsParams): void {
    this.send(session.port, { method: 'diagnostics', params });
  }

  private setStatus(state: EngineStatusState, detail?: string): void {
    if (this.status === state && this.statusDetail === detail) return;
    this.status = state;
    this.statusDetail = detail;
    const frame = this.statusFrame();
    performanceLog('info', 'engine.status', {
      language: this.options.language,
      state,
    });
    for (const session of this.sessions.values()) this.send(session.port, frame);
    this.options.onStatusChange?.(frame);
  }

  private sendStatus(session: EngineSession): void {
    if (this.status === 'ready' && !session.diagnosticsReady) {
      this.send(session.port, {
        type: 'STATUS',
        language: this.options.language,
        state: 'starting',
      });
      return;
    }
    this.send(session.port, this.statusFrame());
  }

  private maybePublishReady(): void {
    if (
      !this.client ||
      (this.status !== 'starting' && this.status !== 'restarting') ||
      this.sessions.size === 0 ||
      [...this.sessions.values()].some((session) => !session.diagnosticsReady)
    ) {
      return;
    }
    this.setStatus('ready');
  }

  private statusFrame(): EngineStatusPush {
    return {
      type: 'STATUS',
      language: this.options.language,
      state: this.status,
      ...(this.statusDetail ? { detail: this.statusDetail } : {}),
    };
  }

  private notifyLifecycleChange(): void {
    this.options.onLifecycleChange?.();
  }

  private cacheStoppedSync(session: EngineSession, sync: DocumentSync): void {
    if (sync.version < session.targetVersion) return;
    session.text = sync.text;
    session.version = sync.version;
    session.targetText = sync.text;
    session.targetVersion = sync.version;
    session.opened = false;
    session.diagnosticsReady = false;
    session.pendingSync = undefined;
    session.syncError = undefined;
  }

  private stopManually(): void {
    this.stopEpoch += 1;
    if (this.intentionallyStopped && this.status === 'stopped') return;
    this.intentionallyStopped = true;
    this.controlQueue = Promise.resolve();
    this.generation += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.cancelPlannedRestart();
    this.fatalError = undefined;
    this.lastAutoRebootAt = undefined;
    this.consecutiveFeatureTimeouts = 0;
    this.lastPlannedRestartAt = undefined;
    this.lastMemorySampleBytes = undefined;

    const client = this.client;
    const pendingClient = this.clientPromise;
    this.client = undefined;
    this.clientPromise = undefined;
    for (const session of this.sessions.values()) {
      session.pendingSync = undefined;
      session.syncError = undefined;
      session.opened = false;
      session.diagnosticsReady = false;
      this.sendDiagnostics(session, {
        uriVersion: session.targetVersion,
        markers: [],
      });
    }
    client?.dispose();
    if (!client) {
      void pendingClient?.then((resolved) => resolved.dispose()).catch(() => {});
    }
    this.setStatus('stopped');
    this.notifyLifecycleChange();
  }

  private async startManually(): Promise<void> {
    if (!this.intentionallyStopped) return;
    this.intentionallyStopped = false;
    this.fatalError = undefined;
    this.lastAutoRebootAt = undefined;
    for (const session of this.sessions.values()) {
      session.opened = false;
      session.diagnosticsReady = false;
      session.syncError = undefined;
    }
    this.setStatus('starting');
    await this.bootAndOpenSessions();
  }

  private async restartManually(): Promise<void> {
    if (this.intentionallyStopped) {
      throw new Error('Start the language server instead');
    }
    if (this.status === 'starting' || this.status === 'restarting') return;

    this.generation += 1;
    this.cancelPlannedRestart();
    this.fatalError = undefined;
    this.lastAutoRebootAt = undefined;
    this.consecutiveFeatureTimeouts = 0;
    const client = this.client;
    const pendingClient = this.clientPromise;
    this.client = undefined;
    this.clientPromise = undefined;
    for (const session of this.sessions.values()) {
      session.opened = false;
      session.diagnosticsReady = false;
      session.syncError = undefined;
      this.sendDiagnostics(session, {
        uriVersion: session.targetVersion,
        markers: [],
      });
    }
    client?.dispose();
    if (!client) {
      void pendingClient?.then((resolved) => resolved.dispose()).catch(() => {});
    }
    this.setStatus('restarting', 'Restarted by user');
    this.notifyLifecycleChange();
    await this.bootAndOpenSessions();
  }

  private async bootAndOpenSessions(): Promise<void> {
    const generation = this.generation;
    try {
      const boot = this.startClientBoot(false);
      const client = await boot;
      if (this.intentionallyStopped || client !== this.client) return;
      for (const session of this.sessions.values()) {
        if (session.disconnected) continue;
        await client.openDocument(
          session.uri,
          session.targetText,
          session.targetVersion,
        );
        if (this.intentionallyStopped || client !== this.client) return;
        session.text = session.targetText;
        session.version = session.targetVersion;
        session.opened = true;
      }
    } catch (error) {
      if (this.intentionallyStopped || generation !== this.generation) return;
      const failure = toError(error);
      this.fatalError = failure;
      this.setStatus('unavailable', toStatusDetail(failure));
      this.notifyLifecycleChange();
      throw failure;
    }
  }

  private send(
    port: Browser.runtime.Port,
    frame: EngineResponse | EngineDiagnosticsPush | EngineStatusPush,
  ): void {
    try {
      port.postMessage(frame);
    } catch {
      // The requesting tab or extension context disappeared.
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toStatusDetail(error: Error): string {
  const message = error.message.trim() || 'Language engine failed to start';
  return message.length <= 240 ? message : `${message.slice(0, 237)}…`;
}

function featureResultCount(result: FeatureResult): number {
  if ('items' in result) return result.items.length;
  if ('signatures' in result) return result.signatures.length;
  return result.contents ? 1 : 0;
}
