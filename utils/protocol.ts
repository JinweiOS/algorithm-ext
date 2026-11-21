export const BRIDGE_CHANNEL = 'LEETSENSE_BRIDGE' as const;
export const ENGINE_PORT_NAME = 'lsp' as const;

export const MAX_DOCUMENT_LENGTH = 2_000_000;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_COMPLETION_ITEMS = 2_000;
export const MAX_DIAGNOSTICS = 1_000;
export const MAX_STATUS_DETAIL_LENGTH = 500;
export const LANGUAGE_IDS = [
  'python3',
  'python',
  'cpp',
  'javascript',
  'typescript',
] as const;
export const ENGINE_LANGUAGE_IDS = [
  'python3',
  'cpp',
  'javascript',
  'typescript',
] as const;
/**
 * Languages that own an editor service surfaced by the status indicator.
 * Every one of them is answered by a LeetSense engine; JavaScript and
 * TypeScript share one TypeScript service implementation but keep separate
 * document sessions because they are checked with different compiler options.
 */
export const STATUS_LANGUAGE_IDS = [
  'python3',
  'cpp',
  'javascript',
  'typescript',
] as const;
export const LSP_CONTROL_ACTIONS = ['stop', 'start', 'restart'] as const;
export const ENGINE_STATUS_STATES = [
  'starting',
  'ready',
  'restarting',
  'unavailable',
  'stopped',
  'off',
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];
export type EngineLanguageId = (typeof ENGINE_LANGUAGE_IDS)[number];
export type StatusLanguageId = (typeof STATUS_LANGUAGE_IDS)[number];
export type LspControlAction = (typeof LSP_CONTROL_ACTIONS)[number];
export type EngineStatusState = (typeof ENGINE_STATUS_STATES)[number];

const MAX_LABEL_LENGTH = 1_000;
const MAX_DETAIL_LENGTH = 4_000;
const MAX_DOCUMENTATION_LENGTH = 20_000;
const MAX_INSERT_TEXT_LENGTH = 20_000;
const MAX_SORT_TEXT_LENGTH = 1_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 20_000;
const MAX_DIAGNOSTIC_CODE_LENGTH = 1_000;
const MAX_SIGNATURES = 100;
const MAX_PARAMETERS = 100;
const MAX_EXTERNAL_URL_LENGTH = 500;

export interface PositionParams {
  line: number;
  character: number;
}

export interface DocumentSyncParams {
  language: LanguageId;
  text: string;
  version: number;
}

export interface FeatureParams extends PositionParams {
  language: LanguageId;
}

export interface CompletionItem {
  label: string;
  kind: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
  filterText?: string;
  insertTextFormat?: 1 | 2;
}

export interface CompletionResult {
  items: CompletionItem[];
}

export interface HoverResult {
  contents: string | null;
}

export interface SignatureParameter {
  label: string | [number, number];
  documentation?: string;
}

export interface SignatureInformation {
  label: string;
  documentation?: string;
  parameters?: SignatureParameter[];
}

