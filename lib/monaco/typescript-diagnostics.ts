export interface Disposable {
  dispose(): void;
}

export interface TypeScriptDiagnosticsOptions {
  noSemanticValidation?: boolean;
  noSyntaxValidation?: boolean;
  noSuggestionDiagnostics?: boolean;
  [key: string]: unknown;
}

export interface TypeScriptLanguageDefaults {
  getDiagnosticsOptions(): TypeScriptDiagnosticsOptions;
  setDiagnosticsOptions(options: TypeScriptDiagnosticsOptions): void;
}

export interface TypeScriptLanguageApi {
  typescriptDefaults: TypeScriptLanguageDefaults;
  javascriptDefaults: TypeScriptLanguageDefaults;
}

/**
 * LeetSense answers JavaScript and TypeScript itself, so Monaco's bundled
 * TypeScript worker must stop publishing markers — otherwise every mistake gets
 * two squiggles from two engines. Validation stays off even when the page later
 * calls `setDiagnosticsOptions` again, which LeetCode does on language changes.
 */
const FORCED_OFF: TypeScriptDiagnosticsOptions = {
  noSemanticValidation: true,
  noSyntaxValidation: true,
  noSuggestionDiagnostics: true,
};

interface DefaultsInstallation {
  readonly defaults: TypeScriptLanguageDefaults;
  readonly originalSetDiagnosticsOptions: TypeScriptLanguageDefaults['setDiagnosticsOptions'];
  readonly wrappedSetDiagnosticsOptions: TypeScriptLanguageDefaults['setDiagnosticsOptions'];
  readonly latestPageOptions: () => TypeScriptDiagnosticsOptions;
}

export function disableMonacoTypeScriptDiagnostics(
  api: TypeScriptLanguageApi,
): Disposable {
  const installations = [
    installDefaults(api.typescriptDefaults),
    installDefaults(api.javascriptDefaults),
  ];

  return {
    dispose() {
      for (const installation of installations) {
        if (
          installation.defaults.setDiagnosticsOptions ===
          installation.wrappedSetDiagnosticsOptions
        ) {
          installation.defaults.setDiagnosticsOptions =
            installation.originalSetDiagnosticsOptions;
        }
        // Hand the page's own last-known settings back, not our forced ones.
        installation.originalSetDiagnosticsOptions.call(
          installation.defaults,
          installation.latestPageOptions(),
        );
      }
    },
  };
}

function installDefaults(
  defaults: TypeScriptLanguageDefaults,
): DefaultsInstallation {
  const originalSetDiagnosticsOptions = defaults.setDiagnosticsOptions;
  let latestPageOptions = cloneOptions(defaults.getDiagnosticsOptions());

  function wrappedSetDiagnosticsOptions(
    options: TypeScriptDiagnosticsOptions,
  ): void {
    latestPageOptions = cloneOptions(options);
    originalSetDiagnosticsOptions.call(defaults, forceOff(options));
  }

  defaults.setDiagnosticsOptions = wrappedSetDiagnosticsOptions;
  originalSetDiagnosticsOptions.call(defaults, forceOff(latestPageOptions));

  return {
    defaults,
    originalSetDiagnosticsOptions,
    wrappedSetDiagnosticsOptions,
    latestPageOptions: () => cloneOptions(latestPageOptions),
  };
}

function forceOff(
  options: TypeScriptDiagnosticsOptions,
): TypeScriptDiagnosticsOptions {
  return { ...options, ...FORCED_OFF };
}

function cloneOptions(
  options: TypeScriptDiagnosticsOptions,
): TypeScriptDiagnosticsOptions {
  return { ...options };
}

export function buildLeetCodeAmbientTypes(userSource = ''): string {
  const sourceWithoutComments = stripComments(userSource);
  const declarations = [
    ambientDeclaration(
      'ListNode',
      `interface ListNode {
  val: number;
  next: ListNode | null;
}`,
      `declare var ListNode: {
  new (val?: number, next?: ListNode | null): ListNode;
};`,
      sourceWithoutComments,
    ),
    ambientDeclaration(
      'TreeNode',
      `interface TreeNode {
  val: number;
  left: TreeNode | null;
  right: TreeNode | null;
}`,
      `declare var TreeNode: {
  new (
    val?: number,
    left?: TreeNode | null,
    right?: TreeNode | null,
  ): TreeNode;
};`,
      sourceWithoutComments,
    ),
    ambientDeclaration(
      'Node',
      `interface Node {
  val: number;
  neighbors: Node[];
  next: Node | null;
  random: Node | null;
  children: Node[];
  left: Node | null;
  right: Node | null;
}`,
      undefined,
      sourceWithoutComments,
    ),
  ].filter((declaration): declaration is string => declaration !== undefined);

  return `${declarations.join('\n\n')}\n`;
}

function ambientDeclaration(
  name: string,
  typeDeclaration: string,
  valueDeclaration: string | undefined,
  userSource: string,
): string | undefined {
  if (hasDeclaration(userSource, ['class', 'interface', 'type', 'enum'], name)) {
    return undefined;
  }

  if (
    hasDeclaration(
      userSource,
      ['class', 'function', 'const', 'let', 'var', 'enum'],
      name,
    )
  ) {
    return typeDeclaration;
  }

  return valueDeclaration
    ? `${typeDeclaration}\n${valueDeclaration}`
    : typeDeclaration;
}

function hasDeclaration(
  source: string,
  keywords: string[],
  name: string,
): boolean {
  return new RegExp(`\\b(?:${keywords.join('|')})\\s+${name}\\b`).test(source);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
