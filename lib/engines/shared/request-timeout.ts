export class EngineRequestTimeoutError extends Error {
  constructor(engine: string, method: string) {
    super(`${engine} ${method} timed out`);
    this.name = 'EngineRequestTimeoutError';
  }
}

export function withEngineRequestTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  engine: string,
  method: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new EngineRequestTimeoutError(engine, method));
    }, timeoutMs);

    void request.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function isEngineRequestTimeout(
  error: unknown,
): error is EngineRequestTimeoutError {
  return error instanceof EngineRequestTimeoutError;
}