export interface SignatureHelpResult {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

export type FeatureResult = CompletionResult | HoverResult | SignatureHelpResult;

export type DiagnosticSeverity = 1 | 2 | 3 | 4;

export interface DiagnosticMarker {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  severity: DiagnosticSeverity;
  message: string;
  code?: string;
}

export interface DiagnosticsParams {
  uriVersion: number;
  markers: DiagnosticMarker[];
}

interface BridgeRequestBase {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'TO_EXTENSION';
}

interface CorrelatedBridgeRequest extends BridgeRequestBase {
  requestId: string;
}

export interface BridgeCompletionRequest extends CorrelatedBridgeRequest {
  type: 'COMPLETION';
  payload: FeatureParams;
}

export interface BridgeHoverRequest extends CorrelatedBridgeRequest {
  type: 'HOVER';
  payload: FeatureParams;
}

export interface BridgeSignatureHelpRequest extends CorrelatedBridgeRequest {
  type: 'SIGNATURE_HELP';
  payload: FeatureParams;
}

export interface BridgeDocumentSyncRequest extends BridgeRequestBase {
  type: 'DOC_SYNC';
  payload: DocumentSyncParams;
}

export interface BridgePing extends CorrelatedBridgeRequest {
  type: 'PING';
}

export interface LspControlParams {
  language: EngineLanguageId;
  action: LspControlAction;
}

export interface BridgeLspControlRequest extends CorrelatedBridgeRequest {
  type: 'LSP_CONTROL';
  payload: LspControlParams;
}

export interface BridgeReviewPromptClaimRequest extends CorrelatedBridgeRequest {
  type: 'REVIEW_PROMPT_CLAIM';
}

/**
 * Reports the state of an editor service that LeetSense renders but does not
 * own (currently Monaco's bundled TypeScript worker). The bridge turns it into
 * the same toolbar-icon transition the engines use.
 */
export interface BridgeServiceStateRequest extends BridgeRequestBase {
  type: 'SERVICE_STATE';
  payload: ServiceStateParams;
}

export interface ServiceStateParams {
  language: StatusLanguageId;
  active: boolean;
}

export type BridgeRequest =
  | BridgeCompletionRequest
  | BridgeHoverRequest
  | BridgeSignatureHelpRequest
  | BridgeDocumentSyncRequest
  | BridgeLspControlRequest
  | BridgeServiceStateRequest
  | BridgeReviewPromptClaimRequest
  | BridgePing;

export interface BridgeResponse {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'FROM_EXTENSION';
  requestId: string;
  response?: FeatureResult;
  error?: string;
  pong?: true;
}

export interface BridgeDiagnosticsPush {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'FROM_EXTENSION';
  type: 'DIAGNOSTICS';
  payload: DiagnosticsParams;
}

export interface EngineStatusParams {
  language: LanguageId;
  state: EngineStatusState;
  detail?: string;
}

export interface BridgeStatusPush extends EngineStatusParams {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'FROM_EXTENSION';
  type: 'STATUS';
}

export interface BridgeLspControlResult {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'FROM_EXTENSION';
  requestId: string;
  type: 'LSP_CONTROL_RESULT';
  payload: LspControlParams;
  error?: string;
}

export interface BridgeReviewPromptEligible {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'FROM_EXTENSION';
  type: 'REVIEW_PROMPT_ELIGIBLE';
}

export interface BridgeReviewPromptClaimResult {
  channel: typeof BRIDGE_CHANNEL;
  direction: 'FROM_EXTENSION';
  requestId: string;
  type: 'REVIEW_PROMPT_CLAIM_RESULT';
  payload: {
    claimed: boolean;
    reviewUrl?: string;
  };
}

export type BridgeIncomingFrame =
  | BridgeResponse
  | BridgeDiagnosticsPush
  | BridgeStatusPush
  | BridgeLspControlResult
  | BridgeReviewPromptEligible
  | BridgeReviewPromptClaimResult;

export interface EnsureOffscreenMessage {
  type: 'ENSURE_OFFSCREEN';
}

export type EnsureOffscreenResponse =
  | { ok: true }
  | { ok: false; error: string };

export interface ReviewPromptRuntimeMessage {
  type: 'REVIEW_PROMPT';
  action: 'qualified-session' | 'claim';
}

export type ReviewPromptRuntimeResponse =
  | { ok: true; eligible: boolean }
  | { ok: true; claimed: boolean; reviewUrl?: string }
  | { ok: false; error: string };

export interface OffscreenIdleControlMessage {
  type: 'OFFSCREEN_IDLE';
  action: 'candidate' | 'probe';
}

/**
 * Sent by the content bridge whenever a language service starts or stops so the
 * toolbar icon can switch between the grey (inactive) and colour (active)
 * artwork.
 */
export interface ActionStateMessage {
  type: 'ACTION_STATE';
  language: StatusLanguageId;
  active: boolean;
}

export interface OffscreenIdleProbeResponse {
  idle: boolean;
}

export interface EngineFeatureRequest {
  id: string;
  language: LanguageId;
  method: 'completion' | 'hover' | 'signatureHelp';
  params: PositionParams;
}

export interface EngineDocumentSyncRequest {
  language: LanguageId;
  method: 'docSync';
  params: Omit<DocumentSyncParams, 'language'>;
}

export interface EngineControlRequest extends LspControlParams {
  id: string;
  method: 'control';
}

export type EngineRequest =
  | EngineFeatureRequest
  | EngineDocumentSyncRequest
  | EngineControlRequest;

export interface EngineResponse {
  id: string;
  result?: FeatureResult;
  error?: string;
}

export interface EngineDiagnosticsPush {
  method: 'diagnostics';
  params: DiagnosticsParams;
}

export interface EngineStatusPush extends EngineStatusParams {
  type: 'STATUS';
}

export interface EngineControlAck extends LspControlParams {
  id: string;
  type: 'CONTROL_ACK';
  error?: string;
}

export type EngineFrame =
  | EngineRequest
  | EngineResponse
  | EngineDiagnosticsPush
  | EngineStatusPush
  | EngineControlAck;

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (
    !isRecord(value) ||
    value.channel !== BRIDGE_CHANNEL ||
    value.direction !== 'TO_EXTENSION'
  ) {
    return false;
  }

