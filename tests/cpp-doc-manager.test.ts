import { describe, expect, it } from 'vitest';

import {
  createEngineDocument,
  diagnosticToMarker,
  toEditorPosition,
  toEditorRange,
  toEnginePosition,
} from '../lib/engines/cpp/doc-manager';
import {
  CPP_PRELUDE,
  CPP_PRELUDE_LINE_COUNT,
} from '../lib/engines/cpp/prelude';

describe('C++ doc manager', () => {
  it('uses libc++-portable headers and judge-provided node types', () => {
    expect(createEngineDocument('class Solution {};\n')).toBe(
      `${CPP_PRELUDE}class Solution {};\n`,
    );
    expect(CPP_PRELUDE).toContain('#include <vector>');
    expect(CPP_PRELUDE).not.toContain('bits/stdc++.h');
    expect(CPP_PRELUDE).toContain('using namespace std;');
    expect(CPP_PRELUDE).toContain('struct ListNode');
    expect(CPP_PRELUDE).toContain('struct TreeNode');
    expect(CPP_PRELUDE).toContain('class Node');
  });

  it.each([
    { line: 0, character: 0 },
    { line: 8, character: 12 },
    { line: 999, character: 3 },
  ])('round trips editor position $line:$character', (position) => {
    expect(toEditorPosition(toEnginePosition(position))).toEqual(position);
  });

  it('drops ranges that touch the prelude', () => {
    expect(
      toEditorRange({
        start: { line: CPP_PRELUDE_LINE_COUNT - 1, character: 0 },
        end: { line: CPP_PRELUDE_LINE_COUNT, character: 1 },
      }),
    ).toBeNull();
  });

  it('maps user diagnostics back to editor coordinates', () => {
    expect(
      diagnosticToMarker({
        range: {
          start: { line: CPP_PRELUDE_LINE_COUNT + 2, character: 4 },
          end: { line: CPP_PRELUDE_LINE_COUNT + 2, character: 7 },
        },
        severity: 1,
        message: 'Cannot initialize a variable of type int with an rvalue',
      }),
    ).toMatchObject({
      startLine: 2,
      startCol: 4,
      endLine: 2,
      endCol: 7,
      severity: 1,
    });
  });

  it('suppresses judge-type redefinitions and early include failures', () => {
    expect(
      diagnosticToMarker({
        range: {
          start: { line: CPP_PRELUDE_LINE_COUNT, character: 7 },
          end: { line: CPP_PRELUDE_LINE_COUNT, character: 15 },
        },
        severity: 1,
        message: "redefinition of 'ListNode'",
      }),
    ).toBeNull();
    expect(
      diagnosticToMarker({
        range: {
          start: { line: CPP_PRELUDE_LINE_COUNT, character: 0 },
          end: { line: CPP_PRELUDE_LINE_COUNT, character: 1 },
        },
        severity: 1,
        message: "'vector' file not found",
      }),
    ).toBeNull();
  });
});
