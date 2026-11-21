import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol';

import {
  LanguageEngineBackend,
  type ClientCallbacks,
  type LanguageClient,
} from '../lib/engines/shared/engine-backend';
import { EngineRequestTimeoutError } from '../lib/engines/shared/request-timeout';
import {
  isEngineStatusPush,
  type EngineStatusState,
  type FeatureResult,
} from '../utils/protocol';

class FakeClient implements LanguageClient {
  readonly opened: string[] = [];
  readonly openCalls: Array<{ uri: string; text: string; version: number }> = [];
  readonly closed: string[] = [];
  readonly completionResults: Array<FeatureResult | Error | Promise<FeatureResult>> = [];
  readonly updateErrors: Error[] = [];
  readonly updateWaits: Promise<void>[] = [];
  updateAttempts = 0;
  disposed = false;

  constructor(readonly callbacks: ClientCallbacks<FakeClient>) {}

  async openDocument(uri: string, text: string, version: number): Promise<void> {
    this.opened.push(uri);
    this.openCalls.push({ uri, text, version });
  }

  async updateDocument(): Promise<void> {
    this.updateAttempts += 1;
    await this.updateWaits.shift();
    const error = this.updateErrors.shift();
    if (error) throw error;
  }

  async closeDocument(uri: string): Promise<void> {
    this.closed.push(uri);
  }

  async completion(): Promise<FeatureResult> {
    const result = this.completionResults.shift();
    if (result instanceof Error) throw result;
    return (await result) ?? { items: [{ label: 'push_back', kind: 2 }] };
  }

  async hover(): Promise<FeatureResult> {
    return { contents: 'vector' };
  }

  async signatureHelp(): Promise<FeatureResult> {
    return { signatures: [{ label: 'push_back(const value_type &)' }] };
  }

  dispose(): void {
    this.disposed = true;
  }

  reportMemory(bytes: number): void {
    this.callbacks.onMemorySample?.(bytes, this);
  }