  if (value.type === 'DOC_SYNC') return isDocumentSyncParams(value.payload);
  if (value.type === 'SERVICE_STATE') return isServiceStateParams(value.payload);
  if (!isRequestId(value.requestId)) return false;
  if (value.type === 'PING') return true;
  if (value.type === 'REVIEW_PROMPT_CLAIM') return true;
  if (value.type === 'LSP_CONTROL') return isLspControlParams(value.payload);

  return (
    (value.type === 'COMPLETION' ||
      value.type === 'HOVER' ||
      value.type === 'SIGNATURE_HELP') &&
    isFeatureParams(value.payload)
  );
}

export function isBridgeIncomingFrame(
  value: unknown,
): value is BridgeIncomingFrame {
  return (
    isBridgeResponse(value) ||
    isBridgeDiagnosticsPush(value) ||
    isBridgeStatusPush(value) ||
    isBridgeLspControlResult(value) ||
    isBridgeReviewPromptEligible(value) ||
    isBridgeReviewPromptClaimResult(value)
  );
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  return (
    isRecord(value) &&
    value.channel === BRIDGE_CHANNEL &&
    value.direction === 'FROM_EXTENSION' &&
    isRequestId(value.requestId) &&
    ((value.response !== undefined && isFeatureResult(value.response)) ||
      isBoundedString(value.error, MAX_DIAGNOSTIC_MESSAGE_LENGTH) ||
      value.pong === true)
  );
}

export function isBridgeDiagnosticsPush(
  value: unknown,
): value is BridgeDiagnosticsPush {
  return (
    isRecord(value) &&
    value.channel === BRIDGE_CHANNEL &&
    value.direction === 'FROM_EXTENSION' &&
    value.type === 'DIAGNOSTICS' &&
    isDiagnosticsParams(value.payload)
  );
}

export function isBridgeStatusPush(value: unknown): value is BridgeStatusPush {
  return (
    isRecord(value) &&
    value.channel === BRIDGE_CHANNEL &&
    value.direction === 'FROM_EXTENSION' &&
    value.type === 'STATUS' &&
    isEngineStatusParams(value)
  );
}

export function isBridgeLspControlResult(
  value: unknown,
): value is BridgeLspControlResult {
  return (
    isRecord(value) &&
    value.channel === BRIDGE_CHANNEL &&
    value.direction === 'FROM_EXTENSION' &&
    value.type === 'LSP_CONTROL_RESULT' &&
    isRequestId(value.requestId) &&
    isLspControlParams(value.payload) &&
    isOptionalBoundedString(value.error, MAX_DIAGNOSTIC_MESSAGE_LENGTH)
  );
}

export function isBridgeReviewPromptEligible(
  value: unknown,
): value is BridgeReviewPromptEligible {
  return (
    isRecord(value) &&
    value.channel === BRIDGE_CHANNEL &&
    value.direction === 'FROM_EXTENSION' &&
    value.type === 'REVIEW_PROMPT_ELIGIBLE'
  );
}

export function isBridgeReviewPromptClaimResult(
  value: unknown,
): value is BridgeReviewPromptClaimResult {
  if (
    !isRecord(value) ||
    value.channel !== BRIDGE_CHANNEL ||
    value.direction !== 'FROM_EXTENSION' ||
    value.type !== 'REVIEW_PROMPT_CLAIM_RESULT' ||
    !isRequestId(value.requestId) ||
    !isRecord(value.payload) ||
    typeof value.payload.claimed !== 'boolean'
  ) {
    return false;
  }
  return (
    isOptionalBoundedString(value.payload.reviewUrl, MAX_EXTERNAL_URL_LENGTH) &&
    (!value.payload.claimed || value.payload.reviewUrl !== undefined)
  );
}

export function isReviewPromptRuntimeMessage(
  value: unknown,
): value is ReviewPromptRuntimeMessage {
  return (
    isRecord(value) &&
    value.type === 'REVIEW_PROMPT' &&
    (value.action === 'qualified-session' || value.action === 'claim')
  );
}

export function isActionStateMessage(
  value: unknown,
): value is ActionStateMessage {
  return (
    isRecord(value) &&
    value.type === 'ACTION_STATE' &&
    isStatusLanguageId(value.language) &&
    typeof value.active === 'boolean'
  );
}

