import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('panel assets', () => {
  it('ships a small subset of the bundled face', () => {
    const font = readFileSync(resolve(root, 'public/fonts/MiSans-VF.woff2'));
    // wOF2 magic: the file must really be woff2, not a renamed ttf.
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2');
    const size = statSync(resolve(root, 'public/fonts/MiSans-VF.woff2')).size;
    expect(size).toBeGreaterThan(20_000);
    // A full MiSans weight is ~5 MB; anything near that means the subset step
    // was skipped and every panel open would pull the whole family.
    expect(size).toBeLessThan(600_000);
  });

  it('declares the face in the panel stylesheet', () => {
    const css = read('entrypoints/panel/style.css');
    expect(css).toContain('@font-face');
    expect(css).toContain('/fonts/MiSans-VF.woff2');
    expect(css).toContain('font-weight: 150 700');
    expect(css).toMatch(/font-family:\s*\n?\s*"MiSans"/);
  });

  it('keeps the drifting background behind the content', () => {
    const css = read('entrypoints/panel/style.css');
    expect(css).toContain('.aurora');
    expect(css).toContain('@keyframes aurora-breathe');
    expect(css).toContain('@keyframes aurora-sheen');
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*\.aurora/);
    const html = read('entrypoints/panel/index.html');
    expect(html).toContain('class="aurora"');
    expect(html).toContain('class="fluid"');
  });

  it('mounts the ink canvas from the panel entry', () => {
    const main = read('entrypoints/panel/main.ts');
    expect(main).toContain("from './fluid-cursor'");
    expect(main).toContain('mountFluidCursor');
  });

  it('exposes the font to the page so the status strip can use it', () => {
    const config = read('wxt.config.ts');
    expect(config).toContain('fonts/*.woff2');
    const bridge = read('entrypoints/bridge.content.ts');
    expect(bridge).toContain('installCardFont');
    expect(bridge).toContain('/fonts/MiSans-VF.woff2');
    const indicator = read('lib/monaco/lsp-status-indicator.ts');
    expect(indicator).toContain('CARD_FONT_FAMILY');
    expect(indicator).not.toContain('system-ui');
  });
});
