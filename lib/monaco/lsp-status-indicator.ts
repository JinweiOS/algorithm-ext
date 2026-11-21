import type {
  EngineLanguageId,
  EngineStatusState,
  LspControlAction,
  StatusLanguageId,
} from '../../utils/protocol';
import { CARD_FONT_FAMILY } from './card-font';

const STATUS_TARGET_SEARCH_DEPTH = 6;
/**
 * leetcode.com renders English save copy; leetcode.cn renders Chinese copy from
 * its own i18n table. Both sites sit next to the same caption row, so the
 * anchor stays a text match and only the accepted labels change per locale.
 */
const SAVE_STATUS_TEXT =
  /^(?:Saved|Saving(?:…|\.\.\.)?|Restored from local|已存储|已保存|已自动保存|已自动存储|保存中(?:…|\.\.\.)?|存储中(?:…|\.\.\.)?|已恢复|已从本地恢复)$/;
const VIEWPORT_MARGIN_PX = 8;
const BRAND_NAME = '英格科技速写';
const ORG_NAME = '英格科技';

interface StatusDocument {
  createElement(tagName: string): HTMLElement;
  body?: HTMLElement;
  defaultView?: Pick<Window, 'innerHeight' | 'innerWidth'> | null;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
}

export interface StatusMount {
  target: HTMLElement;
  anchor: ChildNode;
  root: HTMLElement;
}

export interface LspStatusAction {
  action: LspControlAction;
  label: string;
}

type StatusLocator = (editor: HTMLElement) => StatusMount | undefined;
type ObserverFactory = (
  callback: MutationCallback,
) => Pick<MutationObserver, 'observe' | 'disconnect'>;
type StatusActionHandler = (
  language: EngineLanguageId,
  action: LspControlAction,
) => Promise<void>;

export class LspStatusIndicator {
  private element: HTMLButtonElement | undefined;
  private announcement: HTMLElement | undefined;
  private menu: HTMLElement | undefined;
  private reviewPrompt: HTMLElement | undefined;
  private target: HTMLElement | undefined;
  private editorTarget: HTMLElement | undefined;
  private language: StatusLanguageId = 'python3';
  private state: EngineStatusState = 'off';
  private detail: string | undefined;
  private actionPending = false;
  private actionError: string | undefined;
  private observer: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  private observedRoot: HTMLElement | undefined;

  constructor(
    private readonly document: StatusDocument,
    private readonly locateStatusMount: StatusLocator,
    private readonly createObserver: ObserverFactory,
    private readonly onAction: StatusActionHandler = async () => {},
  ) {}

  render(
    editorTarget: HTMLElement,
    language: StatusLanguageId,
    state: EngineStatusState,
    detail?: string,
  ): void {
    const lifecycleChanged = this.language !== language || this.state !== state;
    if (lifecycleChanged) this.actionError = undefined;
    this.state = state;
    this.language = language;
    this.detail = detail;
    this.editorTarget = editorTarget;
    if (state === 'off') {
      this.disconnectObserver();
      this.remove();
      return;
    }

    const mount = this.locateStatusMount(editorTarget);
    if (!mount) {
      this.remove();
      return;
    }

    const element = this.element ?? this.createControl();
    this.element = element;
    this.mount(element, mount);
    this.observe(mount.root);
    if (this.announcement) {
      this.announcement.textContent = `${BRAND_NAME} · ${languageLabel(language)} · ${stateLabel(state)}`;
    }
    const description = this.actionError ?? detail ?? globalScopeDescription(language);
    element.title = description;
    element.setAttribute('aria-description', description);
    element.disabled = this.actionPending;
    if (lifecycleChanged && this.menu) this.closeMenu(false);
    if (state !== 'ready') this.dismissReviewPrompt();
    if (this.reviewPrompt) this.positionReviewPrompt(this.reviewPrompt, element);
  }

