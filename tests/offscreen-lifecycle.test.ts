import { afterEach, describe, expect, it, vi } from 'vitest';

import { OffscreenDocumentController } from '../lib/offscreen/document-controller';
import { OffscreenIdleCoordinator } from '../lib/offscreen/idle-coordinator';

afterEach(() => {
  vi.useRealTimers();
});

describe('offscreen idle coordinator', () => {
  it('signals only after all ports are gone and the last backend tears down', async () => {
    vi.useFakeTimers();
    let backendActive = false;
    const signalIdle = vi.fn();
    const coordinator = new OffscreenIdleCoordinator({
      graceMs: 300_000,
      debounceMs: 100,
      backendActive: () => backendActive,
      signalIdle,
    });
    const port = {};

    coordinator.connect(port);
    backendActive = true;
    coordinator.backendStateChanged();
    coordinator.disconnect(port);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(signalIdle).not.toHaveBeenCalled();

    backendActive = false;
    coordinator.backendStateChanged();
    await vi.advanceTimersByTimeAsync(99);
    expect(signalIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signalIdle).toHaveBeenCalledTimes(1);
  });

  it('uses the full grace when no engine boots and cancels a stale debounce', async () => {
    vi.useFakeTimers();
    const signalIdle = vi.fn();
    const coordinator = new OffscreenIdleCoordinator({
      graceMs: 300_000,
      debounceMs: 100,
      backendActive: () => false,
      signalIdle,
    });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(signalIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signalIdle).toHaveBeenCalledTimes(1);

    const port = {};
    coordinator.connect(port);
    coordinator.disconnect(port);
    await vi.advanceTimersByTimeAsync(299_999);
    coordinator.connect({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signalIdle).toHaveBeenCalledTimes(1);
  });
});

describe('background offscreen controller', () => {
  it('fresh-probes the live host and refuses a stale idle signal', async () => {
    const close = vi.fn(async () => {});
    const controller = new OffscreenDocumentController({
      hasDocument: async () => true,
      createDocument: async () => {},
      closeDocument: close,
      probeIdle: async () => ({ idle: false }),
    });

    expect(await controller.closeIfStillIdle()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes a freshly-confirmed idle host and recreates it on next demand', async () => {
    let exists = true;
    const create = vi.fn(async () => {
      exists = true;
    });
    const close = vi.fn(async () => {
      exists = false;
    });
    const controller = new OffscreenDocumentController({
      hasDocument: async () => exists,
      createDocument: create,
      closeDocument: close,
      probeIdle: async () => ({ idle: true }),
    });

    expect(await controller.closeIfStillIdle()).toBe(true);
    expect(exists).toBe(false);
    expect(await controller.ensure()).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(exists).toBe(true);
    expect(await controller.ensure()).toBe(false);
  });
});
