/**
 * Floating action panel injected into the current page when the toolbar icon
 * is clicked.
 *
 * Chrome owns the shape of the native popup window, so the brand panel cannot
 * be rounded there. On ordinary pages we instead inject this floating card:
 * it frames the extension page (`panel.html`) in an <iframe>, so the same
 * content serves both surfaces — rounded and movable here, plain rectangle as
 * the native-popup fallback on pages that reject injection.
 *
 * Moving is explicit rather than implied by hover: the frame is interactive
 * surface, so a grab cursor over the whole card made every hover feel like the
 * start of a drag. A small grip arms dragging instead, the same way the × at
 * the top dismisses the card.
 *
 * The grip sits on the card's last line rather than in a band of its own: the
 * framed page ends with a left-aligned credit line, so the grip takes the empty
 * right end of that row and the two read as one footer instead of a floating
 * handle under the content.
 */

export const PANEL_ROOT_ID = 'suxie-action-panel';
/** Matches `html { width: 318px }` in panel/style.css so the iframe fits exactly. */
export const PANEL_WIDTH = 318;
/**
 * Opening height, i.e. the header alone. The framed page measures itself and
 * the wrapper grows from here as the card unfolds (final card ≈ 426px), so this
 * value only has to cover the first frame. Kept in sync with the local copy
 * inside `injectActionPanel`, which cannot reference this constant (the
 * function source is serialized by Chrome).
 */
export const PANEL_HEIGHT = 84;
/** Runtime URL path — must start with `/` to satisfy the PublicPath typing. */
export const PANEL_PAGE = '/panel.html';
/**
 * The panel page plays its entry choreography only when it is framed, keyed by
 * this fragment (`body:target` in panel/style.css). The native-popup fallback
 * opens the page without it and stays instant.
 */
export const PANEL_FRAME_SUFFIX = '#framed';

/**
 * Runs inside the clicked tab (via `chrome.scripting.executeScript`). It must
 * stay fully self-contained: Chrome serializes the function source, so nothing
 * outside this body — no imports, no module constants — is available.
 *
 * Clicking the icon a second time toggles the panel closed.
 */
