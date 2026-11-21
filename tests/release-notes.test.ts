import { describe, expect, it } from 'vitest';

import { extractReleaseNotes } from '../scripts/release-notes.mjs';

describe('release notes', () => {
  it('extracts only the exact requested changelog section', () => {
    const changelog = `# Changelog

## 1.2.0 — 2026-07-18

### Added

- Resilience.

## 1.1.0 — 2026-07-17

- Previous.
`;

    expect(extractReleaseNotes(changelog, '1.2.0')).toBe(
      `## 1.2.0 — 2026-07-18

### Added

- Resilience.`,
    );
  });

  it('rejects missing, duplicate, and empty version sections', () => {
    expect(() => extractReleaseNotes('# Changelog\n', '1.2.0')).toThrow(
      'found 0',
    );
    expect(() =>
      extractReleaseNotes('## 1.2.0\n- A\n## 1.2.0\n- B\n', '1.2.0'),
    ).toThrow('found 2');
    expect(() => extractReleaseNotes('## 1.2.0\n', '1.2.0')).toThrow(
      'is empty',
    );
  });
});
