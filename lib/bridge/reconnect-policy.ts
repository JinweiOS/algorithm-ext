export class BridgeReconnectPolicy {
  private automaticAttempts = 0;

  constructor(private readonly maximumAutomaticAttempts: number) {}

  beginConnection(kind: 'automatic' | 'demand'): number | undefined {
    if (kind === 'demand') return this.automaticAttempts;
    if (!this.canAutomaticallyReconnect) return undefined;
    this.automaticAttempts += 1;
    return this.automaticAttempts;
  }

  get canAutomaticallyReconnect(): boolean {
    return this.automaticAttempts < this.maximumAutomaticAttempts;
  }

  recordResponse(): void {
    this.automaticAttempts = 0;
  }

  get attemptCount(): number {
    return this.automaticAttempts;
  }
}
