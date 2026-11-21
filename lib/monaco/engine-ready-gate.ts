import type { EngineStatusState } from '../../utils/protocol';

export class EngineReadyGate {
  private unlocked = false;

  reset(): void {
    this.unlocked = false;
  }

  acceptDiagnostics(uriVersion: number, documentVersion: number): boolean {
    if (uriVersion < documentVersion) return false;
    this.unlocked = true;
    return true;
  }

  canRender(state: EngineStatusState): boolean {
    return state !== 'ready' || this.unlocked;
  }
}

export function engineActivationChanged<T>(
  activeModel: T | undefined,
  activeLanguage: string | undefined,
  nextModel: T,
  nextLanguage: string,
): boolean {
  return activeModel !== nextModel || activeLanguage !== nextLanguage;
}
