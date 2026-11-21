import type { OffscreenIdleProbeResponse } from '../../utils/protocol';

interface OffscreenDocumentControllerOptions {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  probeIdle(): Promise<OffscreenIdleProbeResponse | undefined>;
}

export class OffscreenDocumentController {
  private creating: Promise<boolean> | undefined;

  constructor(private readonly options: OffscreenDocumentControllerOptions) {}

  async ensure(): Promise<boolean> {
    if (await this.options.hasDocument()) return false;
    if (this.creating) return this.creating;

    this.creating = this.options
      .createDocument()
      .then(() => true)
      .finally(() => {
        this.creating = undefined;
      });
    return this.creating;
  }

  async closeIfStillIdle(): Promise<boolean> {
    const current = await this.options.probeIdle();
    if (!current?.idle || !(await this.options.hasDocument())) return false;
    await this.options.closeDocument();
    return true;
  }
}
