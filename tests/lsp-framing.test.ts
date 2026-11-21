import { describe, expect, it, vi } from 'vitest';

import {
  encodeLspMessage,
  LspMessageParser,
  LspStdinQueue,
  type LspMessage,
} from '../lib/engines/cpp/lsp-framing';

describe('LSP message framing', () => {
  it('parses multiple messages split across arbitrary boundaries', () => {
    const messages: LspMessage[] = [
      { jsonrpc: '2.0', id: 1, result: { label: 'vector' } },
      { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: [] },
    ];
    const bytes = concatenate(messages.map(encodeLspMessage));
    const parser = new LspMessageParser();
    const parsed: LspMessage[] = [];

    for (let offset = 0, chunkSize = 1; offset < bytes.byteLength; chunkSize += 1) {
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      parsed.push(...parser.push(bytes.subarray(offset, end)));
      offset = end;
    }

    expect(parsed).toEqual(messages);
  });

  it('round-trips non-ASCII and a message larger than one megabyte', () => {
    const message = {
      jsonrpc: '2.0',
      id: 2,
      result: { documentation: `λ café ${'x'.repeat(1024 * 1024)}` },
    };
    const queue = new LspStdinQueue();
    queue.enqueue(message);
    const bytes: number[] = [];
    while (queue.hasData) {
      const byte = queue.read();
      if (byte !== null) bytes.push(byte);
    }

    const parser = new LspMessageParser();
    const parse = vi.spyOn(JSON, 'parse');
    expect(parser.push(Uint8Array.from(bytes))).toEqual([message]);
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
    expect(queue.hasData).toBe(false);
  });

  it('preserves Emscripten read boundaries between the header, separator, and body', () => {
    const message = { jsonrpc: '2.0', id: 7, method: 'initialize' };
    const queue = new LspStdinQueue();
    const decoder = new TextDecoder();
    const groups: string[] = [];
    let group: number[] = [];
    queue.enqueue(message);

    while (queue.hasData) {
      const byte = queue.read();
      if (byte === null) {
        groups.push(decoder.decode(Uint8Array.from(group)));
        group = [];
      } else {
        group.push(byte);
      }
    }
    if (group.length > 0) groups.push(decoder.decode(Uint8Array.from(group)));

    expect(groups).toEqual([
      `Content-Length: ${JSON.stringify(message).length}\r\n`,
      '\r\n',
      JSON.stringify(message),
    ]);
  });

  it('reports queued input after the current message boundary', () => {
    const queue = new LspStdinQueue();
    const first = { id: 1 };
    queue.enqueue(first);
    queue.enqueue({ id: 2 });

    let firstBytesRead = 0;
    while (firstBytesRead < encodeLspMessage(first).byteLength) {
      if (queue.read() !== null) firstBytesRead += 1;
    }

    expect(queue.hasData).toBe(true);
  });
});

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