  showReviewPrompt(reviewUrl: string): void {
    if (
      this.reviewPrompt ||
      this.state !== 'ready' ||
      !this.element ||
      !this.document.body
    ) {
      return;
    }

    const prompt = this.document.createElement('aside');
    prompt.setAttribute('data-leetsense-review-prompt', '');
    prompt.setAttribute('role', 'region');
    prompt.setAttribute('aria-label', '评价速写');
    Object.assign(prompt.style, {
      position: 'fixed',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      width: '288px',
      padding: '14px',
      border: '1px solid #E6D5B4',
      borderRadius: '10px',
      background: '#FFFDF7',
      color: '#2A2016',
      boxShadow: '0 14px 32px rgba(96, 68, 20, 0.20)',
      font: `13px/1.5 ${CARD_FONT_FAMILY}`,
    });

    const close = this.document.createElement('button') as HTMLButtonElement;
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭评价提醒');
    Object.assign(close.style, {
      position: 'absolute',
      top: '6px',
      right: '8px',
      padding: '2px 5px',
      border: '0',
      background: 'transparent',
      color: 'inherit',
      font: `18px/1 ${CARD_FONT_FAMILY}`,
      cursor: 'pointer',
      opacity: '0.55',
    });
    close.addEventListener('click', () => this.dismissReviewPrompt());
    prompt.appendChild(close);

    const heading = this.document.createElement('strong');
    heading.textContent = '喜欢速写吗？';
    Object.assign(heading.style, {
      display: 'block',
      paddingRight: '22px',
      fontSize: '14px',
      color: '#3B2C12',
    });
    prompt.appendChild(heading);

    const copy = this.document.createElement('p');
    copy.textContent = '花几秒留个评价，能让更多 LeetCode 用户找到它。';
    Object.assign(copy.style, {
      margin: '6px 0 12px',
      color: '#8B7757',
    });
    prompt.appendChild(copy);

    const actions = this.document.createElement('div');
    Object.assign(actions.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    });
    const review = this.createExternalLink('去评价', reviewUrl);
    review.setAttribute('data-leetsense-review-link', '');
    Object.assign(review.style, {
      padding: '7px 12px',
      borderRadius: '6px',
      background: 'linear-gradient(140deg, #D9A94D, #B8862B)',
      color: '#FFFDF7',
      fontWeight: '600',
      textDecoration: 'none',
    });
    review.addEventListener('click', () => this.dismissReviewPrompt());
    actions.appendChild(review);

    const decline = this.document.createElement('button') as HTMLButtonElement;
    decline.type = 'button';
    decline.textContent = '以后再说';
    Object.assign(decline.style, {
      padding: '7px 8px',
      border: '0',
      background: 'transparent',
      color: '#8B7757',
      font: 'inherit',
      cursor: 'pointer',
    });
    decline.addEventListener('click', () => this.dismissReviewPrompt());
    actions.appendChild(decline);
    prompt.appendChild(actions);

