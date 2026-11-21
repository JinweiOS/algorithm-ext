import {
  LspMessageParser,
  LspStdinQueue,
} from '../../lib/engines/cpp/lsp-framing.ts';
import { CPP_PRELUDE } from '../../lib/engines/cpp/prelude.ts';

const DEFAULT_TIMEOUT_MS = 45_000;
const VECTOR_MEMBERS = new Set([
  'assign',
  'at',
  'back',
  'begin',
  'capacity',
  'clear',
  'data',
  'emplace_back',
  'empty',
  'end',
  'erase',
  'front',
  'insert',
  'pop_back',
  'push_back',
  'reserve',
  'resize',
  'size',
]);

const args = parseArgs(Deno.args);
const artifactDir = new URL(
  `${args.artifactDir.replace(/\/$/, '')}/`,
  `file://${Deno.cwd()}/`,
);
const clangdJsUrl = new URL('clangd.js', artifactDir);
const clangdWasmUrl = new URL('clangd.wasm', artifactDir);
const pthreadWorkerUrl = new URL('./worker-shim.mjs', import.meta.url);
pthreadWorkerUrl.searchParams.set('clangd', clangdJsUrl.href);

globalThis.window = {};
if (!globalThis.location) {
  Object.defineProperty(globalThis, 'location', {
    value: { href: import.meta.url },
    configurable: true,
  });
}

const wasmBinary = await Deno.readFile(clangdWasmUrl);
const { default: createClangd } = await import(clangdJsUrl.href);
const stdinQueue = new LspStdinQueue();
const stdoutParser = new LspMessageParser();
const pending = new Map();
const diagnostics = [];
let nextId = 1;
let resolveStdinReady = () => {};
let stderrLine = '';

function stdin() {
  return stdinQueue.read();
}

async function stdinReady() {
  if (!stdinQueue.hasData) {
    await new Promise((resolve) => {
      resolveStdinReady = resolve;
    });
  }
}

function send(message) {
  stdinQueue.enqueue(message);
  resolveStdinReady();
}

function request(method, params) {
  const id = nextId++;
  return withTimeout(
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    }),
    args.timeoutMs,
    `${method} timed out`,
  );
}

function stdout(charCode) {
  const message = stdoutParser.pushByte(charCode);
  if (message) handleMessage(message);
}

function stderr(charCode) {
  if (charCode === 10) {
    if (args.verbose && stderrLine) console.error(stderrLine);
    stderrLine = '';
    return;
  }
  stderrLine += String.fromCharCode(charCode);
}

function handleMessage(message) {
  if (message.method === 'textDocument/publishDiagnostics') {
    diagnostics.push(...(message.params?.diagnostics ?? []));
    return;
  }
  if (message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
}

const startedAt = performance.now();
const clangd = await createClangd({
  thisProgram: '/usr/bin/clangd',
  wasmBinary,
  locateFile(path) {
    if (path.endsWith('.worker.mjs')) return pthreadWorkerUrl.href;
    return new URL(path, artifactDir).href;
  },
  stdin,
  stdinReady,
  stdout,
  stderr,
  onAbort(reason) {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`clangd aborted: ${String(reason)}`));
    }
    pending.clear();
  },
});

if (args.dumpPath) {
  const stat = clangd.FS.stat(args.dumpPath);
  if (clangd.FS.isDir(stat.mode)) {
    console.log(clangd.FS.readdir(args.dumpPath).join('\n'));
  } else {
    console.log(clangd.FS.readFile(args.dumpPath, { encoding: 'utf8' }));
  }
  clangd.PThread.terminateAllThreads();
  Deno.exit(0);
}

if (args.resourceHeaders) {
  await copyResourceHeaders(
    clangd.FS,
    args.resourceHeaders,
    '/lib/clang/18/include',
  );
} else {
  const resourcePack = args.resourcePack
    ? new URL(args.resourcePack, `file://${Deno.cwd()}/`)
    : new URL('clang-resource-headers.pack.gz', artifactDir);
  await loadResourceHeaderPack(clangd.FS, resourcePack);
}

clangd.FS.mkdirTree('/home/web_user');
clangd.FS.writeFile('/home/web_user/main.cpp', '');
clangd.FS.writeFile(
  '/home/web_user/.clangd',
  JSON.stringify({ CompileFlags: { Add: compileFlags(args.variant) } }),
);
clangd.callMain(clangdArgs(args.profile));

await request('initialize', {
  processId: null,
  rootUri: 'file:///home/web_user',
  capabilities: {
    textDocument: {
      completion: {
        completionItem: {
          snippetSupport: true,
          ...(args.profile === 'baseline'
            ? { documentationFormat: ['markdown', 'plaintext'] }
            : {}),
        },
      },
      publishDiagnostics: { versionSupport: true },
    },
  },
  workspaceFolders: [
    { uri: 'file:///home/web_user', name: 'workspace' },
  ],
});
send({ jsonrpc: '2.0', method: 'initialized', params: {} });

