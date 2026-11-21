import { describe, expect, it } from 'vitest';

import {
  SUGGEST_VISIBILITY,
  withSuggestVisibility,
} from '../lib/monaco/suggest-visibility';

describe('suggest visibility', () => {
  it('reopens the method and function filters LeetCode narrows', () => {
    const narrowed = {
      showMethods: false,
      showFunctions: false,
      preview: true,
    };

    const merged = withSuggestVisibility(narrowed);

    expect(merged.showMethods).toBe(true);
    expect(merged.showFunctions).toBe(true);
    // Page settings that are not ours survive the merge.
    expect(merged.preview).toBe(true);
  });

  it('pins every engine-visible kind open', () => {
    for (const [key, value] of Object.entries(SUGGEST_VISIBILITY)) {
      expect(withSuggestVisibility({ [key]: false })[key]).toBe(value);
    }
  });

  it('tolerates a missing or unusable suggest object', () => {
    for (const input of [undefined, null, 7, 'methods']) {
      const merged = withSuggestVisibility(input);
      expect(merged.showMethods).toBe(true);
      expect(merged.showProperties).toBe(true);
    }
  });

  it('never mutates the page object it was handed', () => {
    const pageOptions = { showMethods: false };
    const merged = withSuggestVisibility(pageOptions);

    expect(pageOptions.showMethods).toBe(false);
    expect(merged).not.toBe(pageOptions);
  });
});
