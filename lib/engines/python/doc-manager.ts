import {
  PYTHON_PRELUDE,
  PYTHON_PRELUDE_LINE_COUNT,
  isPreludeRedeclarationDiagnostic,
} from './prelude';
import { createDocumentMapper } from '../shared/document-mapper';

const mapper = createDocumentMapper({
  prelude: PYTHON_PRELUDE,
  preludeLineCount: PYTHON_PRELUDE_LINE_COUNT,
  suppressDiagnostic: (_diagnostic, message) =>
    isPreludeRedeclarationDiagnostic(message),
});

export type { EngineRange } from '../shared/document-mapper';
export const {
  createEngineDocument,
  toEnginePosition,
  toEditorPosition,
  toEditorRange,
  diagnosticToMarker,
} = mapper;
