import { describe, expect, it } from 'vitest';

import { CARD_FONT_FAMILY, installCardFont } from '../lib/monaco/card-font';

interface FakeStyle {
  id: string;
  textContent: string | null;
  parent: FakeHead | null;
  remove(): void;
}

interface FakeHead {
  children: FakeStyle[];
  appendChild(node: FakeStyle): void;
}

function createDocument(): { doc: Document; head: FakeHead } {
  const head: FakeHead = {
    children: [],
    appendChild(node) {
      head.children.push(node);
      node.parent = head;
    },
  };

  const doc = {
    head,
    getElementById(id: string) {
      return head.children.find((child) => child.id === id) ?? null;
    },
    createElement() {
      const style: FakeStyle = {
        id: '',
        textContent: '',
        parent: null,
        remove() {
          if (!style.parent) return;
          style.parent.children = style.parent.children.filter((child) => child !== style);
          style.parent = null;
        },
      };
      return style;
    },
  };

  return { doc: doc as unknown as Document, head };
}

describe('card font', () => {
  it('injects one @font-face rule for the packaged woff2', () => {
    const { doc, head } = createDocument();
    installCardFont(doc, 'chrome-extension://abc/fonts/MiSans-VF.woff2');

    expect(head.children).toHaveLength(1);
    const rule = head.children[0].textContent ?? '';
    expect(rule).toContain('@font-face');
    expect(rule).toContain('chrome-extension://abc/fonts/MiSans-VF.woff2');
    expect(rule).toContain('woff2-variations');
    expect(rule).toContain('150 700');
    expect(rule).toContain('font-display: swap');
  });

  it('stays idempotent so two content scripts cannot double-load the face', () => {
    const { doc, head } = createDocument();
    installCardFont(doc, 'chrome-extension://abc/fonts/MiSans-VF.woff2');
    installCardFont(doc, 'chrome-extension://abc/fonts/MiSans-VF.woff2');
    expect(head.children).toHaveLength(1);
  });

  it('removes the rule on dispose', () => {
    const { doc, head } = createDocument();
    const dispose = installCardFont(doc, 'chrome-extension://abc/fonts/MiSans-VF.woff2');
    dispose();
    expect(head.children).toHaveLength(0);
  });

  it('falls back through the platform stack', () => {
    expect(CARD_FONT_FAMILY.startsWith('"MiSans"')).toBe(true);
    expect(CARD_FONT_FAMILY).toContain('sans-serif');
  });

  it('survives a document without a head', () => {
    const empty = { head: null, documentElement: null } as unknown as Document;
    expect(() => installCardFont(empty, 'chrome-extension://abc/font.woff2')).not.toThrow();
  });

  it('mounts before <head> exists, because content scripts start at document_start', () => {
    const listeners = new Map<string, () => void>();
    const documentElement = { children: [] as unknown[] };

    const doc = {
      head: null,
      documentElement: {
        appendChild(node: unknown) {
          documentElement.children.push(node);
        },
      },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', remove() {} }),
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    } as unknown as Document;

    installCardFont(doc, 'chrome-extension://abc/fonts/MiSans-VF.woff2');
    // No head yet: the rule hangs off <html> so the strip's first paint is
    // already styled, and the listener is never needed.
    expect(documentElement.children).toHaveLength(1);
    expect(listeners.size).toBe(0);
  });
});
