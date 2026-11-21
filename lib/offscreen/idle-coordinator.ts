interface OffscreenIdleCoordinatorOptions {
  graceMs: number;
  debounceMs: number;
  backendActive(): boolean;
  signalIdle(): void;
}

export class OffscreenIdleCoordinator {
  private readonly ports = new Set<unknown>();
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private waitingForBackendTeardown = false;

  constructor(private readonly options: OffscreenIdleCoordinatorOptions) {
    this.scheduleGrace();
  }

  connect(port: unknown): void {
    this.ports.add(port);
    this.waitingForBackendTeardown = false;
    this.cancelTimers();
  }

  disconnect(port: unknown): void {
    if (!this.ports.delete(port) || this.ports.size > 0) return;
    if (this.options.backendActive()) {
      this.waitingForBackendTeardown = true;
      this.cancelTimers();
    } else {
      this.waitingForBackendTeardown = false;
      this.scheduleGrace();
    }
  }

  backendStateChanged(): void {
    if (this.ports.size > 0) {
      this.cancelTimers();
      return;
    }
    if (this.options.backendActive()) {
      this.cancelTimers();
      return;
    }
    if (this.waitingForBackendTeardown) {
      this.waitingForBackendTeardown = false;
      this.scheduleDebounce();
    } else if (!this.graceTimer && !this.debounceTimer) {
      this.scheduleGrace();
    }
  }

  get isTrulyIdle(): boolean {
    return this.ports.size === 0 && !this.options.backendActive();
  }

  private scheduleGrace(): void {
    this.cancelTimers();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      this.signalIfIdle();
    }, this.options.graceMs);
  }

  private scheduleDebounce(): void {
    this.cancelTimers();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.signalIfIdle();
    }, this.options.debounceMs);
  }

  private signalIfIdle(): void {
    if (this.isTrulyIdle) this.options.signalIdle();
  }

  private cancelTimers(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.graceTimer = undefined;
    this.debounceTimer = undefined;
  }
}
