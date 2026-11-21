interface EmscriptenFileSystem {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
}

interface ResourcePackManifest {
  format: number;
  llvmCommit: string;
  files: Array<{ path: string; offset: number; length: number }>;
}

const MAGIC = 'LSRH1\0\0\0';
const EXPECTED_LLVM_COMMIT = '26a1d6601d727a96f4301d0d8647b5a42760ae0c';

export async function loadClangResourceHeaders(
  fs: EmscriptenFileSystem,
  packUrl: string,
  targetDirectory = '/lib/clang/18/include',
): Promise<number> {
  const response = await fetch(packUrl);
  if (!response.ok) {
    throw new Error(`Unable to load clang resource headers (${response.status})`);
  }
  if (!response.body) throw new Error('Resource-header pack has no body');

  const decompressed = await new Response(
    response.body.pipeThrough(new DecompressionStream('gzip')),
  ).arrayBuffer();
  const bytes = new Uint8Array(decompressed);
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== MAGIC) {
    throw new Error('Invalid resource-header pack');
  }

  const manifestLength = new DataView(decompressed).getUint32(8, true);
  const manifestStart = 12;
  const manifestEnd = manifestStart + manifestLength;
  const manifest = JSON.parse(
    new TextDecoder().decode(bytes.subarray(manifestStart, manifestEnd)),
  ) as ResourcePackManifest;
  if (
    manifest.format !== 1 ||
    manifest.llvmCommit !== EXPECTED_LLVM_COMMIT ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Unsupported resource-header pack');
  }

  fs.mkdirTree(targetDirectory);
  for (const file of manifest.files) {
    if (
      file.path.startsWith('/') ||
      file.path.includes('..') ||
      !Number.isSafeInteger(file.offset) ||
      !Number.isSafeInteger(file.length) ||
      file.offset < 0 ||
      file.length < 0
    ) {
      throw new Error('Unsafe resource-header pack entry');
    }
    const start = manifestEnd + file.offset;
    const end = start + file.length;
    if (end > bytes.length) throw new Error('Truncated resource-header pack');
    const target = `${targetDirectory}/${file.path}`;
    fs.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    fs.writeFile(target, bytes.subarray(start, end));
  }
  return manifest.files.length;
}