const source = [
  '#include <vector>',
  'int main() {',
  '  std::vector<int> values;',
  '  values.',
  '}',
  '',
].join('\n');
send({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: {
    textDocument: {
      uri: 'file:///home/web_user/main.cpp',
      languageId: 'cpp',
      version: 1,
      text: source,
    },
  },
});

await delay(1_000);
let items = [];
for (let attempt = 0; attempt < 4; attempt += 1) {
  const result = await request('textDocument/completion', {
    textDocument: { uri: 'file:///home/web_user/main.cpp' },
    position: { line: 3, character: 9 },
    context: { triggerKind: 2, triggerCharacter: '.' },
  });
  items = Array.isArray(result) ? result : (result?.items ?? []);
  if (items.some((item) => VECTOR_MEMBERS.has(normalizeLabel(item.label)))) break;
  await delay(1_500);
}

const labels = items.map((item) => normalizeLabel(item.label));
const semanticMembers = [...new Set(labels.filter((label) => VECTOR_MEMBERS.has(label)))];

const featureSource = [
  '#include <vector>',
  'int main() {',
  '  std::vector<int> values;',
  '  values.push_back(1);',
  '  int wrong = "s";',
  '}',
  '',
].join('\n');
send({
  jsonrpc: '2.0',
  method: 'textDocument/didChange',
  params: {
    textDocument: {
      uri: 'file:///home/web_user/main.cpp',
      version: 2,
    },
    contentChanges: [{ text: featureSource }],
  },
});
await delay(750);
const hover = await request('textDocument/hover', {
  textDocument: { uri: 'file:///home/web_user/main.cpp' },
  position: { line: 2, character: 8 },
});
const signature = await request('textDocument/signatureHelp', {
  textDocument: { uri: 'file:///home/web_user/main.cpp' },
  position: { line: 3, character: 19 },
});
await delay(750);
const diagnosticMessages = diagnostics.map((diagnostic) => diagnostic.message);
const hoverPassed = JSON.stringify(hover).toLowerCase().includes('vector');
const signatureLabels = (signature?.signatures ?? []).map((item) => item.label);
const signaturePassed = signatureLabels.some((label) =>
  String(label).includes('push_back'),
);
const diagnosticPassed = diagnosticMessages.some((message) => {
  const normalized = String(message).toLowerCase();
  return (
    normalized.includes('cannot initialize') ||
    normalized.includes('incompatible') ||
    normalized.includes('conversion')
  );
});
const runtimeMetrics = args.measureRuntime
  ? await measureRuntimeCompletions(args.prelude)
  : undefined;
const report = {
  artifactDir: artifactDir.pathname,
  variant: args.variant,
  bootAndProbeMs: Math.round(performance.now() - startedAt),
  completionCount: items.length,
  semanticMembers,
  hoverPassed,
  signaturePassed,
  signatureLabels,
  diagnosticPassed,
  diagnostics: diagnosticMessages,
  ...(runtimeMetrics ? { runtimeMetrics } : {}),
  passed:
    semanticMembers.includes('push_back') &&
    semanticMembers.includes('size') &&
    hoverPassed &&
    signaturePassed &&
    diagnosticPassed,
};
console.log(JSON.stringify(report, null, 2));
clangd.PThread.terminateAllThreads();

if (!report.passed) Deno.exit(1);

