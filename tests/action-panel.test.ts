import { afterEach, describe, expect, it, vi } from 'vitest';

import { injectActionPanel, PANEL_ROOT_ID } from '../lib/panel/action-panel';

type Listener = (event: FakePointerEvent | FakeKeyEvent) => void;

class FakePointerEvent {
  defaultPrevented = false;
  constructor(
    readonly clientX: number,
    readonly clientY: number,
    readonly pointerId = 1,
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {}
}

class FakeKeyEvent {
  constructor(readonly key: string) {}
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  id = '';
  type = '';
  textContent = '';
  offsetWidth = 320;
  offsetHeight = 400;
  removed = false;
  readonly attributes = new Map<string, string>();

  constructor(readonly tagName = 'div') {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  }

  dispatch(type: string, event: FakePointerEvent | FakeKeyEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  remove(): void {
    this.removed = true;
  }

  setPointerCapture(): void {}

  getBoundingClientRect(): { left: number; top: number } {
    return { left: 100, top: 24 };
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  readonly documentElement = new FakeElement('html');
  readonly keyListeners: Array<[Listener, boolean]> = [];

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  getElementById(id: string): FakeElement | undefined {
    return this.body.children.find((child) => child.id === id && !child.removed);
  }

  addEventListener(_type: string, listener: Listener, capture = false): void {
    this.keyListeners.push([listener, capture]);
  }

  removeEventListener(_type: string, listener: Listener): void {
    const index = this.keyListeners.findIndex(([entry]) => entry === listener);
    if (index >= 0) this.keyListeners.splice(index, 1);
  }

  dispatchKey(event: FakeKeyEvent): void {
    for (const [listener] of [...this.keyListeners]) listener(event);
  }
}

const fakeWindow = {
  innerWidth: 1280,
  innerHeight: 800,
  listeners: new Map<string, Array<(event: unknown) => void>>(),
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  },
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== listener),
    );
  },
  dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  },
};
let fakeDocument: FakeDocument;