  reportDiagnostics(uri: string, version?: number): void {
    this.callbacks.onDiagnostics({
      uri,
      diagnostics: [],
      ...(version === undefined ? {} : { version }),
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('manual engine lifecycle controls', () => {
  it('stops without losing the latest document or allowing sync and features to reboot it', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages);

    backend.handleSync(port, { text: 'int first;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].reportDiagnostics(clients[0].opened[0]);
    await vi.waitFor(() => expect(statusStates(messages)).toContain('ready'));

    await backend.control('stop');
    expect(clients[0].disposed).toBe(true);
    expect(statusStates(messages).at(-1)).toBe('stopped');
    expect(messages.at(-2)).toMatchObject({
      method: 'diagnostics',
      params: { markers: [] },
    });

    backend.handleSync(port, { text: 'int newest;', version: 2 });
    requestCompletion(backend, port, 'while-stopped');
    await vi.waitFor(() =>
      expect(responseFor(messages, 'while-stopped')).toEqual({
        id: 'while-stopped',
        error: 'Language server is stopped',
      }),
    );
    expect(clients).toHaveLength(1);

    await backend.control('start');
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    expect(clients[1].openCalls).toEqual([
      {
        uri: 'file:///src/tab-7.cpp',
        text: 'int newest;',
        version: 2,
      },
    ]);
    expect(statusStates(messages).at(-1)).toBe('starting');
  });

  it('lets stop win against an in-flight boot generation', async () => {
    let resolveBoot: (client: FakeClient) => void = () => {};
    let callbacks: ClientCallbacks<FakeClient> | undefined;
    const boot = new Promise<FakeClient>((resolve) => {
      resolveBoot = resolve;
    });
    const messages: unknown[] = [];
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      createClient: async (nextCallbacks) => {
        callbacks = nextCallbacks;
        return boot;
      },
      mapDiagnostics: (_params, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });

    backend.handleSync(fakePort(messages), { text: 'int value;', version: 1 });
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    await backend.control('stop');
    const staleClient = new FakeClient(callbacks!);
    resolveBoot(staleClient);

    await vi.waitFor(() => expect(staleClient.disposed).toBe(true));
    expect(statusStates(messages).at(-1)).toBe('stopped');
    expect(statusStates(messages)).not.toContain('unavailable');
    expect(messages).toContainEqual({
      method: 'diagnostics',
      params: { uriVersion: 1, markers: [] },
    });
    expect(backend.isActive).toBe(false);
  });

  it('manually restarts an unavailable engine with the latest document and a fresh failure cooldown', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    let attempt = 0;
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      createClient: async (callbacks) => {
        attempt += 1;
        if (attempt === 1) throw new Error('wasm initialization failed');
        const client = new FakeClient(callbacks);
        clients.push(client);
        return client;
      },
      mapDiagnostics: (_params, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });
    const port = fakePort(messages);

    backend.handleSync(port, { text: 'int latest;', version: 4 });
    await vi.waitFor(() =>
      expect(statusStates(messages)).toContain('unavailable'),
    );

    await backend.control('restart');
    expect(clients[0].openCalls).toEqual([
      {
        uri: 'file:///src/tab-7.cpp',
        text: 'int latest;',
        version: 4,
      },
    ]);
    clients[0].reportDiagnostics(clients[0].opened[0], 4);
    await vi.waitFor(() => expect(statusStates(messages).at(-1)).toBe('ready'));

    clients[0].completionResults.push(featureTimeout(), featureTimeout());
    await triggerHang(backend, port, messages, 'after-manual');
    await vi.waitFor(() => expect(clients).toHaveLength(2));
  });

  it('does not let duplicate controls create multiple clients and rejects restart while stopped', async () => {
    const clients: FakeClient[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort([]);

    backend.handleSync(port, { text: 'int value;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    await backend.control('stop');

    await expect(backend.control('restart')).rejects.toThrow(
      'Start the language server instead',
    );
    await Promise.all([backend.control('start'), backend.control('start')]);
    expect(clients).toHaveLength(2);
    clients[1].reportDiagnostics(clients[1].opened[0], 1);

    await Promise.all([
      backend.control('restart'),
      backend.control('restart'),
    ]);
    expect(clients).toHaveLength(3);
  });

  it('lets a newer stop cancel an older queued start from another tab', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages);

    backend.handleSync(port, { text: 'int value;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    await backend.control('stop');

    const olderStart = backend.control('start');
    const newerStop = backend.control('stop');
    await Promise.all([olderStart, newerStop]);

    expect(clients).toHaveLength(1);
    expect(statusStates(messages).at(-1)).toBe('stopped');
    expect(backend.isActive).toBe(false);
  });

  it('allows a fresh start after stop even when the invalidated start boot is still pending', async () => {
    let attempt = 0;
    let resolveStaleBoot: (client: FakeClient) => void = () => {};
    let staleCallbacks: ClientCallbacks<FakeClient> | undefined;
    const staleBoot = new Promise<FakeClient>((resolve) => {
      resolveStaleBoot = resolve;
    });
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      createClient: async (callbacks) => {
        attempt += 1;
        if (attempt === 2) {
          staleCallbacks = callbacks;
          return staleBoot;
        }
        const client = new FakeClient(callbacks);
        clients.push(client);
        return client;
      },
      mapDiagnostics: (_params, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });
    const port = fakePort(messages);

    backend.handleSync(port, { text: 'int latest;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    await backend.control('stop');

    const invalidatedStart = backend.control('start');
    await vi.waitFor(() => expect(staleCallbacks).toBeDefined());
    await backend.control('stop');
    const freshStart = backend.control('start');

    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await freshStart;
    expect(clients[1].openCalls[0]).toMatchObject({
      text: 'int latest;',
      version: 1,
    });

    const staleClient = new FakeClient(staleCallbacks!);
    resolveStaleBoot(staleClient);
    await invalidatedStart;
    await vi.waitFor(() => expect(staleClient.disposed).toBe(true));
    expect(statusStates(messages)).not.toContain('unavailable');
    expect(backend.isActive).toBe(true);
  });

  it('broadcasts stopped state to all attached tabs and gives late sessions the same state', async () => {
    const clients: FakeClient[] = [];
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const lateMessages: unknown[] = [];
    const backend = createLazyBackend(clients);

    backend.handleSync(fakePort(firstMessages, 7), { text: 'int a;', version: 1 });
    backend.handleSync(fakePort(secondMessages, 8), { text: 'int b;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(2));

    await backend.control('stop');
    expect(statusStates(firstMessages).at(-1)).toBe('stopped');
    expect(statusStates(secondMessages).at(-1)).toBe('stopped');

    backend.handleSync(fakePort(lateMessages, 9), { text: 'int c;', version: 1 });
    expect(statusStates(lateMessages)).toEqual(['stopped']);
    expect(clients).toHaveLength(1);
  });
});

describe('C++ engine lifecycle', () => {
  it('boots automatically on the first C++ sync and serves the session', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      createClient: async (callbacks) => {
        const client = new FakeClient(callbacks);
        clients.push(client);
        return client;
      },
      mapDiagnostics: (_params: PublishDiagnosticsParams, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });
    const port = fakePort(messages);

    expect(clients).toHaveLength(0);
    backend.handleSync(port, { text: 'vector<int> values;', version: 1 });
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    await vi.waitFor(() => expect(clients[0].opened).toHaveLength(1));

    backend.handleFeature(port, {
      id: 'completion-1',
      language: 'cpp',
      method: 'completion',
      params: { line: 0, character: 19 },
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        id: 'completion-1',
        result: { items: [{ label: 'push_back', kind: 2 }] },
      }),
    );

  });

  it('releases an idle engine after the configured grace period', async () => {
    vi.useFakeTimers();
    const clients: FakeClient[] = [];
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      idleTimeoutMs: 250,
      createClient: async (callbacks) => {
        const client = new FakeClient(callbacks);
        clients.push(client);
        return client;
      },
      mapDiagnostics: (_params, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });
    const port = fakePort([]);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1);
    backend.release(port);
    await vi.advanceTimersByTimeAsync(249);
    expect(clients[0].disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients[0].disposed).toBe(true);
  });
});

describe('engine hang recovery', () => {
  it('reboots and re-opens documents after two consecutive feature timeouts', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      createClient: async (callbacks) => {
        const client = new FakeClient(callbacks);
        clients.push(client);
        return client;
      },
      mapDiagnostics: (_params, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });
    const port = fakePort(messages);

    backend.handleSync(port, { text: 'vector<int> values;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].completionResults.push(featureTimeout(), featureTimeout());

    requestCompletion(backend, port, 'timeout-1');
    await vi.waitFor(() => expect(responseFor(messages, 'timeout-1')).toBeTruthy());
    requestCompletion(backend, port, 'timeout-2');

    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() =>
      expect(clients[1].opened).toEqual(['file:///src/tab-7.cpp']),
    );
    expect(clients[0].disposed).toBe(true);
  });

  it('resets the timeout count after a successful feature response', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].completionResults.push(
      featureTimeout(),
      { items: [{ label: 'size', kind: 2 }] },
      featureTimeout(),
    );

    for (const id of ['timeout-1', 'success', 'timeout-2']) {
      requestCompletion(backend, port, id);
      await vi.waitFor(() => expect(responseFor(messages, id)).toBeTruthy());
    }

    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(false);
  });

