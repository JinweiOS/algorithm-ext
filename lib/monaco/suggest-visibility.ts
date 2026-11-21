/**
 * LeetCode narrows the suggest widget in some editor modes: with smart mode on,
 * `suggest.showMethods` / `showFunctions` can be off, and Monaco then hides
 * every suggestion whose kind is a method. For an array that leaves exactly one
 * row — `length` — because every other member of `any[]` is a method. The page
 * gets away with it only because its own answers are method-typed too.
 *
 * LeetSense answers with the engine's real member list, so the visibility
 * filters are pinned open on every property of the editor. Other `suggest`
 * settings the page passes are preserved.
 */
export const SUGGEST_VISIBILITY: Readonly<Record<string, true>> = {
  showMethods: true,
  showFunctions: true,
  showProperties: true,
  showFields: true,
  showVariables: true,
  showClasses: true,
  showStructs: true,
  showInterfaces: true,
  showModules: true,
  showConstructors: true,
  showEnums: true,
  showEnumMembers: true,
  showKeywords: true,
  showWords: true,
  showConstants: true,
  showEvents: true,
  showOperators: true,
  showTypeParameters: true,
  showSnippets: true,
  showColors: true,
  showFiles: true,
  showFolders: true,
  showReferences: true,
  showValues: true,
  showUnits: true,
  showIssues: true,
  showUsers: true,
};

/**
 * Merge the pinned visibility flags into whatever `suggest` object the page is
 * about to apply. Returns a fresh object so Monaco never sees a shared state.
 */
export function withSuggestVisibility(
  suggest: unknown,
): Record<string, unknown> {
  const base =
    typeof suggest === 'object' && suggest !== null
      ? (suggest as Record<string, unknown>)
      : {};
  return { ...base, ...SUGGEST_VISIBILITY };
}
