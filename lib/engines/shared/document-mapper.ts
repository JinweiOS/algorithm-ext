import type { Diagnostic } from 'vscode-languageserver-protocol';

import type {
  DiagnosticMarker,
  PositionParams,
} from '../../../utils/protocol';

export interface EngineRange {
  start: PositionParams;
  end: PositionParams;
}

export interface DocumentMapperOptions {
  prelude: string;
  preludeLineCount: number;
  suppressDiagnostic?: (diagnostic: Diagnostic, message: string) => boolean;
}

export interface DocumentMapper {
  createEngineDocument(editorText: string): string;
  toEnginePosition(position: PositionParams): PositionParams;
  toEditorPosition(position: PositionParams): PositionParams | null;
  toEditorRange(range: EngineRange): EngineRange | null;
  diagnosticToMarker(diagnostic: Diagnostic): DiagnosticMarker | null;
}

export function createDocumentMapper(
  options: DocumentMapperOptions,
): DocumentMapper {
  function createEngineDocument(editorText: string): string {
    return `${options.prelude}${editorText}`;
  }

  function toEnginePosition(position: PositionParams): PositionParams {
    return {
      line: position.line + options.preludeLineCount,
      character: position.character,
    };
  }

  function toEditorPosition(
    position: PositionParams,
  ): PositionParams | null {
    if (position.line < options.preludeLineCount) return null;
    return {
      line: position.line - options.preludeLineCount,
      character: position.character,
    };
  }

  function toEditorRange(range: EngineRange): EngineRange | null {
    const start = toEditorPosition(range.start);
    const end = toEditorPosition(range.end);
    if (!start || !end) return null;
    return { start, end };
  }

  function diagnosticToMarker(
    diagnostic: Diagnostic,
  ): DiagnosticMarker | null {
    const message =
      typeof diagnostic.message === 'string'
        ? diagnostic.message
        : diagnostic.message.value;
    if (options.suppressDiagnostic?.(diagnostic, message)) return null;

    const range = toEditorRange(diagnostic.range);
    if (!range) return null;

    const severity =
      diagnostic.severity === 1 ||
      diagnostic.severity === 2 ||
      diagnostic.severity === 3 ||
      diagnostic.severity === 4
        ? diagnostic.severity
        : 3;
    const code =
      typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
        ? String(diagnostic.code)
        : undefined;

    return {
      startLine: range.start.line,
      startCol: range.start.character,
      endLine: range.end.line,
      endCol: range.end.character,
      severity,
      message,
      ...(code ? { code } : {}),
    };
  }

  return {
    createEngineDocument,
    toEnginePosition,
    toEditorPosition,
    toEditorRange,
    diagnosticToMarker,
  };
}
