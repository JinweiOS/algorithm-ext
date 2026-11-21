/// <reference lib="webworker" />

import { loadClangResourceHeaders } from './resource-pack';
import { LspMessageParser, LspStdinQueue } from './lsp-framing';

interface BootMessage {
  type: 'boot';
  clangdJsUrl: string;
  wasmUrl: string;
  pthreadWorkerUrl: string;
  resourcePackUrl: string;
}

interface SendMessage {
  type: 'send';
  message: Record<string, unknown>;
}

interface ClangdModule {
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
  };
  PThread: { terminateAllThreads(): void };
  callMain(args: string[]): void;
}

type ClangdFactory = (options: Record<string, unknown>) => Promise<ClangdModule>;

const scope = self as unknown as DedicatedWorkerGlobalScope;
const stdinQueue = new LspStdinQueue();
const stdoutParser = new LspMessageParser();
let resolveStdinReady: () => void = () => {};
let stderrLine = '';
let clangd: ClangdModule | undefined;

scope.onmessage = (event: MessageEvent<BootMessage | SendMessage>) => {
  if (event.data.type === 'boot') {
    void boot(event.data).catch(reportCrash);
  } else {
    send(event.data.message);
  }
};

function stdin(): number | null {
  return stdinQueue.read();
}

async function stdinReady(): Promise<void> {
  if (!stdinQueue.hasData) {
    await new Promise<void>((resolve) => {
      resolveStdinReady = resolve;
    });
  }
}

function send(message: Record<string, unknown>): void {
  stdinQueue.enqueue(message);
  resolveStdinReady();
}

function stdout(charCode: number): void {
  try {
    const message = stdoutParser.pushByte(charCode);
    if (message) {
      scope.postMessage({ type: 'lsp', message });
    }
  } catch (error) {
    reportCrash(error);
  }
}

function stderr(charCode: number): void {
  if (charCode === 10) {
    if (stderrLine) console.debug(`[clangd] ${stderrLine}`);
    stderrLine = '';
  } else {
    stderrLine += String.fromCharCode(charCode);
  }
}

async function boot(message: BootMessage): Promise<void> {
  const imported = (await import(/* @vite-ignore */ message.clangdJsUrl)) as {
    default: ClangdFactory;
  };
  clangd = await imported.default({
    thisProgram: '/usr/bin/clangd',
    locateFile(path: string) {
      if (path.endsWith('.wasm')) return message.wasmUrl;
      if (path.endsWith('.worker.mjs')) return message.pthreadWorkerUrl;
      return new URL(path, message.clangdJsUrl).href;
    },
    stdin,
    stdinReady,
    stdout,
    stderr,
    onAbort: reportCrash,
  });

  await loadClangResourceHeaders(clangd.FS, message.resourcePackUrl);
  clangd.FS.mkdirTree('/src');
  clangd.FS.writeFile('/src/warmup.cpp', '');
  clangd.FS.writeFile(
    '/src/.clangd',
    JSON.stringify({
      CompileFlags: {
        Add: [
          '-xc++',
          '-std=c++2b',
          '--target=wasm32-wasi',
          '-isystem/usr/include/c++/v1',
          '-isystem/usr/include/wasm32-wasi/c++/v1',
          '-isystem/usr/include',
          '-isystem/usr/include/wasm32-wasi',
          '-resource-dir=/lib/clang/18',
        ],
      },
    }),
  );
  clangd.callMain([
    '--log=error',
    '--limit-results=100',
    '--completion-style=bundled',
    '--pch-storage=memory',
  ]);
  scope.postMessage({ type: 'ready' });
}

function reportCrash(reason: unknown): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  scope.postMessage({ type: 'crash', error: error.message });
  clangd?.PThread.terminateAllThreads();
}

export {};
