// Core contracts for @zioladev/provider-conformance (Milestone 2A).
//
// This package is an evidence-and-attribution system: it turns (provider + task +
// consumer path) into a versioned, attributable, machine-readable observation.
// See docs/provider-conformance/ for the full specification.

import type { ExecutionControlObservation } from './execution-control.ts';

/** A provider tool's declared effect. */
export type Effect = 'read' | 'state-changing';

/** A minimal JSON-Schema shape (the supported subset). */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
}

/** A provider tool definition. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effect: Effect;
}

/** A tool as presented to every adapter after normalization (identical across paths). */
export type NormalizedTool = ToolDef;

/** The structured execution evidence a state-changing tool must return (Phase I contract). */
export interface ExecutionResult {
  executed: boolean;
  confirmationId?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

/** An error surfaced by an adapter (its own logic or its transport to the model). */
export interface AdapterError {
  code: string;
  message: string;
}

/**
 * A binding annotation on a tool_call (Phase III, multi-provider): a CLAIM that an argument's
 * value came from a prior step's carried value keyed `fromKey`. It is only a claim — the
 * trajectory engine verifies it against the authoritative carried state, which is built from
 * observed evidence, never from the model's assertion (D36). Optional and additive.
 */
export interface ArgBinding {
  argKey: string;
  fromKey: string;
}

/**
 * The decision a ModelConsumerAdapter produces. It DECIDES; it never executes.
 * The four types are intentionally narrower than the outcome vocabulary — the
 * adapter reports only what it decided; the bridge + provider determine the outcome.
 */
export type ConsumerDecision =
  | { type: 'tool_call'; toolName: string; arguments: unknown; raw?: unknown; bindings?: ArgBinding[] }
  | { type: 'clarification'; message?: string; raw?: unknown }
  | { type: 'no_action'; reason?: string; raw?: unknown }
  | { type: 'error'; error: AdapterError; raw?: unknown };

/** A provider's identity in a multi-provider trajectory (Phase III / 3B). */
export interface ProviderRef {
  id: string;
  /** The security/identity boundary — the independent origin. */
  origin: string;
  /**
   * The exact tool-bearing location, when it differs from the origin root. Production taught us
   * landing page ≠ tool-bearing page (D31), so these are kept DISTINCT, never collapsed.
   */
  toolEndpoint?: string;
}

/**
 * A value carried from one step into a later one, WITH provenance (D32). The engine produces
 * these from observed execution evidence only — authoritative state lives here, not in model
 * memory (D36). A later step may reference `key` to source an input; the reference is verified
 * against this record.
 */
export interface CarriedValue {
  key: string;
  value: unknown;
  producedBy: { stepId: string; providerId: string; toolName: string };
  /** A reference to the producing step's evidence (e.g. its stepId), so lineage is auditable. */
  evidenceRef?: string;
}

/** A frozen task (fixture discipline — §08). */
export interface TaskSpec {
  taskId: string;
  text: string;
  /** The set of observable outcomes that count as legitimate for this case. */
  allowableOutcomes: string[];
}

/**
 * One prior step of a trajectory, as presented to the adapter when it plans the next step
 * (Phase III). It carries the earlier decision AND what the provider returned, so a
 * trajectory-aware adapter can pass a prior output forward. Optional and additive: a
 * single-decision (Phase II) plan never sets it.
 */
export interface PriorStep {
  decision: ConsumerDecision;
  executed: boolean;
  effect?: Effect;
  /** The provider's returned evidence for this step (the output available to carry forward). */
  result?: ExecutionResult;
}

export interface PlanInput {
  task: TaskSpec;
  tools: NormalizedTool[];
  system?: string;
  /** Prior steps in the current trajectory, oldest first (Phase III). Absent for single decisions. */
  history?: PriorStep[];
  /**
   * The carried state (with provenance) available to this step in a multi-provider trajectory
   * (Phase III / 3B). Presented to the adapter as CONTEXT to reason over; it never becomes
   * authoritative by virtue of the model reading it (D36). Absent outside multi-provider runs.
   */
  carried?: CarriedValue[];
}

/**
 * A model-agnostic consumer. Named ModelConsumerAdapter, deliberately, to avoid the
 * @selvage/core `ConsumerAdapter` collision. INVARIANT: plan() never executes.
 */
export interface ModelConsumerAdapter {
  readonly id: string;
  readonly version: string;
  readonly modelId: string;
  plan(input: PlanInput): Promise<ConsumerDecision>;
}

/** The ten first-class outcomes (§04). Closed per report version. */
export type Outcome =
  | 'executed'
  | 'stopped_by_execution_control'
  | 'blocked_by_provider_contract'
  | 'clarification'
  | 'no_tool_selected'
  | 'malformed_arguments'
  | 'adapter_error'
  | 'runtime_error'
  | 'transport_error'
  | 'execution_bridge_error'
  | 'provider_error';

/**
 * The fault categories (§05). Closed per report version.
 *
 * `trajectory_orchestration` is the Phase III addition (report contract `/2`): it owns
 * SEQUENCING faults across a multi-step trajectory — valid steps in an invalid order,
 * failure to carry a prior output forward, skipping a required prerequisite, committing
 * before required inspection, transitioning to the wrong next step, or continuing past
 * the point the trajectory should have terminated. It is consumer/orchestrator-owned and
 * therefore, like the other consumer-side categories, NEVER reflects on the provider.
 * Discipline: attribute here ONLY when each individual step was itself valid but the
 * trajectory logic around it was wrong. A wrong tool selected inside a step stays
 * `model_tool_selection`.
 */
export type AttributionCategory =
  | 'provider_definition'
  | 'provider_runtime'
  | 'browser_runtime'
  | 'consumer_adapter'
  | 'model_tool_selection'
  | 'model_arguments'
  | 'execution_bridge'
  | 'provider_execution'
  | 'evidence_contract'
  | 'trajectory_orchestration';

/** The four categories that reflect on the provider itself. (Trajectory faults are not here.) */
export const PROVIDER_OWNED: readonly AttributionCategory[] = [
  'provider_definition',
  'provider_runtime',
  'provider_execution',
  'evidence_contract',
];

export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'NOT_REACHED';

/**
 * A higher-order class over outcomes, used for *behavioral* divergence scoring (§07). It keeps
 * meaningful strategy differences without exaggerating them into failures.
 *   acted     ← a STATE-CHANGING tool executed
 *   inspected ← a READ-ONLY tool executed (interrogated the provider; nothing changed)
 *   deferred  ← no provider tool executed (clarification | no_tool_selected | blocked)
 *   failed    ← the path failed before/during execution
 * Claude asking the user (deferred) and GPT running a read (inspected) are NOT the same
 * behavior — and neither changed state.
 */
export type ActionDisposition = 'acted' | 'inspected' | 'deferred' | 'failed';

/**
 * The neutral, observed facts of one consumer path through the pipeline. These are
 * FACTS, not judgments — the attribution engine derives blame from them (§04).
 * The live pipeline produces this by running; golden fixtures supply it directly.
 */
export interface StepResults {
  /** Static validation of the provider definition (schema subset, declared effect). */
  definition: { valid: boolean; violations: string[] };
  /** The browser/WebMCP runtime surface is present and well-formed. */
  browserRuntime: { ok: boolean; detail?: string };
  /** The provider's tool was discovered on the surface as it claimed. */
  discovery: { ok: boolean; names: string[]; missingClaimedTool?: string };
  /** The adapter formatted the schema into the model's tool format. */
  adapterFormat: { ok: boolean; normalizationApplied: string[]; droppedRequiredFields: string[]; error?: AdapterError };
  /** What the adapter decided. */
  decision: ConsumerDecision;
  /** The common execution bridge's attempt to invoke a tool_call decision. */
  bridge: { attempted: boolean; ok: boolean; toolName?: string; arguments?: unknown; error?: { code: string; message: string } };
  /** Whether/how the provider actually executed. `firedEffect` distinguishes read vs. state-changing. */
  providerExec: { reached: boolean; ok: boolean; firedTool?: string; firedEffect?: Effect; error?: { code: string; message: string } };
  /** The provider's own input validation on the arguments. */
  argsValidation: { checked: boolean; ok: boolean; missingOrInvalidFields: string[] };
  /** The ExecutionResult contract check. */
  evidence: { checked: boolean; ok: boolean; executionResult?: ExecutionResult; violations: string[] };
  /** Optional execution-control observation (Phase V) — distinct from the provider ExecutionResult. */
  executionControl?: ExecutionControlObservation;
  /** Optional segmented timing. */
  timing?: { model?: number; bridge?: number; provider?: number; total?: number };
}

/** One consumer path's identity + its observed facts. */
export interface PathObservation {
  adapterId: string;
  adapterVersion: string;
  modelId: string;
  steps: StepResults;
}

/** A single attributed finding. */
export interface AttributionEntry {
  category: AttributionCategory;
  verdict: 'FAIL' | 'WARN';
  signal: string;
  detail: string;
}

/** The derived judgments for one path — all re-computable from StepResults. */
export interface PathDerived {
  outcome: Outcome;
  /** The higher-order action class, for behavioral divergence scoring (§07). */
  disposition: ActionDisposition;
  categoryVerdicts: Partial<Record<AttributionCategory, Verdict>>;
  attribution: AttributionEntry[];
  providerNonconformance: boolean;
  /** Fine-grained key (fired tool + args) — used for representational comparison. */
  observableOutcomeKey: string;
  /** Coarse key over disposition (args collapse for deferred/failed) — used for behavior. */
  behavioralKey: string;
}

export type DivergenceKind = 'none' | 'behavioral' | 'outcome' | 'conformance';

export interface DivergenceResult {
  /** Meaningful *behavioral* divergence (scored over action disposition, §07). */
  kind: DivergenceKind;
  /** Do the fine-grained observable keys differ (e.g. clarification vs no_tool_selected)? */
  representationalDifference: boolean;
  observedOutcomeKey?: string;
  byPath: Record<string, string>;
  withinAllowable: boolean;
}

/** A conformance case: one task, one or more consumer paths. */
export interface ConformanceCase {
  caseId: string;
  task: TaskSpec;
  /** The tool the task expects to be called, if the case grades tool selection. */
  expectedTool?: string;
  paths: PathObservation[];
}
