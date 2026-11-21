/**
 * Keeps the injected floating panel — which frames this page in an <iframe> —
 * exactly as tall as its content. The injected wrapper lives in the host page
 * and cannot read the iframe layout cross-origin, so this page measures itself
 * and reports its height to the parent window.
 *
 * Inside the native-popup fallback (or a standalone tab) `window.parent` is
 * this very window, so the postMessage round-trips harmlessly to itself.
 */

import { mountFluidCursor } from './fluid-cursor';

const HEIGHT_MESSAGE_TYPE = 'suxie-panel-height';

/**
 * The ink layer is decoration only: when WebGL2 is missing, the context is
 * lost, or the visitor prefers reduced motion, the panel keeps its animated
 * CSS background and nothing else changes.
 */
function startFluidBackground(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('.fluid');
  if (!canvas) return;
  try {
    mountFluidCursor(canvas, {
      // The requested cream, with two neighbours so the ink still drifts
      // through a hue instead of sitting flat on one value.
      colors: ['#fff6d8', '#fdeec2', '#fffcf0'],
      size: 1.2,
      force: 1,
      swirl: 2.4,
      trail: 1.4,
      momentum: 1,
      glow: 0.16,
      intensity: 4,
      quality: 'low',
      // The pointer dusts the paper; a click must not stamp a flower on it.
      clickSplash: false,
    });
  } catch {
    canvas.remove();
  }
}

function reportHeight(): void {
  const body = document.body;
  if (!body) return;
  // Body height is content-driven (no viewport dependency), so it also tracks
  // the entry animation while the body block unfolds frame by frame.
  const height = Math.ceil(body.getBoundingClientRect().height);
  if (height <= 0) return;
  // A couple of pixels of slack absorbs sub-pixel rounding so the iframe never
  // tips into showing its own scrollbars; the gradient fills the slack.
  window.parent?.postMessage({ type: HEIGHT_MESSAGE_TYPE, height: height + 2 }, '*');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    reportHeight();
    void document.fonts?.ready.then(reportHeight).catch(() => undefined);
    // One frame later the card has its final box, so the canvas is sized once
    // instead of being resized on the first hover.
    requestAnimationFrame(startFluidBackground);
  });
} else {
  reportHeight();
  void document.fonts?.ready.then(reportHeight).catch(() => undefined);
  requestAnimationFrame(startFluidBackground);
}

window.addEventListener('load', reportHeight);
if (document.body) {
  new ResizeObserver(reportHeight).observe(document.body);
}
