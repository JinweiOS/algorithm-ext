import { describe, expect, it } from 'vitest';

import {
  engineActivationChanged,
  EngineReadyGate,
} from '../lib/monaco/engine-ready-gate';

describe('engine ready gate', () => {
  it('holds ready through stale diagnostics and unlocks on the current document version', () => {
    const gate = new EngineReadyGate();

    expect(gate.canRender('ready')).toBe(false);
    expect(gate.acceptDiagnostics(1, 2)).toBe(false);
    expect(gate.canRender('ready')).toBe(false);

    expect(gate.acceptDiagnostics(2, 2)).toBe(true);
    expect(gate.canRender('ready')).toBe(true);
  });

  it('locks ready again for a new activation or restart without hiding non-ready states', () => {
    const gate = new EngineReadyGate();
    gate.acceptDiagnostics(1, 1);
    expect(gate.canRender('ready')).toBe(true);

    gate.reset();

    expect(gate.canRender('ready')).toBe(false);
    expect(gate.canRender('starting')).toBe(true);
    expect(gate.canRender('restarting')).toBe(true);
    expect(gate.canRender('unavailable')).toBe(true);
    expect(gate.canRender('stopped')).toBe(true);
    expect(gate.canRender('off')).toBe(true);
  });

  it('treats model swaps and same-model language switches as new activations', () => {
    const firstModel = {};
    const secondModel = {};

    expect(
      engineActivationChanged(firstModel, 'cpp', firstModel, 'cpp'),
    ).toBe(false);
    expect(
      engineActivationChanged(firstModel, 'cpp', secondModel, 'cpp'),
    ).toBe(true);
    expect(
      engineActivationChanged(firstModel, 'cpp', firstModel, 'python3'),
    ).toBe(true);
  });
});
