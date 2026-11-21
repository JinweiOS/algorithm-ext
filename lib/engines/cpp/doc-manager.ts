import { createDocumentMapper } from '../shared/document-mapper';
import {
  CPP_PRELUDE,
  CPP_PRELUDE_LINE_COUNT,
  isCppPreludeDiagnostic,
} from './prelude';

const mapper = createDocumentMapper({
  prelude: CPP_PRELUDE,
  preludeLineCount: CPP_PRELUDE_LINE_COUNT,
  suppressDiagnostic: (diagnostic, message) => {
    if (isCppPreludeDiagnostic(message)) return true;

    // clang may attribute a broken implicit/include lookup to the first line of
    // the user document. Do not hide ordinary user errors at that boundary.
    const normalized = message.toLowerCase();
    return (
      diagnostic.range.start.line <= CPP_PRELUDE_LINE_COUNT + 1 &&
      (normalized.includes('file not found') ||
        normalized.includes('header file') ||
        normalized.includes('could not build module'))
    );
  },
});

export type { EngineRange } from '../shared/document-mapper';
export const {
  createEngineDocument,
  toEnginePosition,
  toEditorPosition,
  toEditorRange,
  diagnosticToMarker,
} = mapper;
