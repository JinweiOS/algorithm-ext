import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  actionsForStatus,
  findLeetCodeStatusMount,
  LspStatusIndicator,
  type StatusMount,
} from '../lib/monaco/lsp-status-indicator';

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly classNames = new Set<string>();
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  queryResults: FakeElement[] = [];
  parent: FakeElement | undefined;
  owner: FakeDocument | undefined;
  disabled = false;
  type = '';
  title = '';
  private ownText = '';

  constructor(readonly tagName = 'div') {}

  get textContent(): string {
    return this.ownText || this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  appendChild(child: FakeElement): FakeElement {
    this.ownText = '';
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  get childNodes(): FakeElement[] {
    return this.children;
  }

  get classList(): Pick<DOMTokenList, 'contains'> {
    return { contains: (name) => this.classNames.has(name) };
  }

  get nextSibling(): FakeElement | null {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return this.parent.children[index + 1] ?? null;
  }

  get parentElement(): FakeElement | null {
    return this.parent ?? null;
  }

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    child.remove();
    child.parent = this;
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }

  querySelectorAll(selector?: string): FakeElement[] {
    if (this.queryResults.length > 0) return this.queryResults;
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (
        selector === '[role="menuitem"]' &&
        child.attributes.get('role') === 'menuitem'
      ) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, key = ''): FakeEvent {
    const event = new FakeEvent(type, this, key);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  contains(node: FakeElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  focus(): void {
    this.owner?.setFocused(this);
    this.dispatch('focus');
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 20,
      y: 700,
      left: 20,
      right: 140,
      top: 700,
      bottom: 720,
      width: this.attributes.get('role') === 'menu' ? 200 : 120,
      height: this.attributes.get('role') === 'menu' ? 100 : 20,
      toJSON: () => ({}),
    } as DOMRect;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
}

class FakeEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    readonly currentTarget: FakeElement,
    readonly key = '',
    readonly target: FakeElement = currentTarget,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeDocument {
  readonly body = this.createElement('body');
  readonly defaultView = { innerWidth: 1024, innerHeight: 768 };
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  activeElement: FakeElement | undefined;

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName);
    element.owner = this;
    return element;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener),
    );
  }

  dispatchPointer(target: FakeElement): void {
    const event = new FakeEvent('pointerdown', target);
    for (const listener of this.listeners.get('pointerdown') ?? []) listener(event);
  }

  setFocused(element: FakeElement): void {
    if (this.activeElement && this.activeElement !== element) {
      this.activeElement.dispatch('blur');
    }
    this.activeElement = element;
  }
}

class FakeObserver {
  observed: FakeElement | undefined;
  disconnected = false;

  constructor(private readonly callback: MutationCallback) {}

  observe(target: Node): void {
    this.observed = target as unknown as FakeElement;
    this.disconnected = false;
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed = undefined;
  }

