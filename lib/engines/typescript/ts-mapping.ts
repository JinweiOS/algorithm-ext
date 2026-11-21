import type * as ts from 'typescript';

import type {
  CompletionItem,
  DiagnosticMarker,
  SignatureHelpResult,
} from '../../../utils/protocol';

/**
 * LSP `CompletionItemKind` values. The page side maps these numbers back into
 * Monaco's own enum, so every engine speaks the same vocabulary regardless of
 * whether it is a real LSP server (Pyright, clangd) or the TypeScript compiler
 * API, which uses string element kinds instead.
 */
const COMPLETION_KIND = {
  text: 1,
  method: 2,
  function: 3,
  constructor: 4,
  field: 5,
  variable: 6,
  class: 7,
  interface: 8,
  module: 9,
  property: 10,
  enum: 13,
  keyword: 14,
  file: 17,
  folder: 19,
  enumMember: 20,
  constant: 21,
  typeParameter: 25,
} as const;

const ELEMENT_KIND_MAP: Record<string, number> = {
  script: COMPLETION_KIND.file,
  module: COMPLETION_KIND.module,
  class: COMPLETION_KIND.class,
  'local class': COMPLETION_KIND.class,
  interface: COMPLETION_KIND.interface,
  type: COMPLETION_KIND.interface,
  'primitive type': COMPLETION_KIND.interface,
  enum: COMPLETION_KIND.enum,
  'enum member': COMPLETION_KIND.enumMember,
  'member function': COMPLETION_KIND.method,
  method: COMPLETION_KIND.method,
  function: COMPLETION_KIND.function,
  'local function': COMPLETION_KIND.function,
  constructor: COMPLETION_KIND.constructor,
  property: COMPLETION_KIND.property,
  'member var': COMPLETION_KIND.field,
  getter: COMPLETION_KIND.property,
  setter: COMPLETION_KIND.property,
  var: COMPLETION_KIND.variable,
  'local var': COMPLETION_KIND.variable,
  let: COMPLETION_KIND.variable,
  const: COMPLETION_KIND.constant,
  using: COMPLETION_KIND.variable,
  parameter: COMPLETION_KIND.variable,
  'type parameter': COMPLETION_KIND.typeParameter,
  alias: COMPLETION_KIND.variable,
  keyword: COMPLETION_KIND.keyword,
  directory: COMPLETION_KIND.folder,
  label: COMPLETION_KIND.variable,
  string: COMPLETION_KIND.text,
};

export function completionKindForElementKind(elementKind: string): number {
  return ELEMENT_KIND_MAP[elementKind] ?? COMPLETION_KIND.text;
}

export function displayPartsToText(
  parts: readonly ts.SymbolDisplayPart[] | undefined,
): string {
  if (!parts || parts.length === 0) return '';
  return parts.map((part) => part.text).join('');
}

export function completionEntryDocumentation(
  entry: ts.CompletionEntryDetails | undefined,
): { detail?: string; documentation?: string } {
  if (!entry) return {};
  const signature = displayPartsToText(entry.displayParts).trim();
  const documentation = [
    displayPartsToText(entry.documentation).trim(),
    ...(entry.tags ?? []).map((tag) =>
      [tag.name, displayPartsToText(tag.text)].filter((value) => value.length > 0).join(' '),
    ),
  ]
    .filter((value) => value.length > 0)
    .join('\n\n');

  return {
    ...(signature ? { detail: signature } : {}),
    ...(documentation ? { documentation } : {}),
  };
}

export function hoverToMarkdown(info: ts.QuickInfo | undefined): string | null {
  if (!info) return null;
  const signature = displayPartsToText(info.displayParts).trim();
  const documentation = displayPartsToText(info.documentation).trim();
  const sections: string[] = [];
  if (signature) sections.push(['```typescript', signature, '```'].join('\n'));
  if (documentation) sections.push(documentation);
  return sections.length > 0 ? sections.join('\n\n') : null;
}

export function signatureHelpFrom(
  items: ts.SignatureHelpItems | undefined,
): SignatureHelpResult {
  if (!items || items.items.length === 0) return { signatures: [] };

  return {
    signatures: items.items.map((item) => {
      const prefix = displayPartsToText(item.prefixDisplayParts);
      const suffix = displayPartsToText(item.suffixDisplayParts);
      const separator = displayPartsToText(item.separatorDisplayParts);
      const parameters = item.parameters.map((parameter) => ({
        label: displayPartsToText(parameter.displayParts),
        ...(parameter.documentation
          ? { documentation: displayPartsToText(parameter.documentation) }
          : {}),
      }));
      return {
        label: `${prefix}${parameters.map((parameter) => parameter.label).join(separator)}${suffix}`,
        ...(displayPartsToText(item.documentation)
          ? { documentation: displayPartsToText(item.documentation) }
          : {}),
        ...(parameters.length > 0 ? { parameters } : {}),
      };
    }),
    ...(items.selectedItemIndex >= 0
      ? { activeSignature: items.selectedItemIndex }
      : {}),
    ...(items.argumentIndex >= 0 ? { activeParameter: items.argumentIndex } : {}),
  };
}

const SEVERITY: Record<number, DiagnosticMarker['severity']> = {
  1: 1,
  2: 2,
  3: 4,
  4: 3,
};

export function diagnosticToMarker(
  diagnostic: ts.Diagnostic,
  sourceFile: ts.SourceFile,
): DiagnosticMarker | null {
  if (diagnostic.start === undefined || diagnostic.length === undefined) {
    return null;
  }

  const start = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  const end = sourceFile.getLineAndCharacterOfPosition(
    diagnostic.start + diagnostic.length,
  );

  return {
    startLine: start.line,
    startCol: start.character,
    endLine: end.line,
    endCol: end.character,
    severity: SEVERITY[diagnostic.category] ?? 3,
    message: flattenDiagnosticMessage(diagnostic, sourceFile),
    ...(diagnostic.code === undefined ? {} : { code: `TS${diagnostic.code}` }),
  };
}

function flattenDiagnosticMessage(
  diagnostic: ts.Diagnostic,
  sourceFile: ts.SourceFile,
): string {
  const message = typeof diagnostic.messageText === 'string'
    ? diagnostic.messageText
    : flattenChain(diagnostic.messageText);
  const related = (diagnostic.relatedInformation ?? [])
    .map((info) => {
      const text = typeof info.messageText === 'string'
        ? info.messageText
        : flattenChain(info.messageText);
      return text;
    })
    .filter((text) => text.length > 0);
  return [message, ...related].join('\n');
}

function flattenChain(chain: ts.DiagnosticMessageChain): string {
  const head = chain.messageText;
  const nested = (chain.next ?? []).map(flattenChain).join(' ');
  return nested ? `${head} ${nested}` : head;
}

export function toProtocolCompletion(
  entry: ts.CompletionEntry,
  documentation: { detail?: string; documentation?: string },
): CompletionItem {
  return {
    label: entry.name,
    kind: completionKindForElementKind(entry.kind),
    ...(entry.insertText && entry.insertText !== entry.name
      ? { insertText: entry.insertText }
      : {}),
    ...(entry.sortText ? { sortText: entry.sortText } : {}),
    ...documentation,
  };
}