export function isReviewPromptRuntimeResponse(
  value: unknown,
): value is ReviewPromptRuntimeResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) {
    return isBoundedString(value.error, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
  }
  if (typeof value.eligible === 'boolean') return true;
  return (
    typeof value.claimed === 'boolean' &&
    isOptionalBoundedString(value.reviewUrl, MAX_EXTERNAL_URL_LENGTH) &&
    (!value.claimed || value.reviewUrl !== undefined)
  );
}

export function isEngineRequest(value: unknown): value is EngineRequest {
  if (!isRecord(value)) return false;

  if (value.method === 'docSync') {
    return isLanguageId(value.language) && isEngineDocumentSyncParams(value.params);
  }

  if (value.method === 'control') {
    return (
      isRequestId(value.id) &&
      isEngineLanguageId(value.language) &&
      isLspControlAction(value.action)
    );
  }

  return (
    isRequestId(value.id) &&
    isLanguageId(value.language) &&
    (value.method === 'completion' ||
      value.method === 'hover' ||
      value.method === 'signatureHelp') &&
    isPositionParams(value.params)
  );
}

export function isOffscreenIdleControlMessage(
  value: unknown,
): value is OffscreenIdleControlMessage {
  return (
    isRecord(value) &&
    value.type === 'OFFSCREEN_IDLE' &&
    (value.action === 'candidate' || value.action === 'probe')
  );
}

export function isEngineResponse(value: unknown): value is EngineResponse {
  return (
    isRecord(value) &&
    isRequestId(value.id) &&
    ((value.result !== undefined && isFeatureResult(value.result)) ||
      isBoundedString(value.error, MAX_DIAGNOSTIC_MESSAGE_LENGTH))
  );
}

export function isEngineDiagnosticsPush(
  value: unknown,
): value is EngineDiagnosticsPush {
  return (
    isRecord(value) &&
    value.method === 'diagnostics' &&
    isDiagnosticsParams(value.params)
  );
}

export function isEngineStatusPush(value: unknown): value is EngineStatusPush {
  return (
    isRecord(value) &&
    value.type === 'STATUS' &&
    isEngineStatusParams(value)
  );
}

export function isEngineControlAck(value: unknown): value is EngineControlAck {
  return (
    isRecord(value) &&
    value.type === 'CONTROL_ACK' &&
    isRequestId(value.id) &&
    isEngineLanguageId(value.language) &&
    isLspControlAction(value.action) &&
    isOptionalBoundedString(value.error, MAX_DIAGNOSTIC_MESSAGE_LENGTH)
  );
}

export function isEngineFrame(value: unknown): value is EngineFrame {
  return (
    isEngineRequest(value) ||
    isEngineResponse(value) ||
    isEngineDiagnosticsPush(value) ||
    isEngineStatusPush(value) ||
    isEngineControlAck(value)
  );
}

function isEngineStatusParams(value: Record<string, unknown>): boolean {
  return (
    isLanguageId(value.language) &&
    isEngineStatusState(value.state) &&
    isOptionalBoundedString(value.detail, MAX_STATUS_DETAIL_LENGTH)
  );
}

function isEngineStatusState(value: unknown): value is EngineStatusState {
  return ENGINE_STATUS_STATES.includes(value as EngineStatusState);
}

function isFeatureResult(value: unknown): value is FeatureResult {
  return (
    isCompletionResult(value) ||
    isHoverResult(value) ||
    isSignatureHelpResult(value)
  );
}

function isCompletionResult(value: unknown): value is CompletionResult {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_COMPLETION_ITEMS &&
    value.items.every(isCompletionItem)
  );
}

function isCompletionItem(value: unknown): value is CompletionItem {
  return (
    isRecord(value) &&
    isBoundedString(value.label, MAX_LABEL_LENGTH) &&
    isPositiveInteger(value.kind) &&
    isOptionalBoundedString(value.detail, MAX_DETAIL_LENGTH) &&
    isOptionalBoundedString(value.documentation, MAX_DOCUMENTATION_LENGTH) &&
    isOptionalBoundedString(value.insertText, MAX_INSERT_TEXT_LENGTH) &&
    isOptionalBoundedString(value.sortText, MAX_SORT_TEXT_LENGTH) &&
    isOptionalBoundedString(value.filterText, MAX_SORT_TEXT_LENGTH) &&
    (value.insertTextFormat === undefined ||
      value.insertTextFormat === 1 ||
      value.insertTextFormat === 2)
  );
}