  trigger(): void {
    this.callback([], this as unknown as MutationObserver);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LSP status indicator', () => {
  it('renders beside Saved with LeetCode typography and no floating-pill chrome', () => {
    const editor = new FakeElement();
    const mount = createMount();
    const indicator = createIndicator(mount);

    indicator.render(asElement(editor), 'cpp', 'starting');
    const element = mount.target.children[1];
    expect(mount.target.children[0]).toBe(mount.anchor);
    expect(element.textContent).toBe('英格科技速写 · C++ · 启动中…');
    expect(element.tagName).toBe('button');
    expect(element.attributes.get('aria-haspopup')).toBe('menu');
    expect(element.attributes.get('aria-expanded')).toBe('false');
    expect(element.children[0].attributes.get('role')).toBe('status');
    expect(element.children[0].attributes.get('aria-live')).toBe('polite');
    expect(element.style.position).toBeUndefined();
    expect(element.style.background).toBe('transparent');
    expect(element.style.border).toBe('0');
    expect(element.style.fontFamily).toBeUndefined();

    indicator.render(
      asElement(editor),
      'cpp',
      'unavailable',
      'Engine restart cooldown is active',
    );
    expect(element.textContent).toBe('英格科技速写 · C++ · 不可用');
    expect(element.title).toBe('Engine restart cooldown is active');
  });

  it('maps lifecycle states to the approved language actions', () => {
    expect(actionsForStatus('cpp', 'ready')).toEqual([
      { action: 'restart', label: '重启 C++ 语言服务' },
      { action: 'stop', label: '停止 C++ 语言服务' },
    ]);
    expect(actionsForStatus('python3', 'starting')).toEqual([
      { action: 'stop', label: '停止 Python 语言服务' },
    ]);
    expect(actionsForStatus('python3', 'stopped')).toEqual([
      { action: 'start', label: '启动 Python 语言服务' },
    ]);
    expect(actionsForStatus('cpp', 'off')).toEqual([]);
  });

  it('offers engine controls for JavaScript and TypeScript', () => {
    const document = new FakeDocument();
    const mount = createMount();
    const indicator = new LspStatusIndicator(
      asDocument(document),
      () => asMount(mount),
      () => asObserver(new FakeObserver(() => {})),
    );

    expect(actionsForStatus('javascript', 'ready')).toEqual([
      { action: 'restart', label: '重启 JavaScript 语言服务' },
      { action: 'stop', label: '停止 JavaScript 语言服务' },
    ]);
    expect(actionsForStatus('typescript', 'unavailable')).toEqual([
      { action: 'restart', label: '重启 TypeScript 语言服务' },
      { action: 'stop', label: '停止 TypeScript 语言服务' },
    ]);

    indicator.render(asElement(new FakeElement()), 'typescript', 'ready');
    const button = mount.target.children[1];
    expect(button.textContent).toBe('英格科技速写 · TypeScript · 就绪');

    button.dispatch('click');
    const menu = document.body.children[0];
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(menu.textContent).toContain('重启 TypeScript 语言服务');
    expect(menu.textContent).toContain('操作将作用于所有打开的 LeetCode 标签页');
    expect(menu.textContent).toContain('Power by');
    expect(menu.textContent).toContain('英格科技');

    indicator.clear();
    expect(document.body.children).toHaveLength(0);
    expect(mount.target.children).toHaveLength(1);
  });

  it('opens an accessible keyboard menu, runs one action, and cleans up outside listeners', async () => {
    const document = new FakeDocument();
    const mount = createMount();
    const actions: string[] = [];
    const indicator = new LspStatusIndicator(
      asDocument(document),
      () => asMount(mount),
      () => asObserver(new FakeObserver(() => {})),
      async (language, action) => {
        actions.push(`${language}:${action}`);
      },
    );

    indicator.render(asElement(new FakeElement()), 'cpp', 'ready');
    const button = mount.target.children[1];
    const openEvent = button.dispatch('keydown', 'Enter');
    expect(openEvent.defaultPrevented).toBe(true);
    expect(button.attributes.get('aria-expanded')).toBe('true');
    expect(document.body.children).toHaveLength(1);
    const menu = document.body.children[0];
    expect(menu.attributes.get('role')).toBe('menu');
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items.map((item) => item.textContent)).toEqual([
      '重启 C++ 语言服务',
      '停止 C++ 语言服务',
    ]);
    expect(menu.textContent).toContain('Power by');
    expect(menu.textContent).toContain('英格科技');
    expect(document.activeElement).toBe(items[0]);

    items[0].dispatch('keydown', 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    items[1].dispatch('keydown', 'Escape');
    expect(document.body.children).toHaveLength(0);
    expect(button.attributes.get('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);

    button.dispatch('click');
    document.body.children[0]
      .querySelectorAll('[role="menuitem"]')[0]
      .dispatch('click');
    await vi.waitFor(() => expect(actions).toEqual(['cpp:restart']));
    expect(button.disabled).toBe(false);
    expect(document.listeners.get('pointerdown')).toEqual([]);
  });

  it('closes outside and exposes a bounded action error without changing lifecycle text', async () => {
    const document = new FakeDocument();
    const mount = createMount();
    const indicator = new LspStatusIndicator(
      asDocument(document),
      () => asMount(mount),
      () => asObserver(new FakeObserver(() => {})),
      async () => {
        throw new Error('Engine control failed');
      },
    );

    indicator.render(asElement(new FakeElement()), 'python3', 'stopped');
    const button = mount.target.children[1];
    button.dispatch('click');
    document.dispatchPointer(new FakeElement());
    expect(document.body.children).toHaveLength(0);

    button.dispatch('click');
    document.body.children[0]
      .querySelectorAll('[role="menuitem"]')[0]
      .dispatch('click');
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(button.textContent).toBe('英格科技速写 · Python · 已停止');
    expect(button.attributes.get('aria-description')).toBe(
      'Engine control failed',
    );
  });

  it('moves with the active editor and cleanup removes stale UI', () => {
    const firstEditor = new FakeElement();
    const secondEditor = new FakeElement();
    const firstMount = createMount();
    const secondMount = createMount();
    const document = new FakeDocument();
    const indicator = new LspStatusIndicator(
      asDocument(document),
      (editor) =>
        editor === asElement(firstEditor)
          ? asMount(firstMount)
          : asMount(secondMount),
      () => asObserver(new FakeObserver(() => {})),
    );

    indicator.render(asElement(firstEditor), 'python3', 'restarting');
    expect(firstMount.target.children).toHaveLength(2);

    indicator.render(asElement(secondEditor), 'python3', 'restarting');
    expect(firstMount.target.children).toHaveLength(1);
    expect(secondMount.target.children).toHaveLength(2);

    indicator.clear();
    expect(secondMount.target.children).toHaveLength(1);
  });

  it('keeps ready visible until a lifecycle or cleanup transition', async () => {
    vi.useFakeTimers();
    const editor = new FakeElement();
    const mount = createMount();
    const indicator = createIndicator(mount);

    indicator.render(asElement(editor), 'cpp', 'ready');
    expect(mount.target.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(mount.target.children[1].textContent).toBe(
      '英格科技速写 · C++ · 就绪',
    );
    indicator.clear();
    expect(mount.target.children).toHaveLength(1);
  });

  it('anchors to the Saved node and ignores a competing caption cluster', () => {
    const editor = new FakeElement();
    const shell = new FakeElement();
    shell.appendChild(editor);
    const statusRow = elementWithClasses('justify-between');
    const decoy = elementWithClasses('text-caption', 'items-center', 'gap-2');
    decoy.appendChild(elementWithText('Auto'));
    const saved = elementWithClasses('text-caption', 'items-center', 'gap-2');
    const savedAnchor = elementWithText('Saved');
    saved.appendChild(savedAnchor);
    statusRow.appendChild(decoy);
    statusRow.appendChild(saved);
    shell.appendChild(statusRow);
    shell.queryResults = [decoy, saved];

    const mount = findLeetCodeStatusMount(asElement(editor));
    expect(mount?.target).toBe(asElement(saved));
    expect(mount?.anchor).toBe(asNode(savedAnchor));
    expect(mount?.root).toBe(asElement(shell));
    expect(findLeetCodeStatusMount(asElement(new FakeElement()))).toBeUndefined();
  });

  it.each(['已存储', '已自动保存', '存储中...', '已从本地恢复'])(
    'anchors to the Chinese save label %s on leetcode.cn',
    (label) => {
      const editor = new FakeElement();
      const shell = new FakeElement();
      shell.appendChild(editor);
      const statusRow = elementWithClasses('justify-between');
      const saved = elementWithClasses('text-caption', 'items-center', 'gap-2');
      const savedAnchor = elementWithText(label);
      saved.appendChild(savedAnchor);
      statusRow.appendChild(saved);
      shell.appendChild(statusRow);
      shell.queryResults = [saved];

      const mount = findLeetCodeStatusMount(asElement(editor));
      expect(mount?.target).toBe(asElement(saved));
      expect(mount?.anchor).toBe(asNode(savedAnchor));
      expect(mount?.root).toBe(asElement(shell));
    },
  );

  it('reattaches a persistent state when LeetCode replaces the status cluster', () => {
    const editor = new FakeElement();
    const firstMount = createMount();
    const secondMount = createMount();
    let currentMount = firstMount;
    let observer: FakeObserver | undefined;
    const document = new FakeDocument();
    const indicator = new LspStatusIndicator(
      asDocument(document),
      () => asMount(currentMount),
      (callback) => {
        observer = new FakeObserver(callback);
        return asObserver(observer);
      },
    );

    indicator.render(asElement(editor), 'cpp', 'unavailable');
    const element = firstMount.target.children[1];
    element.remove();
    currentMount = secondMount;
    observer?.trigger();

    expect(secondMount.target.children[1]).toBe(element);
    expect(element.textContent).toBe('英格科技速写 · C++ · 不可用');
    indicator.clear();
    expect(observer?.disconnected).toBe(true);
  });

  it('shows a neutral one-time review card only while the engine is ready', () => {
    const document = new FakeDocument();
    const mount = createMount();
    const indicator = new LspStatusIndicator(
      asDocument(document),
      () => asMount(mount),
      () => asObserver(new FakeObserver(() => {})),
    );

    indicator.render(asElement(new FakeElement()), 'cpp', 'starting');
    indicator.showReviewPrompt('https://chrome.google.com/example/reviews');
    expect(document.body.children).toHaveLength(0);

    indicator.render(asElement(new FakeElement()), 'cpp', 'ready');
    indicator.showReviewPrompt('https://chrome.google.com/example/reviews');
    expect(document.body.children).toHaveLength(1);
    const prompt = document.body.children[0];
    expect(prompt.textContent).toContain('喜欢速写吗？');
    expect(prompt.textContent).toContain('去评价');
    const actions = prompt.children[3];
    expect(actions.children[0].attributes.get('href')).toBe(
      'https://chrome.google.com/example/reviews',
    );

    actions.children[1].dispatch('click');
    expect(document.body.children).toHaveLength(0);
  });
});

function createIndicator(
  mount = createMount(),
): LspStatusIndicator {
  const document = new FakeDocument();
  return new LspStatusIndicator(
    asDocument(document),
    () => asMount(mount),
    () => asObserver(new FakeObserver(() => {})),
  );
}

function createMount(): {
  target: FakeElement;
  anchor: FakeElement;
  root: FakeElement;
} {
  const target = new FakeElement();
  const anchor = elementWithText('Saved');
  const root = new FakeElement();
  target.appendChild(anchor);
  root.appendChild(target);
  return { target, anchor, root };
}

function elementWithClasses(...classNames: string[]): FakeElement {
  const element = new FakeElement();
  for (const className of classNames) element.classNames.add(className);
  return element;
}

function elementWithText(text: string): FakeElement {
  const element = new FakeElement();
  element.textContent = text;
  return element;
}

function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

function asNode(element: FakeElement): ChildNode {
  return element as unknown as ChildNode;
}

function asMount(mount: ReturnType<typeof createMount>): StatusMount {
  return {
    target: asElement(mount.target),
    anchor: asNode(mount.anchor),
    root: asElement(mount.root),
  };
}

function asObserver(observer: FakeObserver): MutationObserver {
  return observer as unknown as MutationObserver;
}

function asDocument(document: FakeDocument): Document {
  return document as unknown as Document;
}
