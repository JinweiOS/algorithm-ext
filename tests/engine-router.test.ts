import { describe, expect, it, vi } from 'vitest';

import {
  engineKeyFor,
  routeEngineRequest,
  type EngineBackendTable,
  type RoutedLanguageBackend,
} from '../lib/offscreen/engine-router';

function backend(active = false): RoutedLanguageBackend {
  return {
    isActive: active,
    handleSync: vi.fn(),
    handleFeature: vi.fn(),
    control: vi.fn(async () => {}),
    release: vi.fn(),
  };
}

function table(entries: {
  python3?: RoutedLanguageBackend;
  cpp?: RoutedLanguageBackend;
  javascript?: RoutedLanguageBackend;
  typescript?: RoutedLanguageBackend;
}): EngineBackendTable {
  return new Map([
    ['python3', entries.python3 ?? backend()],
    ['cpp', entries.cpp ?? backend()],
    ['javascript', entries.javascript ?? backend()],
    ['typescript', entries.typescript ?? backend()],
  ]);
}

function recordingPort(): { port: Browser.runtime.Port; messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    port: {
      postMessage: (message: unknown) => messages.push(message),
    } as unknown as Browser.runtime.Port,
  };
}

describe('offscreen engine router', () => {
  it('routes a lifecycle command to one language and acknowledges its correlation', async () => {
    const cpp = backend();
    const backends = table({ cpp });
    const { port, messages } = recordingPort();

    routeEngineRequest(
      {
        id: 'control-1',
        language: 'cpp',
        method: 'control',
        action: 'stop',
      },
      port,
      backends,
    );

    await vi.waitFor(() =>
      expect(messages).toEqual([
        {
          id: 'control-1',
          type: 'CONTROL_ACK',
          language: 'cpp',
          action: 'stop',
        },
      ]),
    );
    expect(cpp.control).toHaveBeenCalledWith('stop');
    expect(backends.get('python3')?.control).not.toHaveBeenCalled();
    expect(backends.get('python3')?.release).not.toHaveBeenCalled();
  });

  it('returns a bounded command error without changing the other backend', async () => {
    const python = backend();
    const backends = table({ python3: python });
    vi.mocked(python.control).mockRejectedValue(
      new Error('Start the language server instead'),
    );
    const { port, messages } = recordingPort();

    routeEngineRequest(
      {
        id: 'control-2',
        language: 'python3',
        method: 'control',
        action: 'restart',
      },
      port,
      backends,
    );

    await vi.waitFor(() =>
      expect(messages[0]).toMatchObject({
        id: 'control-2',
        type: 'CONTROL_ACK',
        language: 'python3',
        action: 'restart',
        error: 'Start the language server instead',
      }),
    );
    expect(backends.get('cpp')?.control).not.toHaveBeenCalled();
  });

  it('sends a document sync to one engine and retires the others', () => {
    const python = backend();
    const cpp = backend();
    const typescript = backend();
    const backends = table({ python3: python, cpp, typescript });
    const { port } = recordingPort();

    routeEngineRequest(
      {
        language: 'typescript',
        method: 'docSync',
        params: { text: 'const p = [];', version: 3 },
      },
      port,
      backends,
    );

    expect(typescript.handleSync).toHaveBeenCalledWith(port, {
      text: 'const p = [];',
      version: 3,
    });
    expect(python.release).toHaveBeenCalledWith(port);
    expect(cpp.release).toHaveBeenCalledWith(port);
    expect(backends.get('javascript')?.release).toHaveBeenCalledWith(port);
    expect(typescript.release).not.toHaveBeenCalled();
  });

  it('treats the legacy python id as python3', () => {
    expect(engineKeyFor('python')).toBe('python3');
    expect(engineKeyFor('javascript')).toBe('javascript');

    const python = backend();
    const backends = table({ python3: python });
    const { port } = recordingPort();

    routeEngineRequest(
      { id: 'hover-1', language: 'python', method: 'hover', params: { line: 1, character: 1 } },
      port,
      backends,
    );

    expect(python.handleFeature).toHaveBeenCalledWith(
      port,
      expect.objectContaining({ id: 'hover-1', language: 'python' }),
    );
  });

  it('drops requests for a language without a backend', () => {
    const backends: EngineBackendTable = new Map();
    const { port, messages } = recordingPort();

    routeEngineRequest(
      { id: 'hover-2', language: 'javascript', method: 'hover', params: { line: 1, character: 1 } },
      port,
      backends,
    );

    expect(messages).toEqual([]);
  });
});