function isHoverResult(value: unknown): value is HoverResult {
  return (
    isRecord(value) &&
    (value.contents === null ||
      isBoundedString(value.contents, MAX_DOCUMENTATION_LENGTH))
  );
}

function isSignatureHelpResult(value: unknown): value is SignatureHelpResult {
  return (
    isRecord(value) &&
    Array.isArray(value.signatures) &&
    value.signatures.length <= MAX_SIGNATURES &&
    value.signatures.every(isSignatureInformation) &&
    isOptionalIndex(value.activeSignature) &&
    isOptionalIndex(value.activeParameter)
  );
}

function isSignatureInformation(value: unknown): value is SignatureInformation {
  return (
    isRecord(value) &&
    isBoundedString(value.label, MAX_LABEL_LENGTH) &&
    isOptionalBoundedString(value.documentation, MAX_DOCUMENTATION_LENGTH) &&
    (value.parameters === undefined ||
      (Array.isArray(value.parameters) &&
        value.parameters.length <= MAX_PARAMETERS &&
        value.parameters.every(isSignatureParameter)))
  );
}

function isSignatureParameter(value: unknown): value is SignatureParameter {
  return (
    isRecord(value) &&
    (isBoundedString(value.label, MAX_LABEL_LENGTH) ||
      (Array.isArray(value.label) &&
        value.label.length === 2 &&
        isPosition(value.label[0]) &&
        isPosition(value.label[1]))) &&
    isOptionalBoundedString(value.documentation, MAX_DOCUMENTATION_LENGTH)
  );
}

function isDiagnosticsParams(value: unknown): value is DiagnosticsParams {
  return (
    isRecord(value) &&
    isPosition(value.uriVersion) &&
    Array.isArray(value.markers) &&
    value.markers.length <= MAX_DIAGNOSTICS &&
    value.markers.every(isDiagnosticMarker)
  );
}

function isDiagnosticMarker(value: unknown): value is DiagnosticMarker {
  return (
    isRecord(value) &&
    isPosition(value.startLine) &&
    isPosition(value.startCol) &&
    isPosition(value.endLine) &&
    isPosition(value.endCol) &&
    (value.severity === 1 ||
      value.severity === 2 ||
      value.severity === 3 ||
      value.severity === 4) &&
    isBoundedString(value.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH) &&
    isOptionalBoundedString(value.code, MAX_DIAGNOSTIC_CODE_LENGTH)
  );
}

function isDocumentSyncParams(value: unknown): value is DocumentSyncParams {
  return (
    isRecord(value) &&
    isLanguageId(value.language) &&
    isBoundedString(value.text, MAX_DOCUMENT_LENGTH) &&
    isPosition(value.version)
  );
}

function isPositionParams(value: unknown): value is PositionParams {
  return (
    isRecord(value) &&
    isPosition(value.line) &&
    isPosition(value.character)
  );
}

function isFeatureParams(value: unknown): value is FeatureParams {
  return isRecord(value) && isLanguageId(value.language) && isPositionParams(value);
}

function isLspControlParams(value: unknown): value is LspControlParams {
  return (
    isRecord(value) &&
    isEngineLanguageId(value.language) &&
    isLspControlAction(value.action)
  );
}

function isEngineDocumentSyncParams(
  value: unknown,
): value is Omit<DocumentSyncParams, 'language'> {
  return (
    isRecord(value) &&
    isBoundedString(value.text, MAX_DOCUMENT_LENGTH) &&
    isPosition(value.version)
  );
}

export function isLanguageId(value: unknown): value is LanguageId {
  return (
    typeof value === 'string' &&
    (LANGUAGE_IDS as readonly string[]).includes(value)
  );
}

export function isEngineLanguageId(value: unknown): value is EngineLanguageId {
  return (
    typeof value === 'string' &&
    (ENGINE_LANGUAGE_IDS as readonly string[]).includes(value)
  );
}

export function isStatusLanguageId(value: unknown): value is StatusLanguageId {
  return (
    typeof value === 'string' &&
    (STATUS_LANGUAGE_IDS as readonly string[]).includes(value)
  );
}

function isServiceStateParams(value: unknown): value is ServiceStateParams {
  return (
    isRecord(value) &&
    isStatusLanguageId(value.language) &&
    typeof value.active === 'boolean'
  );
}

export function isLspControlAction(value: unknown): value is LspControlAction {
  return value === 'stop' || value === 'start' || value === 'restart';
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH
  );
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || isBoundedString(value, max);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isOptionalIndex(value: unknown): boolean {
  return value === undefined || isPosition(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