  it('becomes fatal when a second hang happens inside the reboot cooldown', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].completionResults.push(featureTimeout(), featureTimeout());
    await triggerHang(backend, port, messages, 'first');
    await vi.waitFor(() => expect(clients).toHaveLength(2));

    clients[1].completionResults.push(featureTimeout(), featureTimeout());
    await triggerHang(backend, port, messages, 'second');
    await vi.waitFor(() => expect(clients[1].disposed).toBe(true));

    expect(clients).toHaveLength(2);
  });

  it('allows another reboot after the cooldown expires', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].completionResults.push(featureTimeout(), featureTimeout());
    await triggerHang(backend, port, messages, 'first');
    await vi.waitFor(() => expect(clients).toHaveLength(2));

    now += 5 * 60_000;
    clients[1].completionResults.push(featureTimeout(), featureTimeout());
    await triggerHang(backend, port, messages, 'second');

    await vi.waitFor(() => expect(clients).toHaveLength(3));
    await vi.waitFor(() => expect(clients[2].opened).toHaveLength(1));
  });

  it('does not treat sync-only timeout failures as hang signals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const clients: FakeClient[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort([]);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].updateErrors.push(featureTimeout(), featureTimeout());
    backend.handleSync(port, { text: 'a', version: 2 });
    await vi.waitFor(() => expect(clients[0].updateAttempts).toBe(1));
    backend.handleSync(port, { text: 'ab', version: 3 });
    await vi.waitFor(() => expect(clients[0].updateAttempts).toBe(2));

    expect(clients).toHaveLength(1);
    expect(clients[0].disposed).toBe(false);
  });

  it('does not let diagnostics for an unrelated document reset the watchdog', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].completionResults.push(featureTimeout(), featureTimeout());

    requestCompletion(backend, port, 'timeout-1');
    await vi.waitFor(() => expect(responseFor(messages, 'timeout-1')).toBeTruthy());
    clients[0].reportDiagnostics('file:///src/warmup.cpp');
    requestCompletion(backend, port, 'timeout-2');

    await vi.waitFor(() => expect(clients).toHaveLength(2));
  });
});

