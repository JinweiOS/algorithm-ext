import ts from 'typescript';

import { buildLeetCodeAmbientTypes } from '../../monaco/typescript-diagnostics';
import type {
  CompletionResult,
  DiagnosticMarker,
  HoverResult,
  PositionParams,
  SignatureHelpResult,
} from '../../../utils/protocol';
import {
  completionEntryDocumentation,
  diagnosticToMarker,
  hoverToMarkdown,
  signatureHelpFrom,
  toProtocolCompletion,
} from './ts-mapping';

const LIB_DIRECTORY = '/__leetsense_lib__/';
const AMBIENT_FILE = '/__leetsense_ambient__.d.ts';
const MAX_COMPLETION_ENTRIES = 400;
const DOCUMENTED_ENTRIES = 20;

export interface TypeScriptServiceOptions {
  /** `lib.*.d.ts` sources keyed by file name, loaded before the service starts. */
  libSources: ReadonlyMap<string, string>;
  /** JavaScript mode disables type errors but keeps inference for completions. */
  allowJs: boolean;
  /** LeetCode's judge-provided globals (ListNode, TreeNode, Node). */
  ambientTypes?: (text: string) => string;
}

interface OpenDocument {
  text: string;
  version: number;
}

export interface TypeScriptService {
  open(fileName: string, text: string, version: number): void;
  update(fileName: string, text: string, version: number): void;
  close(fileName: string): void;
  completion(fileName: string, position: PositionParams): CompletionResult;
  hover(fileName: string, position: PositionParams): HoverResult;
  signatureHelp(fileName: string, position: PositionParams): SignatureHelpResult;
  diagnostics(fileName: string): DiagnosticMarker[];
  dispose(): void;
}

export function createTypeScriptService(
  options: TypeScriptServiceOptions,
): TypeScriptService {
  const documents = new Map<string, OpenDocument>();
  const libNames = [...options.libSources.keys()].map((name) => `${LIB_DIRECTORY}${name}`);
  let ambientText = options.ambientTypes ? options.ambientTypes('') : '';
  let ambientVersion = 1;
  let disposed = false;

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [
      ...libNames,
      AMBIENT_FILE,
      ...documents.keys(),
    ],
    getScriptVersion: (fileName) => {
      if (fileName === AMBIENT_FILE) return String(ambientVersion);
      const document = documents.get(fileName);
      return document ? String(document.version) : '1';
    },
    getScriptSnapshot: (fileName) => {
      const text = readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => compilationSettings(),
    getDefaultLibFileName: () => `${LIB_DIRECTORY}lib.es2022.full.d.ts`,
    getScriptKind: (fileName) => scriptKind(fileName),
    fileExists: (fileName) => readFile(fileName) !== undefined,
    readFile: (fileName) => readFile(fileName),
    readDirectory: () => [],
    directoryExists: () => false,
    getDirectories: () => [],
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  function compilationSettings(): ts.CompilerOptions {
    return {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution:
        ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
      allowJs: options.allowJs,
      checkJs: options.allowJs,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      allowNonTsExtensions: true,
      types: [],
      lib: undefined,
    };
  }

  function readFile(fileName: string): string | undefined {
    if (fileName === AMBIENT_FILE) return ambientText;
    if (fileName.startsWith(LIB_DIRECTORY)) {
      return options.libSources.get(fileName.slice(LIB_DIRECTORY.length));
    }
    return documents.get(fileName)?.text;
  }

  function scriptKind(fileName: string): ts.ScriptKind {
    if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (fileName.endsWith('.js') || fileName.endsWith('.mjs')) return ts.ScriptKind.JS;
    if (fileName.endsWith('.json')) return ts.ScriptKind.JSON;
    return ts.ScriptKind.TS;
  }

  function refreshAmbientTypes(fileName: string): void {
    if (!options.ambientTypes) return;
    const text = options.ambientTypes(documents.get(fileName)?.text ?? '');
    if (text === ambientText) return;
    ambientText = text;
    ambientVersion += 1;
  }

  /**
   * `PositionParams` is LSP-shaped (0-based line and character), exactly what
   * the page hands to Pyright and clangd. Clamp into the file instead of
   * trusting the editor so a stale position never becomes a negative offset.
   */
  function filePosition(
    fileName: string,
    position: PositionParams,
  ): number | undefined {
    const sourceFile = service.getProgram()?.getSourceFile(fileName);
    if (!sourceFile) return undefined;
    const lineStarts = sourceFile.getLineStarts();
    const line = Math.min(Math.max(position.line, 0), lineStarts.length - 1);
    const lineStart = lineStarts[line];
    const lineEnd = sourceFile.getLineEndOfPosition(lineStart);
    const character = Math.min(
      Math.max(position.character, 0),
      Math.max(lineEnd - lineStart, 0),
    );
    return ts.getPositionOfLineAndCharacter(sourceFile, line, character);
  }

  return {
    open(fileName, text, version) {
      if (disposed) return;
      documents.set(fileName, { text, version });
      refreshAmbientTypes(fileName);
    },

    update(fileName, text, version) {
      if (disposed) return;
      documents.set(fileName, { text, version });
      refreshAmbientTypes(fileName);
    },

    close(fileName) {
      documents.delete(fileName);
    },

    completion(fileName, position) {
      const offset = filePosition(fileName, position);
      if (offset === undefined) return { items: [] };
      const completions = service.getCompletionsAtPosition(fileName, offset, {
        includeCompletionsForModuleExports: true,
        includeCompletionsWithInsertText: true,
        includeAutomaticOptionalChainCompletions: true,
        includeCompletionsWithSnippetText: false,
      });
      if (!completions) return { items: [] };

      return {
        items: completions.entries
          .slice(0, MAX_COMPLETION_ENTRIES)
          .map((entry, index) =>
            toProtocolCompletion(
              entry,
              index < DOCUMENTED_ENTRIES
                ? completionEntryDocumentation(
                    service.getCompletionEntryDetails(
                      fileName,
                      offset,
                      entry.name,
                      {},
                      entry.source,
                      {},
                      entry.data,
                    ),
                  )
                : {},
            ),
          ),
      };
    },

    hover(fileName, position) {
      const offset = filePosition(fileName, position);
      if (offset === undefined) return { contents: null };
      return {
        contents: hoverToMarkdown(service.getQuickInfoAtPosition(fileName, offset)),
      };
    },

    signatureHelp(fileName, position) {
      const offset = filePosition(fileName, position);
      if (offset === undefined) return { signatures: [] };
      return signatureHelpFrom(
        service.getSignatureHelpItems(fileName, offset, {
          triggerReason: { kind: 'invoked' },
        }),
      );
    },

    diagnostics(fileName) {
      if (!documents.has(fileName)) return [];
      const sourceFile = service.getProgram()?.getSourceFile(fileName);
      if (!sourceFile) return [];
      const diagnostics = [
        ...service.getSyntacticDiagnostics(fileName),
        ...service.getSemanticDiagnostics(fileName),
      ];
      const markers: DiagnosticMarker[] = [];
      for (const diagnostic of diagnostics) {
        const marker = diagnosticToMarker(diagnostic, sourceFile);
        if (marker) markers.push(marker);
      }
      return markers;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      service.dispose();
      documents.clear();
    },
  };
}

export function ambientTypesFor(text: string): string {
  return buildLeetCodeAmbientTypes(text);
}
