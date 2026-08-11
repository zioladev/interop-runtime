// @zioladev/interop-runtime — public surface.
//
// The multi-provider interoperability RUNTIME: it measures multi-step TRAJECTORIES across
// WebMCP providers — lineage-bearing carried state, terminal-state predicates, and cross-model
// comparison — and attributes any failure to the layer that caused it. It builds on the
// single-decision measurement language proven in @zioladev/provider-conformance (Phase II); to
// keep the two packages independently functional, the small, stable primitives it needs
// (attribution engine, execution bridge, reference runtime, model adapters, core types) are
// re-authored here rather than imported, so this package takes NO dependency on that one. See
// DUPLICATION-LEDGER.md for the shared-candidate list. Clean-room: imports nothing from
// @selvage/* or any proprietary source. See docs/.

export type {
  Effect,
  JsonSchema,
  ToolDef,
  NormalizedTool,
  ExecutionResult,
  AdapterError,
  ConsumerDecision,
  ArgBinding,
  TaskSpec,
  PlanInput,
  PriorStep,
  ModelConsumerAdapter,
  Outcome,
  ActionDisposition,
  AttributionCategory,
  Verdict,
  StepResults,
  PathObservation,
  AttributionEntry,
  PathDerived,
  DivergenceKind,
  DivergenceResult,
  ConformanceCase,
  ProviderRef,
  CarriedValue,
} from './types.ts';
export { PROVIDER_OWNED } from './types.ts';

// --- Re-authored single-decision primitives (the per-step layer every trajectory step uses) ---
export { evaluatePath, evaluateDivergence, evaluateCase, providerGrade } from './engine.ts';
export { validateDefinition, validateProvider, validateInput, normalizeDiscovered } from './normalize.ts';
export { ReferenceRuntime, REFERENCE_RUNTIME_ID } from './reference-runtime.ts';
export type { RegisteredTool, RuntimeTool, WebMcpRuntime } from './reference-runtime.ts';
export { discover, execute } from './bridge.ts';
export type { BridgeOutcome } from './bridge.ts';
export { makeScriptedAdapter, makeScriptedTrajectoryAdapter } from './adapters/scripted.ts';
export type { ScriptedAdapterConfig, ScriptedTrajectoryConfig } from './adapters/scripted.ts';
export { makeClaudeAdapter, anthropicFetchTransport, staticAnthropicTransport } from './adapters/claude.ts';
export type { ClaudeAdapterConfig, AnthropicTransport, AnthropicRequest, AnthropicResponse, AnthropicContentBlock } from './adapters/claude.ts';
export { makeGptAdapter, openaiFetchTransport, staticOpenAiTransport } from './adapters/gpt.ts';
export type { GptAdapterConfig, OpenAiTransport, OpenAiRequest, OpenAiResponse, OpenAiToolCall, OpenAiMessage } from './adapters/gpt.ts';
export { makeGeminiAdapter, geminiFetchTransport, staticGeminiTransport, cleanSchemaForGemini } from './adapters/gemini.ts';
export type { GeminiAdapterConfig, GeminiTransport, GeminiRequest, GeminiResponse, GeminiPart, GeminiFunctionDeclaration } from './adapters/gemini.ts';
export { runPath, runPathOnRuntime, buildCase, buildCaseOnRuntime, observeDecisionOnRuntime } from './run-case.ts';
export type { ProviderTool, ProviderUnderTest, ObservationContext } from './run-case.ts';
export { TRAJECTORY_REPORT_VERSION, REPORT_GENERATOR, REPORT_GENERATOR_VERSION } from './report-version.ts';

// --- The trajectory layer (report contract /2) — single provider (3A) ---
export {
  runTrajectory,
  runTrajectoryOnRuntime,
  buildTrajectoryCase,
  buildTrajectoryCaseOnRuntime,
  evaluateTrajectory,
  evaluateTrajectoryCase,
  evaluateTrajectoryDivergence,
} from './trajectory.ts';
export type {
  TerminalState,
  TrajectoryInvariant,
  TrajectorySpec,
  TrajectoryStepRecord,
  TrajectoryState,
  TrajectoryObservation,
  InvariantResult,
  TrajectoryDerived,
  TrajectoryDivergenceResult,
  TrajectoryCase,
} from './trajectory.ts';
export { assembleTrajectoryReport } from './trajectory-report.ts';
export type { TrajectoryReportInput, TrajectoryConformanceReport } from './trajectory-report.ts';

// --- Multi-provider (3B): lineage-bearing carried state across providers ---
export {
  makeReferenceSurfaceResolver,
  runMultiProviderTrajectory,
  runMultiProviderTrajectoryOnReference,
  evaluateMultiProviderTrajectory,
  evaluateMultiProviderTrajectoryCase,
} from './trajectory-multi.ts';
export type {
  PlannedStep,
  MultiProviderTrajectorySpec,
  ResolvedSurface,
  SurfaceResolver,
  TransitionEvent,
  MultiStepRecord,
  MultiProviderTrajectoryObservation,
  MultiInvariantResult,
  MultiProviderTrajectoryDerived,
  MultiProviderTrajectoryCase,
} from './trajectory-multi.ts';
export { assembleMultiProviderTrajectoryReport } from './trajectory-multi-report.ts';
export type { MultiProviderReportInput, MultiProviderTrajectoryReport } from './trajectory-multi-report.ts';

// --- Cross-model (3C): do Claude/GPT/Gemini reach the same allowable terminal state? ---
export { runCrossModelTrajectory, compareCrossModelTrajectory, renderCrossModelArtifact } from './trajectory-crossmodel.ts';
export type { CrossModelTrajectoryResult, CrossModelPerModel, CrossModelComparison } from './trajectory-crossmodel.ts';

// --- The Chrome/WebMCP acceptance lane: a SurfaceResolver over a privileged browser host ---
// interop-runtime is the brain; the host (e.g. the Refraktor extension) is the arms and legs.
export { CHROME_WEBMCP_RUNTIME_ID, makeBrowserSurfaceResolver } from './browser-host.ts';
export type { BrowserHost } from './browser-host.ts';

// --- The FROZEN 3C acceptance fixture (shipped canonical) — the exact spec + provider defs every
// gate (reference, cross-model live, Chrome/WebMCP) drives byte-identically. See acceptance-fixture.ts. ---
export {
  CAFE_PROVIDER,
  BAKERY_PROVIDER,
  CROSSMODEL_JOURNEY_SPEC,
  CROSSMODEL_PROVIDER_DEFS,
} from './acceptance-fixture.ts';