describe('engine lifecycle status', () => {
  it('keeps starting visible until live-document diagnostics arrive, then publishes ready after them', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages, 7);

    backend.handleSync(port, { text: 'int broken = "value";', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));

    expect(statusStates(messages)).toEqual(['starting']);

    clients[0].reportDiagnostics(clients[0].opened[0]);
    await vi.waitFor(() => expect(statusStates(messages)).toContain('ready'));

    const diagnosticsIndex = messages.findIndex(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'method' in message &&
        message.method === 'diagnostics',
    );
    const readyIndex = messages.findIndex(
      (message) => isEngineStatusPush(message) && message.state === 'ready',
    );
    expect(diagnosticsIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(diagnosticsIndex);
  });

  it('does not become ready from diagnostics older than a pending document sync', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages, 7);

    backend.handleSync(port, { text: 'int value;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    let releaseUpdate: () => void = () => {};
    clients[0].updateWaits.push(
      new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      }),
    );
    backend.handleSync(port, { text: 'int value = "bad";', version: 2 });
    await vi.waitFor(() => expect(clients[0].updateAttempts).toBe(1));

    clients[0].reportDiagnostics(clients[0].opened[0], 1);
    expect(statusStates(messages)).not.toContain('ready');

    releaseUpdate();
    clients[0].reportDiagnostics(clients[0].opened[0], 2);
    await vi.waitFor(() => expect(statusStates(messages)).toContain('ready'));
  });

  it('publishes starting then ready and gates a late session on its diagnostics', async () => {
    const clients: FakeClient[] = [];
    const firstMessages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const firstPort = fakePort(firstMessages, 7);

    backend.handleSync(firstPort, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].reportDiagnostics(clients[0].opened[0]);
    await vi.waitFor(() =>
      expect(statusStates(firstMessages)).toEqual(['starting', 'ready']),
    );

    const lateMessages: unknown[] = [];
    backend.handleSync(fakePort(lateMessages, 8), { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0].opened).toHaveLength(2));
    expect(statusStates(lateMessages)).toEqual(['starting']);
    clients[0].reportDiagnostics(clients[0].opened[1]);
    await vi.waitFor(() =>
      expect(statusStates(lateMessages)).toEqual(['starting', 'ready']),
    );
  });

  it('publishes restart and fatal details from the recovery policy', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients);
    const port = fakePort(messages);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].reportDiagnostics(clients[0].opened[0]);
    await vi.waitFor(() => expect(statusStates(messages)).toContain('ready'));
    clients[0].callbacks.onCrash(new Error('worker aborted'), clients[0]);
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    clients[1].callbacks.onCrash(new Error('worker aborted again'), clients[1]);

    await vi.waitFor(() =>
      expect(statusStates(messages).slice(-3)).toEqual([
        'ready',
        'restarting',
        'unavailable',
      ]),
    );
    const unavailable = messages
      .filter(isEngineStatusPush)
      .findLast((frame) => frame.state === 'unavailable');
    expect(unavailable?.detail).toContain('worker aborted again');
  });

  it('emits off when idle teardown finishes', async () => {
    const clients: FakeClient[] = [];
    const states: EngineStatusState[] = [];
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      idleTimeoutMs: 1,
      onStatusChange: (status) => states.push(status.state),
      createClient: async (callbacks) => {
        const client = new FakeClient(callbacks);
        clients.push(client);
        return client;
      },
      mapDiagnostics: (_params, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });
    const port = fakePort([]);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].reportDiagnostics(clients[0].opened[0]);
    await vi.waitFor(() => expect(states).toContain('ready'));
    backend.release(port);

    await vi.waitFor(() => expect(states.at(-1)).toBe('off'));
  });

  it('publishes unavailable and stops reporting active after initial boot fails', async () => {
    const messages: unknown[] = [];
    const backend = new LanguageEngineBackend<FakeClient>({
      language: 'cpp',
      extension: 'cpp',
      eager: false,
      createClient: async () => {
        throw new Error('wasm initialization failed');
      },
      mapDiagnostics: (_params, version) => ({
        uriVersion: version,
        markers: [],
      }),
    });

    backend.handleSync(fakePort(messages), { text: '', version: 1 });

    await vi.waitFor(() =>
      expect(statusStates(messages)).toContain('unavailable'),
    );
    expect(backend.isActive).toBe(false);
  });
});