export function injectActionPanel(panelUrl: string): void {
  const ROOT_ID = 'suxie-action-panel';
  const WIDTH = 318;
  // Starts at roughly header height: the framed page plays its entry animation
  // and reports its growing height, so the card unfolds downward on screen.
  const HEIGHT = 84;

  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    existing.remove();
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.id = ROOT_ID;
  Object.assign(wrapper.style, {
    position: 'fixed',
    zIndex: '2147483647',
    top: '24px',
    left: `${Math.max(12, window.innerWidth - WIDTH - 24)}px`,
    // Host sites commonly impose `border-box` globally (Tailwind preflight),
    // which would shrink the iframe below the page's fixed 318px width and
    // trigger scrollbars inside the frame. Pin the model instead.
    boxSizing: 'content-box',
    width: `${WIDTH}px`,
    height: `${HEIGHT}px`,
    borderRadius: '16px',
    overflow: 'hidden',
    // No border on the wrapper: a border insets the frame by 1px and the gap
    // used to show this background through as a white hairline, which looked
    // like a seam on any blank page. The edge ring is drawn *outside* the box
    // instead, so the frame reaches the clip and the rounded edge is the card
    // itself. The fill stays the card's own gradient for the instant before
    // the frame paints.
    background:
      'linear-gradient(168deg, #fffdf8 0%, #fbf3e1 58%, #f5e9d2 100%)',
    border: '0',
    boxShadow:
      '0 0 0 1px rgba(190, 160, 100, 0.4), 0 18px 44px rgba(80, 55, 10, 0.26), 0 2px 8px rgba(80, 55, 10, 0.16)',
    fontFamily: 'system-ui, sans-serif',
  });

  const frame = document.createElement('iframe');
  frame.src = `${panelUrl}#framed`;
  frame.title = '速写';
  Object.assign(frame.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    border: '0',
    // The wrapper clips; a second radius on the frame made the two antialiased
    // arcs disagree and left a pale rim around the corners.
    borderRadius: '0',
    background: 'transparent',
  });

  // Pointer events over an <iframe> belong to the framed document, so a
  // transparent layer on top owns dragging instead. It stays inert until the
  // grip arms it: until then the card is just a card.
  const dragLayer = document.createElement('div');
  Object.assign(dragLayer.style, {
    position: 'absolute',
    inset: '0',
    zIndex: '1',
    borderRadius: '16px',
    pointerEvents: 'none',
    cursor: 'default',
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭');
  // The glyph is drawn as two strokes in a flex-centred box: a text `×` never
  // sits dead centre across fonts, and the SVG keeps it crisp at any DPI.
  close.innerHTML =
    '<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" focusable="false">' +
    '<path d="M1.2 1.2 9.8 9.8M9.8 1.2 1.2 9.8" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round"/></svg>';
  Object.assign(close.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    zIndex: '2',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    padding: '0',
    border: '0',
    borderRadius: '50%',
    background: 'transparent',
    color: '#9a8874', // muted gold-grey at rest
    lineHeight: '0',
    cursor: 'pointer',
    outline: 'none',
    boxShadow: '0 0 0 0 rgba(96, 68, 20, 0)',
    transform: 'scale(1)',
    transition:
      'background-color 180ms ease, box-shadow 180ms ease, color 180ms ease, transform 180ms ease',
  });

  // Rest state is fully transparent; hover fades a soft disc in behind the ×.
  const setHovered = (hovered: boolean): void => {
    close.style.background = hovered
      ? 'rgba(255, 252, 244, 0.97)'
      : 'transparent';
    close.style.color = hovered ? '#5a4728' : '#9a8874';
    close.style.boxShadow = hovered
      ? '0 3px 10px rgba(96, 68, 20, 0.22)'
      : '0 0 0 0 rgba(96, 68, 20, 0)';
    close.style.transform = hovered ? 'scale(1.1)' : 'scale(1)';
  };
  close.addEventListener('pointerenter', () => setHovered(true));
  close.addEventListener('pointerleave', () => setHovered(false));
  close.addEventListener('focus', () => setHovered(true));
  close.addEventListener('blur', () => setHovered(false));

  // The grip shares the credit row at the card's foot: the framed page ends
  // with a 16px pad and one line of 11.5px credit, and the grip takes the empty
  // right end of that line instead of a band of its own.
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.setAttribute('aria-label', '拖动面板');
  grip.setAttribute('aria-pressed', 'false');
  // Two columns of three dots: the conventional "drag me" grip, and unlike a
  // four-way arrow it still reads at 10px.
  grip.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' +
    '<g fill="currentColor">' +
    '<circle cx="4.2" cy="2.6" r="1.15"/><circle cx="7.8" cy="2.6" r="1.15"/>' +
    '<circle cx="4.2" cy="6" r="1.15"/><circle cx="7.8" cy="6" r="1.15"/>' +
    '<circle cx="4.2" cy="9.4" r="1.15"/><circle cx="7.8" cy="9.4" r="1.15"/>' +
    '</g></svg>';
  Object.assign(grip.style, {
    position: 'absolute',
    // Right-aligned inside the card's 20px content gutter, nudged in far enough
    // that the hover disc clears the rounded corner.
    right: '14px',
    // Centred on the credit line's optical middle — the text's ink sits about
    // 26px above the card's edge, not at the 24px of the line box, because the
    // descenders hang below the baseline.
    bottom: '15px',
    zIndex: '3',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '22px',
    padding: '0',
    border: '0',
    borderRadius: '999px',
    background: 'transparent',
    color: '#96805e', // muted sand at rest
    lineHeight: '0',
    cursor: 'pointer',
    outline: 'none',
    boxShadow: '0 0 0 0 rgba(96, 68, 20, 0)',
    // The card unfolds over ~640ms; until it has its full height the grip would
    // ride the growing bottom edge across the header, so it fades in after.
    opacity: '0',
    transform: 'scale(1)',
    transition:
      'background-color 180ms ease, box-shadow 180ms ease, color 180ms ease, transform 180ms ease, opacity 220ms ease',
  });

  const revealGrip = setTimeout(() => {
    grip.style.opacity = '1';
  }, 700);

  let armed = false;
  let gripHovered = false;

  /** Rest → transparent; hover → soft disc; armed → latched gold, like a switch. */
  const paintGrip = (): void => {
    grip.style.background = armed
      ? 'rgba(214, 164, 74, 0.95)'
      : gripHovered
        ? 'rgba(255, 252, 244, 0.97)'
        : 'transparent';
    grip.style.color = armed
      ? '#fffaf0'
      : gripHovered
        ? '#5a4728'
        : '#96805e';
    grip.style.boxShadow =
      armed || gripHovered
        ? '0 3px 10px rgba(96, 68, 20, 0.24)'
        : '0 0 0 0 rgba(96, 68, 20, 0)';
    grip.style.transform = `scale(${armed || gripHovered ? 1.1 : 1})`;
    grip.style.cursor = armed ? 'grab' : 'pointer';
  };

  const setArmed = (next: boolean): void => {
    armed = next;
    grip.setAttribute('aria-pressed', String(next));
    grip.setAttribute('aria-label', next ? '结束拖动' : '拖动面板');
    // The layer only takes the pointer once dragging is armed, so a hover over
    // the card at rest belongs to the card.
    dragLayer.style.pointerEvents = next ? 'auto' : 'none';
    dragLayer.style.cursor = next ? 'grab' : 'default';
    paintGrip();
  };

  grip.addEventListener('pointerenter', () => {
    gripHovered = true;
    paintGrip();
  });
  grip.addEventListener('pointerleave', () => {
    gripHovered = false;
    paintGrip();
  });
  grip.addEventListener('focus', () => {
    gripHovered = true;
    paintGrip();
  });
  grip.addEventListener('blur', () => {
    gripHovered = false;
    paintGrip();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (!document.getElementById(ROOT_ID)) {
      teardown();
      return;
    }
    // Escape sheathes the drag handle first; dismissing the card is the second
    // press, so an armed panel is never lost by reflex.
    if (armed) {
      setArmed(false);
      return;
    }
    wrapper.remove();
    teardown();
  };
  document.addEventListener('keydown', onKeyDown, true);

  /**
   * The framed panel page reports its own content height (fonts and all), so
   * the card hugs the content instead of shipping a fixed guess. Bounded so a
   * rogue message can never blow the panel past the viewport.
   */
  const onHeightMessage = (event: MessageEvent): void => {
    // The toggle path removes the wrapper without touching these listeners, so
    // they unhook themselves on the next event once the panel is gone.
    if (!document.getElementById(ROOT_ID)) {
      teardown();
      return;
    }
    const data = event.data as { type?: unknown; height?: unknown } | null;
    if (!data || data.type !== 'suxie-panel-height') return;
    if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return;
    // Border case only guards against nonsense; the floor is deliberately low
    // so the card can start collapsed to its header while it unfolds.
    const max = Math.max(240, window.innerHeight - 24);
    const height = Math.min(Math.max(84, Math.ceil(data.height)), max);
    wrapper.style.height = `${height}px`;
  };
  window.addEventListener('message', onHeightMessage);

  const teardown = (): void => {
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('message', onHeightMessage);
    clearTimeout(revealGrip);
  };

  close.addEventListener('pointerdown', (event) => event.stopPropagation());
  close.addEventListener('click', () => {
    wrapper.remove();
    teardown();
  });

  grip.addEventListener('pointerdown', (event) => event.stopPropagation());
  grip.addEventListener('click', (event) => {
    event.stopPropagation();
    setArmed(!armed);
  });

  dragLayer.addEventListener('pointerdown', (event) => {
    if (!armed) return;
    event.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    dragLayer.style.cursor = 'grabbing';
    try {
      dragLayer.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events (tests, CDP) can lack a real pointer to capture.
    }
    const move = (moveEvent: PointerEvent): void => {
      const maxLeft = Math.max(0, window.innerWidth - wrapper.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - wrapper.offsetHeight);
      const left = Math.min(
        Math.max(0, moveEvent.clientX - offsetX),
        maxLeft,
      );
      const top = Math.min(Math.max(0, moveEvent.clientY - offsetY), maxTop);
      wrapper.style.left = `${Math.round(left)}px`;
      wrapper.style.top = `${Math.round(top)}px`;
    };
    const stop = (): void => {
      dragLayer.style.cursor = 'grab';
      dragLayer.removeEventListener('pointermove', move);
      dragLayer.removeEventListener('pointerup', stop);
      dragLayer.removeEventListener('pointercancel', stop);
    };
    dragLayer.addEventListener('pointermove', move);
    dragLayer.addEventListener('pointerup', stop);
    dragLayer.addEventListener('pointercancel', stop);
  });

  wrapper.append(frame, dragLayer, close, grip);
  (document.body ?? document.documentElement).append(wrapper);
}
