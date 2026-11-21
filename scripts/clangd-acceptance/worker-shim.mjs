// Deno exposes Web Workers without the browser-only globals emitted by
// Emscripten's worker target. Supply the two globals clangd checks before
// installing the generated pthread worker protocol.
globalThis.window = {};
if (!globalThis.location) {
  Object.defineProperty(globalThis, 'location', {
    value: { href: import.meta.url },
    configurable: true,
  });
}

let moduleInstance = {};
let initialized = false;
const clangdModuleUrl = new URL(import.meta.url).searchParams.get('clangd');

function assert(condition, text) {
  if (!condition) throw new Error(`Assertion failed: ${text}`);
}

function handleMessage(event) {
  const data = event.data;
  try {
    if (data.cmd === 'load') {
      const queued = [];
      globalThis.onmessage = (nextEvent) => queued.push(nextEvent);
      globalThis.startWorker = (instance) => {
        moduleInstance = instance;
        postMessage({ cmd: 'loaded' });
        for (const queuedEvent of queued) handleMessage(queuedEvent);
        globalThis.onmessage = handleMessage;
      };
      moduleInstance.wasmModule = data.wasmModule;
      for (const handler of data.handlers) {
        moduleInstance[handler] = (...args) => {
          postMessage({ cmd: 'callHandler', handler, args });
        };
      }
      moduleInstance.wasmMemory = data.wasmMemory;
      moduleInstance.buffer = data.wasmMemory.buffer;
      moduleInstance.workerID = data.workerID;
      moduleInstance.ENVIRONMENT_IS_PTHREAD = true;
      const moduleUrl = data.urlOrBlob ?? clangdModuleUrl;
      if (!moduleUrl) throw new Error('Missing clangd module URL');
      void import(moduleUrl).then((exports) =>
        exports.default(moduleInstance),
      );
      return;
    }

    if (data.cmd === 'run') {
      moduleInstance.__emscripten_thread_init(data.pthread_ptr, 0, 0, 1);
      moduleInstance.__emscripten_thread_mailbox_await(data.pthread_ptr);
      assert(data.pthread_ptr, 'missing pthread pointer');
      moduleInstance.establishStackSpace();
      moduleInstance.PThread.receiveObjectTransfer(data);
      moduleInstance.PThread.threadInitTLS();
      initialized = true;
      try {
        moduleInstance.invokeEntryPoint(data.start_routine, data.arg);
      } catch (error) {
        if (error !== 'unwind') throw error;
      }
      return;
    }

    if (data.cmd === 'cancel') {
      if (moduleInstance._pthread_self()) {
        moduleInstance.__emscripten_thread_exit(-1);
      }
      return;
    }

    if (data.cmd === 'checkMailbox' && initialized) {
      moduleInstance.checkMailbox();
    }
  } catch (error) {
    console.error('[clangd pthread]', error);
    moduleInstance.__emscripten_thread_crashed?.();
    throw error;
  }
}

globalThis.onunhandledrejection = (event) => {
  throw event.reason ?? event;
};
globalThis.onmessage = handleMessage;
