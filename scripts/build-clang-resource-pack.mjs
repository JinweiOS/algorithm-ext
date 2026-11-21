import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const MAGIC = Buffer.from('LSRH1\0\0\0', 'ascii');
const LLVM_COMMIT = '26a1d6601d727a96f4301d0d8647b5a42760ae0c';
const sourceDirectory = resolve(
  process.argv[2] ?? '/tmp/llvm-project-18.1.2/clang/lib/Headers',
);
const outputPath = resolve(
  process.argv[3] ?? 'public/clangd/clang-resource-headers.pack.gz',
);

const sourceFiles = await collectFiles(sourceDirectory);
const fileEntries = [];
const contents = [];
let offset = 0;

for (const sourcePath of sourceFiles) {
  const content = await readFile(sourcePath);
  const path = relative(sourceDirectory, sourcePath).replaceAll('\\', '/');
  fileEntries.push({ path, offset, length: content.length });
  contents.push(content);
  offset += content.length;
}

const manifest = Buffer.from(
  JSON.stringify({
    format: 1,
    llvmCommit: LLVM_COMMIT,
    files: fileEntries,
  }),
  'utf8',
);
const manifestLength = Buffer.alloc(4);
manifestLength.writeUInt32LE(manifest.length);
const pack = Buffer.concat([MAGIC, manifestLength, manifest, ...contents]);
const compressed = gzipSync(pack, { level: 9, mtime: 0 });

await writeFile(outputPath, compressed);
console.log(
  JSON.stringify(
    {
      sourceDirectory,
      outputPath,
      llvmCommit: LLVM_COMMIT,
      fileCount: sourceFiles.length,
      unpackedBytes: pack.length,
      packedBytes: compressed.length,
    },
    null,
    2,
  ),
);

async function collectFiles(directory) {
  const collected = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collected.push(...(await collectFiles(path)));
    else if (entry.isFile()) collected.push(path);
  }
  return collected;
}
