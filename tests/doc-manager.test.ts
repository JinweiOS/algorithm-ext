import { describe, expect, it } from 'vitest';

import {
  createEngineDocument,
  diagnosticToMarker,
  toEditorPosition,
  toEditorRange,
  toEnginePosition,
} from '../lib/engines/python/doc-manager';
import {
  PYTHON_PRELUDE,
  PYTHON_PRELUDE_LINE_COUNT,
} from '../lib/engines/python/prelude';

describe('Python doc manager', () => {
  it('prepends the LeetCode prelude without hardcoding its line count', () => {
    const userCode = 'class Solution:\n    pass\n';
    expect(createEngineDocument(userCode)).toBe(PYTHON_PRELUDE + userCode);
    expect(PYTHON_PRELUDE_LINE_COUNT).toBe(
      PYTHON_PRELUDE.split('\n').length - 1,
    );
    expect(PYTHON_PRELUDE).toContain(
      'from typing import List, Optional, Dict, Set, Tuple',
    );
    expect(PYTHON_PRELUDE).toContain('class ListNode:');
    expect(PYTHON_PRELUDE).toContain('class TreeNode:');
    expect(PYTHON_PRELUDE).toContain('class Node:');
  });

  it.each([
    { line: 0, character: 0 },
    { line: 1, character: 12 },
    { line: 999, character: 3 },
  ])('round trips editor position $line:$character', (position) => {
    expect(toEditorPosition(toEnginePosition(position))).toEqual(position);
  });

  it('drops positions and ranges that touch the prelude', () => {
    expect(toEditorPosition({ line: PYTHON_PRELUDE_LINE_COUNT - 1, character: 0 })).toBeNull();
    expect(
      toEditorRange({
        start: { line: PYTHON_PRELUDE_LINE_COUNT - 1, character: 0 },
        end: { line: PYTHON_PRELUDE_LINE_COUNT, character: 1 },
      }),
    ).toBeNull();
  });

  it('maps user diagnostics back to editor coordinates', () => {
    expect(
      diagnosticToMarker({
        range: {
          start: { line: PYTHON_PRELUDE_LINE_COUNT + 2, character: 4 },
          end: { line: PYTHON_PRELUDE_LINE_COUNT + 2, character: 10 },
        },
        severity: 1,
        message: 'Argument is not assignable',
        code: 'reportArgumentType',
      }),
    ).toEqual({
      startLine: 2,
      startCol: 4,
      endLine: 2,
      endCol: 10,
      severity: 1,
      message: 'Argument is not assignable',
      code: 'reportArgumentType',
    });
  });

  it('suppresses redeclaration noise for judge-provided classes', () => {
    expect(
      diagnosticToMarker({
        range: {
          start: { line: PYTHON_PRELUDE_LINE_COUNT, character: 6 },
          end: { line: PYTHON_PRELUDE_LINE_COUNT, character: 14 },
        },
        severity: 2,
        message:
          'Class declaration "ListNode" is obscured by a declaration of the same name',
      }),
    ).toBeNull();
  });
});