describe('planned engine restart', () => {
  it('restarts exactly once at the threshold and re-opens documents', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients, memoryRestartOptions());
    const port = fakePort(messages);

    backend.handleSync(port, { text: 'vector<int> values;', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].reportMemory(100);
    clients[0].reportMemory(101);
    clients[0].reportMemory(200);

    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() =>
      expect(clients[1].opened).toEqual(['file:///src/tab-7.cpp']),
    );
    clients[1].reportDiagnostics(clients[1].opened[0]);
    await vi.waitFor(() => expect(statusStates(messages).at(-1)).toBe('ready'));
    expect(statusStates(messages)).toContain('restarting');
    expect(statusStates(messages).at(-1)).toBe('ready');
  });

  it('waits for an in-flight feature request before restarting', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients, memoryRestartOptions());
    const port = fakePort(messages);
    let resolveCompletion: (result: FeatureResult) => void = () => {};
    const completion = new Promise<FeatureResult>((resolve) => {
      resolveCompletion = resolve;
    });

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].completionResults.push(completion);
    requestCompletion(backend, port, 'slow');
    await vi.waitFor(() => expect(clients[0].completionResults).toHaveLength(0));
    clients[0].reportMemory(101);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clients).toHaveLength(1);

    resolveCompletion({ items: [{ label: 'size', kind: 2 }] });
    await vi.waitFor(() => expect(responseFor(messages, 'slow')).toBeTruthy());
    await vi.waitFor(() => expect(clients).toHaveLength(2));
  });

  it('rate-limits a second threshold crossing', async () => {
    const clients: FakeClient[] = [];
    const backend = createLazyBackend(clients, memoryRestartOptions());
    const port = fakePort([]);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].reportMemory(101);
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    clients[1].reportMemory(101);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clients).toHaveLength(2);
    expect(clients[1].disposed).toBe(false);
  });

  it('does not consume the hang-recovery cooldown budget', async () => {
    const clients: FakeClient[] = [];
    const messages: unknown[] = [];
    const backend = createLazyBackend(clients, memoryRestartOptions());
    const port = fakePort(messages);

    backend.handleSync(port, { text: '', version: 1 });
    await vi.waitFor(() => expect(clients[0]?.opened).toHaveLength(1));
    clients[0].reportMemory(101);
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    clients[1].completionResults.push(featureTimeout(), featureTimeout());
    await triggerHang(backend, port, messages, 'after-planned');

    await vi.waitFor(() => expect(clients).toHaveLength(3));
  });
});

function createLazyBackend(
  clients: FakeClient[],
  memoryRestart?: {
    thresholdBytes: number;
    minimumIntervalMs: number;
    recheckMs: number;
  },
): LanguageEngineBackend<FakeClient> {
  return new LanguageEngineBackend<FakeClient>({
    language: 'cpp',
    extension: 'cpp',
    eager: false,
    memoryRestart,
    createClient: async (callbacks) => {
      const client = new FakeClient(callbacks);
      clients.push(client);
      return client;
    },
    mapDiagnostics: (params, version) => ({
      uriVersion: params.version ?? version,
      markers: [],
    }),
  });
}

function memoryRestartOptions() {
  return {
    thresholdBytes: 100,
    minimumIntervalMs: 10 * 60_000,
    recheckMs: 1,
  };
}

function featureTimeout(): EngineRequestTimeoutError {
  return new EngineRequestTimeoutError('fake', 'textDocument/completion');
}

function requestCompletion(
  backend: LanguageEngineBackend<FakeClient>,
  port: Browser.runtime.Port,
  id: string,
): void {
  backend.handleFeature(port, {
    id,
    language: 'cpp',
    method: 'completion',
    params: { line: 0, character: 0 },
  });
}

async function triggerHang(
  backend: LanguageEngineBackend<FakeClient>,
  port: Browser.runtime.Port,
  messages: unknown[],
  prefix: string,
): Promise<void> {
  for (const suffix of ['1', '2']) {
    const id = `${prefix}-${suffix}`;
    requestCompletion(backend, port, id);
    await vi.waitFor(() => expect(responseFor(messages, id)).toBeTruthy());
  }
}

function responseFor(messages: unknown[], id: string): unknown {
  return messages.find(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      message.id === id,
  );
}

function statusStates(messages: unknown[]): EngineStatusState[] {
  return messages.filter(isEngineStatusPush).map((message) => message.state);
}

function fakePort(messages: unknown[], tabId = 7): Browser.runtime.Port {
  return {
    sender: { tab: { id: tabId } },
    postMessage(message: unknown) {
      messages.push(message);
    },
  } as Browser.runtime.Port;
}