function setup(): void {
  fakeDocument = new FakeDocument();
  fakeWindow.listeners.clear();
  vi.stubGlobal('document', fakeDocument);
  vi.stubGlobal('window', fakeWindow);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('injectActionPanel', () => {
  it('injects a floating panel that frames the extension page', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');

    const panel = fakeDocument.getElementById(PANEL_ROOT_ID);
    expect(panel).toBeDefined();
    expect(panel!.style.position).toBe('fixed');
    expect(panel!.style.borderRadius).toBe('16px');
    expect(panel!.style.border).toBe('0');
    expect(panel!.children.map((child) => child.tagName)).toEqual([
      'iframe',
      'div',
      'button',
      'button',
    ]);
    const frame = panel!.children[0] as FakeElement & { src?: string };
    expect(frame.src).toBe('chrome-extension://abc/panel.html#framed');
    // The frame must reach the clip: a radius of its own was what left a pale
    // rim around the corners on a blank page.
    expect(frame.style.borderRadius).toBe('0');
  });

  it('toggles closed when the icon is clicked again', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    injectActionPanel('chrome-extension://abc/panel.html');
    expect(fakeDocument.getElementById(PANEL_ROOT_ID)).toBeUndefined();
  });

  it('closes via the close button and unhooks the Escape listener', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    expect(fakeDocument.keyListeners).toHaveLength(1);

    const panel = fakeDocument.getElementById(PANEL_ROOT_ID)!;
    const closeButton = panel.children[2];
    closeButton.dispatch('click', new FakePointerEvent(0, 0));

    expect(panel.removed).toBe(true);
    expect(fakeDocument.keyListeners).toHaveLength(0);
  });

  it('closes on Escape', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    const panel = fakeDocument.getElementById(PANEL_ROOT_ID)!;

    fakeDocument.dispatchKey(new FakeKeyEvent('Escape'));
    expect(panel.removed).toBe(true);
    expect(fakeDocument.keyListeners).toHaveLength(0);
  });

  it('fades the grip in only after the card has unfolded', () => {
    vi.useFakeTimers();
    try {
      setup();
      injectActionPanel('chrome-extension://abc/panel.html');
      const grip = fakeDocument.getElementById(PANEL_ROOT_ID)!.children[3];
      expect(grip.style.opacity).toBe('0');
      vi.advanceTimersByTime(699);
      expect(grip.style.opacity).toBe('0');
      vi.advanceTimersByTime(1);
      expect(grip.style.opacity).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('parks the grip on the right end of the credit line', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    const grip = fakeDocument.getElementById(PANEL_ROOT_ID)!.children[3];

    // Right-anchored rather than centred: the credit line ends up sharing the
    // row with the grip instead of the grip owning a band of empty card.
    expect(grip.style.left).toBeUndefined();
    expect(grip.style.right).toBe('14px');
    expect(grip.style.bottom).toBe('15px');

    // Hover scales in place — the old centring translate would have shifted the
    // grip by half its width the moment the pointer arrived.
    grip.dispatch('pointerenter', new FakePointerEvent(0, 0));
    expect(grip.style.transform).toBe('scale(1.1)');
    grip.dispatch('pointerleave', new FakePointerEvent(0, 0));
    expect(grip.style.transform).toBe('scale(1)');
  });

  it('keeps the card inert until the grip arms dragging', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    const panel = fakeDocument.getElementById(PANEL_ROOT_ID)!;
    const dragLayer = panel.children[1];
    const grip = panel.children[3];

    expect(dragLayer.style.pointerEvents).toBe('none');
    expect(grip.attributes.get('aria-pressed')).toBe('false');

    // A press on the card does nothing while the handle is sheathed.
    dragLayer.dispatch('pointerdown', new FakePointerEvent(150, 50));
    dragLayer.dispatch('pointermove', new FakePointerEvent(5000, 5000));
    expect(panel.style.left).toBe('938px'); // untouched: 1280 - 318 - 24
    expect(dragLayer.style.cursor).toBe('default');

    grip.dispatch('click', new FakePointerEvent(0, 0));
    expect(dragLayer.style.pointerEvents).toBe('auto');
    expect(grip.attributes.get('aria-pressed')).toBe('true');

    grip.dispatch('click', new FakePointerEvent(0, 0));
    expect(dragLayer.style.pointerEvents).toBe('none');
    expect(grip.attributes.get('aria-pressed')).toBe('false');
  });

  it('drags within the viewport bounds once armed', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    const panel = fakeDocument.getElementById(PANEL_ROOT_ID)!;
    const dragLayer = panel.children[1];
    panel.children[3].dispatch('click', new FakePointerEvent(0, 0));

    dragLayer.dispatch('pointerdown', new FakePointerEvent(150, 50));
    // rect: left 100, top 24 → grab offsets (50, 26)
    dragLayer.dispatch('pointermove', new FakePointerEvent(5000, 5000));
    expect(panel.style.left).toBe('960px'); // 1280 - 320
    expect(panel.style.top).toBe('400px'); // 800 - 400

    dragLayer.dispatch('pointermove', new FakePointerEvent(-500, -500));
    expect(panel.style.left).toBe('0px');
    expect(panel.style.top).toBe('0px');

    dragLayer.dispatch('pointerup', new FakePointerEvent(0, 0));
    expect(dragLayer.style.cursor).toBe('grab');
  });

  it('sheathes the drag handle on Escape before closing', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    const panel = fakeDocument.getElementById(PANEL_ROOT_ID)!;
    const grip = panel.children[3];
    grip.dispatch('click', new FakePointerEvent(0, 0));

    fakeDocument.dispatchKey(new FakeKeyEvent('Escape'));
    expect(panel.removed).toBe(false);
    expect(panel.children[1].style.pointerEvents).toBe('none');
    expect(fakeDocument.keyListeners).toHaveLength(1);

    fakeDocument.dispatchKey(new FakeKeyEvent('Escape'));
    expect(panel.removed).toBe(true);
  });

  it('resizes to the height reported by the framed panel page', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    const panel = fakeDocument.getElementById(PANEL_ROOT_ID)!;
    expect(panel.style.height).toBe('84px');

    fakeWindow.dispatch('message', {
      data: { type: 'suxie-panel-height', height: 354.25 },
    });
    expect(panel.style.height).toBe('355px');

    // out-of-range and malformed messages are ignored
    fakeWindow.dispatch('message', {
      data: { type: 'suxie-panel-height', height: 100000 },
    });
    expect(panel.style.height).toBe('776px'); // 800 - 24
    fakeWindow.dispatch('message', { data: { type: 'other', height: 50 } });
    fakeWindow.dispatch('message', { data: 'not-an-object' });
    expect(panel.style.height).toBe('776px');

    // the floor keeps the card from collapsing below its header
    fakeWindow.dispatch('message', {
      data: { type: 'suxie-panel-height', height: 12 },
    });
    expect(panel.style.height).toBe('84px');
  });

  it('unhooks the height listener when the panel closes', () => {
    setup();
    injectActionPanel('chrome-extension://abc/panel.html');
    expect(fakeWindow.listeners.get('message')).toHaveLength(1);

    fakeDocument.dispatchKey(new FakeKeyEvent('Escape'));

    expect(fakeWindow.listeners.get('message')).toHaveLength(0);
    const panel = fakeDocument.getElementById(PANEL_ROOT_ID);
    expect(panel).toBeUndefined();
  });
});