    this.reviewPrompt = prompt;
    this.document.body.appendChild(prompt);
    this.positionReviewPrompt(prompt, this.element);
  }

  clear(): void {
    this.state = 'off';
    this.editorTarget = undefined;
    this.disconnectObserver();
    this.remove();
  }

  private mount(element: HTMLElement, mount: StatusMount): void {
    if (this.target !== mount.target && this.menu) this.closeMenu(false);
    this.target = mount.target;
    mount.target.insertBefore(element, mount.anchor.nextSibling);
  }

  private observe(root: HTMLElement): void {
    if (root === this.observedRoot && this.observer) return;
    this.disconnectObserver();
    this.observedRoot = root;
    this.observer = this.createObserver(() => this.restoreAttachment());
    this.observer.observe(root, { childList: true, subtree: true });
  }

  private restoreAttachment(): void {
    if (this.state === 'off' || !this.editorTarget || !this.element) return;
    const mount = this.locateStatusMount(this.editorTarget);
    if (!mount) return;
    if (
      this.element.parentElement !== mount.target ||
      mount.anchor.nextSibling !== this.element
    ) {
      this.mount(this.element, mount);
    }
    this.observe(mount.root);
  }

  private disconnectObserver(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.observedRoot = undefined;
  }

  private createControl(): HTMLButtonElement {
    const button = this.document.createElement('button') as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('data-leetsense-status', '');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    Object.assign(button.style, {
      display: 'inline-block',
      maxWidth: '300px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: 'inherit',
      // The strip sits in LeetCode's own caption row, so it borrows that row's
      // typography; the menu it opens is our surface and uses MiSans.
      font: 'inherit',
      lineHeight: 'inherit',
      padding: '0',
      border: '0',
      background: 'transparent',
      cursor: 'pointer',
      userSelect: 'none',
    });
    const announcement = this.document.createElement('span');
    announcement.setAttribute('role', 'status');
    announcement.setAttribute('aria-live', 'polite');
    announcement.setAttribute('aria-atomic', 'true');
    button.appendChild(announcement);
    this.announcement = announcement;
    button.addEventListener('click', () => this.toggleMenu());
    button.addEventListener('keydown', (event) => this.handleButtonKey(event));
    button.addEventListener('focus', () => {
      button.style.outline = '2px solid currentColor';
      button.style.outlineOffset = '2px';
    });
    button.addEventListener('blur', () => {
      button.style.outline = '';
      button.style.outlineOffset = '';
    });
    return button;
  }

  private toggleMenu(): void {
    if (this.menu) this.closeMenu(false);
    else this.openMenu(false);
  }

  private handleButtonKey(event: KeyboardEvent): void {
    if (
      event.key !== 'Enter' &&
      event.key !== ' ' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp'
    ) {
      return;
    }
    event.preventDefault();
    this.openMenu(true, event.key === 'ArrowUp');
  }

  private openMenu(focusItem: boolean, focusLast = false): void {
    if (this.menu || this.actionPending || !this.element) return;
    const actions = actionsForStatus(this.language, this.state);
    if (actions.length === 0 || !this.document.body) return;

    const menu = this.document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute(
      'aria-label',
      `${languageLabel(this.language)} 语言服务操作`,
    );
    menu.setAttribute('data-leetsense-status-menu', '');
    Object.assign(menu.style, {
      position: 'fixed',
      zIndex: '2147483647',
      minWidth: '224px',
      padding: '6px',
      border: '1px solid #E6D5B4',
      borderRadius: '10px',
      background: '#FFFDF7',
      color: '#2A2016',
      boxShadow: '0 14px 32px rgba(96, 68, 20, 0.20)',
      font: `12px/1.45 ${CARD_FONT_FAMILY}`,
    });
    const description = this.document.createElement('div');
    description.textContent = globalScopeDescription(this.language);
    description.setAttribute('role', 'note');
    Object.assign(description.style, {
      padding: '5px 8px 7px',
      color: '#8B7757',
      maxWidth: '262px',
    });
    menu.appendChild(description);

    for (const action of actions) {
      const item = this.document.createElement('button') as HTMLButtonElement;
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('data-leetsense-action', action.action);
      item.textContent = action.label;
      Object.assign(item.style, {
        display: 'block',
        width: '100%',
        padding: '7px 8px',
        border: '0',
        borderRadius: '4px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
      });
      item.addEventListener('mouseenter', () => {
        item.style.background = '#F7EDD9';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('focus', () => {
        item.style.background = '#F7EDD9';
        item.style.outline = 'none';
      });
      item.addEventListener('blur', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('click', () => void this.submitAction(action.action));
      item.addEventListener('keydown', (event) => this.handleMenuKey(event));
      menu.appendChild(item);
    }

    const credits = this.document.createElement('div');
    Object.assign(credits.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      marginTop: '5px',
      padding: '9px 8px 4px',
      borderTop: '1px solid #EFE1C6',
      color: '#9C8B70',
      fontSize: '11.5px',
    });
    const powerBy = this.document.createElement('span');
    powerBy.textContent = 'Power by';
    credits.appendChild(powerBy);
    const org = this.document.createElement('strong');
    org.textContent = ORG_NAME;
    Object.assign(org.style, { color: '#5D4318', fontWeight: '700' });
    credits.appendChild(org);
    menu.appendChild(credits);

    this.menu = menu;
    this.document.body.appendChild(menu);
    this.element.setAttribute('aria-expanded', 'true');
    this.document.addEventListener?.('pointerdown', this.handleOutsidePointer);
    this.positionMenu(menu, this.element);
    if (focusItem) {
      const items = this.menuItems();
      (focusLast ? items.at(-1) : items[0])?.focus();
    }
  }

  private readonly handleOutsidePointer: EventListener = (event) => {
    const target = event.target as Node | null;
    if (
      target &&
      (this.menu?.contains(target) || this.element?.contains(target))
    ) {
      return;
    }
    this.closeMenu(false);
  };

  private handleMenuKey(event: KeyboardEvent): void {
    const items = this.menuItems();
    const current = items.indexOf(event.currentTarget as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      this.closeMenu(false);
      return;
    }
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  }

  private menuItems(): HTMLElement[] {
    if (!this.menu) return [];
    return Array.from(
      this.menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
  }

  private createExternalLink(text: string, href: string): HTMLAnchorElement {
    const link = this.document.createElement('a') as HTMLAnchorElement;
    link.textContent = text;
    link.setAttribute('href', href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    return link;
  }

  private async submitAction(action: LspControlAction): Promise<void> {
    if (this.actionPending) return;
    const language = this.language;
    if (!isEngineLanguage(language)) return;
    this.closeMenu(false);
    this.actionPending = true;
    this.actionError = undefined;
    if (this.element) this.element.disabled = true;
    try {
      await this.onAction(language, action);
    } catch (error) {
      const message = boundedError(error);
      this.actionError = message;
      if (this.element) {
        this.element.title = message;
        this.element.setAttribute('aria-description', message);
      }
    } finally {
      this.actionPending = false;
      if (this.element) this.element.disabled = false;
    }
  }

  private positionMenu(menu: HTMLElement, button: HTMLElement): void {
    const anchor = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = this.document.defaultView?.innerWidth ?? 1024;
    const viewportHeight = this.document.defaultView?.innerHeight ?? 768;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN_PX, anchor.left),
      Math.max(VIEWPORT_MARGIN_PX, viewportWidth - menuRect.width - VIEWPORT_MARGIN_PX),
    );
    const above = anchor.top - menuRect.height - 6;
    const top =
      above >= VIEWPORT_MARGIN_PX
        ? above
        : Math.min(
            anchor.bottom + 6,
            Math.max(VIEWPORT_MARGIN_PX, viewportHeight - menuRect.height - VIEWPORT_MARGIN_PX),
          );
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  private positionReviewPrompt(prompt: HTMLElement, button: HTMLElement): void {
    const anchor = button.getBoundingClientRect();
    const promptRect = prompt.getBoundingClientRect();
    const viewportWidth = this.document.defaultView?.innerWidth ?? 1024;
    const viewportHeight = this.document.defaultView?.innerHeight ?? 768;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN_PX, anchor.left),
      Math.max(
        VIEWPORT_MARGIN_PX,
        viewportWidth - promptRect.width - VIEWPORT_MARGIN_PX,
      ),
    );
    const above = anchor.top - promptRect.height - 8;
    const top =
      above >= VIEWPORT_MARGIN_PX
        ? above
        : Math.min(
            anchor.bottom + 8,
            Math.max(
              VIEWPORT_MARGIN_PX,
              viewportHeight - promptRect.height - VIEWPORT_MARGIN_PX,
            ),
          );
    prompt.style.left = `${Math.round(left)}px`;
    prompt.style.top = `${Math.round(top)}px`;
  }

  private dismissReviewPrompt(): void {
    this.reviewPrompt?.remove();
    this.reviewPrompt = undefined;
  }

  private closeMenu(restoreFocus: boolean): void {
    if (!this.menu) return;
    this.document.removeEventListener?.('pointerdown', this.handleOutsidePointer);
    this.menu.remove();
    this.menu = undefined;
    this.element?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.element?.focus();
  }

  private remove(): void {
    this.closeMenu(false);
    this.dismissReviewPrompt();
    this.element?.remove();
    this.target = undefined;
  }
}

