const HEADER_TERMINATOR = new Uint8Array([13, 10, 13, 10]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_SEPARATOR = encoder.encode('\r\n');

export type LspMessage = Record<string, unknown>;

export class LspMessageParser {
  private headerBytes: number[] = [];
  private headerTerminatorOffset = 0;
  private body: Uint8Array | undefined;
  private bodyOffset = 0;

  push(chunk: Uint8Array): LspMessage[] {
    const messages: LspMessage[] = [];
    for (const byte of chunk) {
      const message = this.pushByte(byte);
      if (message) messages.push(message);
    }
    return messages;
  }

  pushByte(byte: number): LspMessage | undefined {
    if (!this.body) {
      this.pushHeaderByte(byte);
      if (this.headerTerminatorOffset === HEADER_TERMINATOR.byteLength) {
        this.beginBody();
      }
      return undefined;
    }

    this.body[this.bodyOffset++] = byte;
    if (this.bodyOffset === this.body.byteLength) return this.finishBody();
    return undefined;
  }

  private pushHeaderByte(byte: number): void {
    this.headerBytes.push(byte);
    if (byte === HEADER_TERMINATOR[this.headerTerminatorOffset]) {
      this.headerTerminatorOffset += 1;
    } else {
      this.headerTerminatorOffset = byte === HEADER_TERMINATOR[0] ? 1 : 0;
    }
  }

  private beginBody(): void {
    const header = decoder.decode(new Uint8Array(this.headerBytes));
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)\r\n/i.exec(header);
    this.headerBytes = [];
    this.headerTerminatorOffset = 0;
    if (!match) throw new Error('Missing LSP Content-Length header');

    const contentLength = Number(match[1]);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error('Invalid LSP Content-Length header');
    }
    this.body = new Uint8Array(contentLength);
    this.bodyOffset = 0;
  }

  private finishBody(): LspMessage {
    const body = this.body;
    this.body = undefined;
    this.bodyOffset = 0;
    return JSON.parse(decoder.decode(body)) as LspMessage;
  }
}

export class LspStdinQueue {
  private chunks: Uint8Array[] = [];
  private chunkIndex = 0;
  private byteOffset = 0;
  private boundaryPending = false;

  enqueue(message: LspMessage): void {
    this.chunks.push(...encodeLspMessageChunks(message));
  }

  read(): number | null {
    if (this.boundaryPending) {
      this.boundaryPending = false;
      this.compactConsumedChunks();
      return null;
    }

    while (this.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex];
      if (this.byteOffset < chunk.byteLength) {
        const byte = chunk[this.byteOffset++];
        if (this.byteOffset === chunk.byteLength) {
          this.chunkIndex += 1;
          this.byteOffset = 0;
          this.boundaryPending = true;
        }
        return byte;
      }
      this.chunkIndex += 1;
      this.byteOffset = 0;
    }

    this.compactConsumedChunks();
    return null;
  }

  get hasData(): boolean {
    if (this.boundaryPending) return true;
    if (this.chunkIndex >= this.chunks.length) return false;
    if (this.byteOffset < this.chunks[this.chunkIndex].byteLength) return true;
    return this.chunkIndex + 1 < this.chunks.length;
  }

  private compactConsumedChunks(): void {
    if (this.chunkIndex === this.chunks.length) {
      this.chunks = [];
      this.chunkIndex = 0;
    } else if (
      this.chunkIndex >= 32 &&
      this.chunkIndex * 2 >= this.chunks.length
    ) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
  }
}

export function encodeLspMessage(message: LspMessage): Uint8Array {
  const chunks = encodeLspMessageChunks(message);
  const framed = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    framed.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return framed;
}

function encodeLspMessageChunks(message: LspMessage): Uint8Array[] {
  const body = JSON.stringify(message).replace(/[\u007F-\uFFFF]/g, (char) =>
    `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0')}`,
  );
  const bodyBytes = encoder.encode(body);
  const headerBytes = encoder.encode(
    `Content-Length: ${bodyBytes.byteLength}\r\n`,
  );
  return [headerBytes, HEADER_SEPARATOR, bodyBytes];
}
