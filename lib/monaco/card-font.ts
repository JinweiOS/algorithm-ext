/**
 * The in-page status strip and its menu live in LeetCode's own document, so
 * they can only use the bundled MiSans face if the page gets an `@font-face`
 * rule pointing at the packaged file. The rule is injected once per document
 * and removed with the rest of the UI.
 *
 * Content scripts start at `document_start`, where `document.head` does not
 * exist yet, so the rule is mounted as soon as a parent is available.
 *
 * `font-display: swap` keeps the strip readable on its first frame; if the
 * face never loads (page CSP, file missing) every declaration falls back to the
 * platform UI font through the stack below.
 */

export const CARD_FONT_FAMILY =
  '"MiSans", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif';

const STYLE_ID = 'leetsense-font-face';

const FONT_FACE_RULE = (url: string): string => `
@font-face {
  font-family: "MiSans";
  src: url("${url}") format("woff2-variations");
  font-weight: 150 700;
  font-style: normal;
  font-display: swap;
}`;

export function installCardFont(doc: Document, fontUrl: string): () => void {
  let style: HTMLStyleElement | null = null;
  let disposed = false;

  function mount(): void {
    if (disposed || style) return;
    if (doc.getElementById?.(STYLE_ID)) return;
    const parent = doc.head ?? doc.documentElement;
    if (!parent) return;
    style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = FONT_FACE_RULE(fontUrl);
    parent.appendChild(style);
  }

  const onReady = (): void => mount();

  mount();
  if (!style) {
    doc.addEventListener?.('DOMContentLoaded', onReady, { once: true });
  }

  return () => {
    disposed = true;
    doc.removeEventListener?.('DOMContentLoaded', onReady);
    style?.remove();
    style = null;
  };
}