function normalizeLabel(label) {
  return String(label).replace(/\(.*/, '').trim();
}

function compileFlags(variant) {
  const common = ['-xc++', '-std=c++2b', '--target=wasm32-wasi'];
  if (variant === 'recorded') {
    return [
      ...common,
      '-isystem/usr/include/c++/v1',
      '-isystem/usr/include/wasm32-wasi/c++/v1',
      '-isystem/usr/include',
      '-isystem/usr/include/wasm32-wasi',
      '-resource-dir=/lib/clang/18',
    ];
  }
  if (variant === 'targeted') {
    return [
      ...common,
      '-nostdinc',
      '-nostdinc++',
      '-isystem/usr/include/wasm32-wasi/c++/v1',
      '-isystem/usr/include/wasm32-wasi',
      '-resource-dir=/lib/clang/18',
    ];
  }
  return [
    '-xc++',
    '-std=c++2b',
    '--target=wasm32-wasi-threads',
    '-nostdinc',
    '-nostdinc++',
    '-isystem/usr/include/wasm32-wasi-threads/c++/v1',
    '-isystem/usr/include/wasm32-wasi-threads',
    '-resource-dir=/lib/clang/18',
  ];
}

function clangdArgs(profile) {
  if (profile === 'baseline') return ['--log=error'];
  return [
    '--log=error',
    '--limit-results=100',
    '--completion-style=bundled',
    '--pch-storage=memory',
  ];
}

async function measureRuntimeCompletions(preludeVariant) {
  const prelude =
    preludeVariant === 'trimmed'
      ? CPP_PRELUDE.replace(
          /^#include <(?:tuple|bitset|array|limits|memory)>\n/gm,
          '',
        )
      : CPP_PRELUDE;
  const std = await measureCompletionSource(
    `${prelude}int main() {\n  std::\n}\n`,
    'std::',
    10,
  );
  const vector = await measureCompletionSource(
    `${prelude}int main() {\n  std::vector<int> values;\n  values.\n}\n`,
    'values.',
    11,
  );
  return {
    profile: args.profile,
    prelude: preludeVariant,
    preludeHeaders: prelude.match(/^#include /gm)?.length ?? 0,
    preludeLineCount: prelude.match(/\n/g)?.length ?? 0,
    std,
    vector,
  };
}

async function measureCompletionSource(source, needle, version) {
  const lines = source.split('\n');
  const line = lines.findIndex((candidate) => candidate.includes(needle));
  if (line < 0) throw new Error(`Measurement needle not found: ${needle}`);
  const character = lines[line].indexOf(needle) + needle.length;
  send({
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: {
      textDocument: {
        uri: 'file:///home/web_user/main.cpp',
        version,
      },
      contentChanges: [{ text: source }],
    },
  });
  await delay(1_500);

  const latenciesMs = [];
  const responseBytes = [];
  const itemCounts = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAt = performance.now();
    const result = await request('textDocument/completion', {
      textDocument: { uri: 'file:///home/web_user/main.cpp' },
      position: { line, character },
      context: { triggerKind: 2, triggerCharacter: needle.at(-1) },
    });
    latenciesMs.push(Math.round(performance.now() - startedAt));
    responseBytes.push(
      new TextEncoder().encode(JSON.stringify(result)).byteLength,
    );
    itemCounts.push(
      Array.isArray(result) ? result.length : (result?.items?.length ?? 0),
    );
    await delay(250);
  }

  return {
    latenciesMs,
    medianLatencyMs: [...latenciesMs].sort((a, b) => a - b)[1],
    responseBytes,
    itemCounts,
  };
}

function parseArgs(values) {
  const result = {
    artifactDir: 'public/clangd',
    variant: 'recorded',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    verbose: false,
    profile: 'phase3.2',
    prelude: 'full',
    measureRuntime: false,
    dumpPath: undefined,
    resourceHeaders: undefined,
    resourcePack: undefined,
  };
  for (const value of values) {
    if (value.startsWith('--artifact-dir=')) {
      result.artifactDir = value.slice('--artifact-dir='.length);
    } else if (value.startsWith('--variant=')) {
      result.variant = value.slice('--variant='.length);
    } else if (value.startsWith('--timeout-ms=')) {
      result.timeoutMs = Number(value.slice('--timeout-ms='.length));
    } else if (value === '--verbose') {
      result.verbose = true;
    } else if (value === '--measure-runtime') {
      result.measureRuntime = true;
    } else if (value.startsWith('--profile=')) {
      result.profile = value.slice('--profile='.length);
    } else if (value.startsWith('--prelude=')) {
      result.prelude = value.slice('--prelude='.length);
    } else if (value.startsWith('--dump-path=')) {
      result.dumpPath = value.slice('--dump-path='.length);
    } else if (value.startsWith('--resource-headers=')) {
      result.resourceHeaders = value.slice('--resource-headers='.length);
    } else if (value.startsWith('--resource-pack=')) {
      result.resourcePack = value.slice('--resource-pack='.length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!['recorded', 'targeted', 'threads'].includes(result.variant)) {
    throw new Error(`Unknown variant: ${result.variant}`);
  }
  if (!['baseline', 'phase3.2'].includes(result.profile)) {
    throw new Error(`Unknown profile: ${result.profile}`);
  }
  if (!['full', 'trimmed'].includes(result.prelude)) {
    throw new Error(`Unknown prelude: ${result.prelude}`);
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function copyResourceHeaders(fs, sourceDirectory, targetDirectory) {
  fs.mkdirTree(targetDirectory);
  for await (const entry of Deno.readDir(sourceDirectory)) {
    const source = `${sourceDirectory}/${entry.name}`;
    const target = `${targetDirectory}/${entry.name}`;
    if (entry.isDirectory) {
      await copyResourceHeaders(fs, source, target);
    } else if (entry.isFile) {
      fs.writeFile(target, await Deno.readFile(source));
    }
  }
}

async function loadResourceHeaderPack(fs, packUrl) {
  const compressed = await Deno.readFile(packUrl);
  const decompressed = await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer();
  const bytes = new Uint8Array(decompressed);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== 'LSRH1\0\0\0') throw new Error('Invalid resource-header pack');
  const manifestLength = new DataView(decompressed).getUint32(8, true);
  const manifestStart = 12;
  const manifestEnd = manifestStart + manifestLength;
  const manifest = JSON.parse(
    new TextDecoder().decode(bytes.subarray(manifestStart, manifestEnd)),
  );
  const targetDirectory = '/lib/clang/18/include';
  fs.mkdirTree(targetDirectory);
  for (const file of manifest.files) {
    const target = `${targetDirectory}/${file.path}`;
    fs.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    const start = manifestEnd + file.offset;
    fs.writeFile(target, bytes.subarray(start, start + file.length));
  }
}
