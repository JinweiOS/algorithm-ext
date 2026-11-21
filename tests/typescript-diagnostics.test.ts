import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  buildLeetCodeAmbientTypes,
  disableMonacoTypeScriptDiagnostics,
  type TypeScriptDiagnosticsOptions,
  type TypeScriptLanguageDefaults,
} from '../lib/monaco/typescript-diagnostics';

function createDefaults(initialOptions: TypeScriptDiagnosticsOptions) {
  let appliedOptions = initialOptions;
  const defaults: TypeScriptLanguageDefaults = {
    getDiagnosticsOptions: () => appliedOptions,
    setDiagnosticsOptions(options) {
      appliedOptions = options;
    },
  };
  const originalSetDiagnosticsOptions = defaults.setDiagnosticsOptions;

  return {
    defaults,
    getAppliedOptions: () => appliedOptions,
    originalSetDiagnosticsOptions,
  };
}

function compileWithAmbient(userSource: string): number[] {
  const files = new Map([
    ['/leetsense-ambient.d.ts', buildLeetCodeAmbientTypes(userSource)],
    ['/main.ts', userSource],
  ]);
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = (fileName) =>
    files.has(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => files.get(fileName) ?? ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion) => {
    const source = files.get(fileName) ?? ts.sys.readFile(fileName);
    return source === undefined
      ? undefined
      : ts.createSourceFile(fileName, source, languageVersion, true);
  };

  return ts
    .getPreEmitDiagnostics(ts.createProgram([...files.keys()], options, host))
    .filter((diagnostic) => files.has(diagnostic.file?.fileName ?? ''))
    .map((diagnostic) => diagnostic.code);
}

describe('disableMonacoTypeScriptDiagnostics', () => {
  it('silences the page worker even when LeetCode re-applies its own options', () => {
    const typescript = createDefaults({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      onlyVisible: false,
    });
    const javascript = createDefaults({});

    const controller = disableMonacoTypeScriptDiagnostics({
      typescriptDefaults: typescript.defaults,
      javascriptDefaults: javascript.defaults,
    });

    const forced = {
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    };
    expect(typescript.getAppliedOptions()).toEqual({
      ...forced,
      onlyVisible: false,
    });
    expect(javascript.getAppliedOptions()).toEqual(forced);

    typescript.defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [6133],
    });
    expect(typescript.getAppliedOptions()).toEqual({
      ...forced,
      diagnosticCodesToIgnore: [6133],
    });

    controller.dispose();

    expect(typescript.defaults.setDiagnosticsOptions).toBe(
      typescript.originalSetDiagnosticsOptions,
    );
    // The page's latest settings come back, not our forced-off copy.
    expect(typescript.getAppliedOptions()).toEqual({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [6133],
    });
    expect(javascript.defaults.setDiagnosticsOptions).toBe(
      javascript.originalSetDiagnosticsOptions,
    );
  });

  it('is idempotent when the same defaults are wrapped once', () => {
    const typescript = createDefaults({});
    const javascript = createDefaults({});
    const controller = disableMonacoTypeScriptDiagnostics({
      typescriptDefaults: typescript.defaults,
      javascriptDefaults: javascript.defaults,
    });

    expect(typescript.getAppliedOptions()).toEqual({
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    });

    controller.dispose();
    expect(typescript.getAppliedOptions()).toEqual({});
  });
});

describe('buildLeetCodeAmbientTypes', () => {
  it('provides LeetCode node types and constructors by default', () => {
    const source = buildLeetCodeAmbientTypes();

    expect(source).toContain('interface ListNode');
    expect(source).toContain('declare var ListNode');
    expect(source).toContain('interface TreeNode');
    expect(source).toContain('declare var TreeNode');
    expect(source).toContain('interface Node');
    expect(source).not.toContain('declare var Node');
    expect(source).toContain('neighbors: Node[]');
    expect(source).toContain('random: Node | null');
    expect(source).toContain('children: Node[]');
  });

  it('omits a type the user declares without treating template comments as declarations', () => {
    expect(buildLeetCodeAmbientTypes('class ListNode {}')).not.toContain(
      'ListNode',
    );
    expect(
      buildLeetCodeAmbientTypes(`
        /**
         * Definition for singly-linked list.
         * class ListNode {}
         */
        function solve() {}
      `),
    ).toContain('declare var ListNode');
  });

  it('type-checks judge nodes against the standard DOM library', () => {
    expect(
      compileWithAmbient(`
        const list = new ListNode();
        list.next = new ListNode(2);
        function inspect(node: Node) {
          return [node.val, node.children, node.random];
        }
      `),
    ).toEqual([]);
  }, 20_000);

  it('allows a user-provided ListNode class without duplicate identifiers', () => {
    expect(
      compileWithAmbient(`
        class ListNode {
          constructor(
            public val = 0,
            public next: ListNode | null = null,
          ) {}
        }
        const list = new ListNode(1);
      `),
    ).toEqual([]);
  }, 20_000);
});