/**
 * LeetCode keeps the save state and line/column text below Monaco. The left
 * cluster is a caption row whose direct child carries Saved/Saving/restored
 * copy (English on leetcode.com, Chinese on leetcode.cn); the closest editor
 * shell is stable while that status subtree updates.
 */
export function findLeetCodeStatusMount(
  editorTarget: HTMLElement,
): StatusMount | undefined {
  let container: HTMLElement | null = editorTarget;
  for (
    let depth = 0;
    container && depth <= STATUS_TARGET_SEARCH_DEPTH;
    depth += 1, container = container.parentElement
  ) {
    const candidates = container.querySelectorAll<HTMLElement>(
      'div.text-caption',
    );
    for (const candidate of candidates) {
      if (
        !candidate.classList.contains('items-center') ||
        !candidate.classList.contains('gap-2') ||
        !candidate.parentElement?.classList.contains('justify-between')
      ) {
        continue;
      }
      const anchor = Array.from(candidate.childNodes).find((node) =>
        SAVE_STATUS_TEXT.test(node.textContent?.trim() ?? ''),
      );
      if (anchor) return { target: candidate, anchor, root: container };
    }
  }
  return undefined;
}

export function actionsForStatus(
  language: StatusLanguageId,
  state: EngineStatusState,
): LspStatusAction[] {
  if (!isEngineLanguage(language)) return [];
  const label = languageLabel(language);
  if (state === 'stopped') {
    return [{ action: 'start', label: `启动 ${label} 语言服务` }];
  }
  if (state === 'starting' || state === 'restarting') {
    return [{ action: 'stop', label: `停止 ${label} 语言服务` }];
  }
  if (state === 'ready' || state === 'unavailable') {
    return [
      { action: 'restart', label: `重启 ${label} 语言服务` },
      { action: 'stop', label: `停止 ${label} 语言服务` },
    ];
  }
  return [];
}

export function isEngineLanguage(
  language: StatusLanguageId,
): language is EngineLanguageId {
  return (
    language === 'python3' ||
    language === 'cpp' ||
    language === 'javascript' ||
    language === 'typescript'
  );
}

function languageLabel(language: StatusLanguageId): string {
  if (language === 'cpp') return 'C++';
  if (language === 'javascript') return 'JavaScript';
  if (language === 'typescript') return 'TypeScript';
  return 'Python';
}

function stateLabel(state: Exclude<EngineStatusState, 'off'>): string {
  if (state === 'starting') return '启动中…';
  if (state === 'restarting') return '重启中…';
  if (state === 'unavailable') return '不可用';
  if (state === 'stopped') return '已停止';
  return '就绪';
}

function globalScopeDescription(language: StatusLanguageId): string {
  if (!isEngineLanguage(language)) {
    return '由页面内置的 Monaco TypeScript 服务提供，无需额外引擎。';
  }
  return '操作将作用于所有打开的 LeetCode 标签页';
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 240 ? message : `${message.slice(0, 237)}…`;
}
