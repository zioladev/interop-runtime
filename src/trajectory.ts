// The trajectory layer (Phase III, report contract /2).
//
// Phase II measures ONE decision against a provider surface. Phase III measures a
// TRAJECTORY: an ordered `inspect -> decide -> commit -> ...` sequence, with each step's
// output available to the next, toward a terminal state. The architectural law (D25):
//
//   A trajectory is an ordered sequence of INDEPENDENTLY attributable decisions and
//   executions. The trajectory layer must NOT erase Phase II attribution by collapsing
//   the whole journey into one PASS/FAIL.
//
//        Trajectory
//          |- Step 1 -> Phase II attribution (evaluatePath)
//          |- Step 2 -> Phase II attribution (evaluatePath)
//          |- Step 3 -> Phase II attribution (evaluatePath)
//          `- Trajectory judgment
//               |- ordering
//               |- state propagation
//               |- terminal state
//               `- trajectory_orchestration attribution
//
// Every step is executed through the SAME common bridge as Phase II
// (observeDecisionOnRuntime) and evaluated by the SAME engine (evaluatePath). Only the
// judgment ABOVE the steps is new. See docs/provider-conformance/15.

import type {
  AttributionCategory,
  AttributionEntry,
  ConsumerDecision,
  Effect,
  ExecutionResult,
  ModelConsumerAdapter,
  NormalizedTool,
  PathDerived,
  PriorStep,
  StepResults,
  TaskSpec,
  ToolDef,
  Verdict,
} from './types.ts';
import { PROVIDER_OWNED } from './types.ts';
import { evaluatePath } from './engine.ts';
import { observeDecisionOnRuntime } from './run-case.ts';
import { discover } from './bridge.ts';
import { validateProvider } from './normalize.ts';
import { ReferenceRuntime } from './reference-runtime.ts';
import type { WebMcpRuntime } from './reference-runtime.ts';
import type { ProviderUnderTest } from './run-case.ts';

// --- The frozen fixture vocabulary (D28): constrain what must be TRUE, not how the model
// --- must get there. Terminal states and invariants are frozen a priori; the model's route
// --- is observation.

/** A terminal condition a trajectory may end in. */
export type TerminalState =
  | { kind: 'committed'; tool: string } // a state-changing tool executed (state changed)
  | { kind: 'deferred' } //               ended by asking / declining to act, no commit
  | { kind: 'no_commit' }; //             ran out of steps without committing

/**
 * A trajectory invariant — a semantically necessary truth, checked over the recorded run.
 * The set is deliberately small and mechanical for 3A; it is extended (not redefined) later.
 */
export type TrajectoryInvariant =
  | { kind: 'inspect_before_commit'; inspectTool: string; commitTool: string }
  | { kind: 'commit_uses_prior_output'; commitTool: string; argKey: string; fromField: string }
  | { kind: 'no_commit_before_fields'; commitTool: string; requiredFields: string[] }
  | { kind: 'exactly_one_commit'; commitTool: string };

/** A frozen multi-step task (§08 discipline, lifted to trajectories). */
export interface TrajectorySpec {
  trajectoryId: string;
  text: string;
  /** Initial known facts (state seeded before step 1). */
  initialState?: Record<string, unknown>;
  /** The tools the journey is sanctioned to use. A tool_call outside this set is a model fault. */
  allowedStepTypes: string[];
  /** At least one required terminal state must be reached. */
  requiredTerminalStates: TerminalState[];
  /** None of these terminal states may be reached. */
  forbiddenTerminalStates?: TerminalState[];
  /** Semantically necessary invariants; all must hold. */
  invariants: TrajectoryInvariant[];
  /** Termination guard — the maximum number of steps the engine will drive. */
  maxSteps: number;
}

/** One executed step: its decision, its Phase II facts, and its Phase II judgment. */
export interface TrajectoryStepRecord {
  index: number;
  decision: ConsumerDecision;
  steps: StepResults;
  derived: PathDerived;
  /** Convenience flags derived from the step. */
  firedTool?: string;
  firedEffect?: Effect;
  executed: boolean;
}

/** The accumulated, carried-forward trajectory state. */
export interface TrajectoryState {
  /** Read tools that executed successfully, in order (the interrogations). */
  inspected: string[];
  /** State-changing tools that executed (state changed), in order (the commits). */
  committed: string[];
  /** Facts gathered from inspect outputs — the state carried forward between steps. */
  gathered: Record<string, unknown>;
  steps: TrajectoryStepRecord[];
}

/** One consumer's whole trajectory: identity, recorded steps, and the trajectory judgment. */
export interface TrajectoryObservation {
  adapterId: string;
  adapterVersion: string;
  modelId: string;
  state: TrajectoryState;
  terminalState: TerminalState;
}

export interface InvariantResult {
  invariant: TrajectoryInvariant;
  held: boolean;
  detail: string;
}

/** The derived judgment for a whole trajectory — re-computable from the observation. */
export interface TrajectoryDerived {
  terminalState: TerminalState;
  reachedRequiredTerminal: boolean;
  hitForbiddenTerminal: boolean;
  invariantResults: InvariantResult[];
  /** Per-step Phase II judgments — NEVER erased (D25). */
  stepDeriveds: PathDerived[];
  /** Trajectory-level + surfaced step-level attribution, owner-first. */
  attribution: AttributionEntry[];
  /** The orchestration/terminal view (consumer-side). PASS unless a route/terminal rule broke. */
  trajectoryConformance: Verdict;
  /** True iff any step carried a provider-owned fault. */
  providerNonconformance: boolean;
  /** The provider grade for this trajectory — provider-owned categories ONLY. */
  providerGrade: Verdict;
  /** A stable key over the executed route (for path-difference divergence). */
  pathKey: string;
  /** A stable key over the terminal state (for terminal-difference divergence). */
  terminalKey: string;
}

// --- Execution ---------------------------------------------------------------------------

/** Canonical JSON (sorted keys) so value comparison ignores key order. */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

function terminalEq(a: TerminalState, b: TerminalState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'committed' && b.kind === 'committed') return a.tool === b.tool;
  return true;
}

/** A permissive per-step task: the frozen rubric lives at the trajectory level, not the step. */
function stepTask(spec: TrajectorySpec): TaskSpec {
  return { taskId: `${spec.trajectoryId}#step`, text: spec.text, allowableOutcomes: [] };
}

/**
 * Drive a trajectory: repeatedly ask the adapter to plan the next step given the history,
 * execute it through the common bridge, carry outputs forward, and stop at a terminal state.
 * Deterministic on the reference lane.
 */
export async function runTrajectoryOnRuntime(
  runtime: WebMcpRuntime,
  defs: ToolDef[],
  spec: TrajectorySpec,
  adapter: ModelConsumerAdapter,
): Promise<TrajectoryObservation> {
  const identity = { adapterId: adapter.id, adapterVersion: adapter.version, modelId: adapter.modelId };
  const definition = validateProvider(defs);

  const handles = await runtime.getTools();
  const discoveredNames = handles.map((h) => h.name);
  const missingClaimed = defs.map((d) => d.name).find((n) => !discoveredNames.includes(n));
  const discovery = {
    ok: missingClaimed === undefined,
    names: discoveredNames,
    ...(missingClaimed !== undefined ? { missingClaimedTool: missingClaimed } : {}),
  };
  const normalized: NormalizedTool[] = await discover(runtime, defs);

  const state: TrajectoryState = {
    inspected: [],
    committed: [],
    gathered: { ...(spec.initialState ?? {}) },
    steps: [],
  };
  const history: PriorStep[] = [];
  const task = stepTask(spec);

  for (let index = 0; index < spec.maxSteps; index++) {
    const decision = await adapter.plan({ task, tools: normalized, history });

    // Journey-level tool sanction (D27): a tool_call outside the sanctioned set is the model
    // choosing a tool the task never authorized — model_tool_selection, NOT orchestration.
    // We do not execute it; the trajectory stops with that step faulted.
    if (decision.type === 'tool_call' && !spec.allowedStepTypes.includes(decision.toolName)) {
      const steps: StepResults = {
        definition,
        browserRuntime: { ok: true },
        discovery,
        adapterFormat: { ok: true, normalizationApplied: [], droppedRequiredFields: [] },
        decision,
        bridge: { attempted: false, ok: false },
        providerExec: { reached: false, ok: false },
        argsValidation: { checked: false, ok: true, missingOrInvalidFields: [] },
        evidence: { checked: false, ok: true, violations: [] },
      };
      const derived = evaluatePath({ ...identity, steps }, task, /* expectedTool */ ' sanctioned');
      state.steps.push({ index, decision, steps, derived, executed: false });
      break;
    }

    const steps = await observeDecisionOnRuntime(runtime, defs, decision, { definition, discovery });
    const derived = evaluatePath({ ...identity, steps }, task, undefined);
    const firedTool = steps.providerExec.firedTool;
    const firedEffect = steps.providerExec.firedEffect;
    const executed = steps.providerExec.reached && steps.providerExec.ok;
    const record: TrajectoryStepRecord = {
      index,
      decision,
      steps,
      derived,
      ...(firedTool !== undefined ? { firedTool } : {}),
      ...(firedEffect !== undefined ? { firedEffect } : {}),
      executed,
    };
    state.steps.push(record);

    // Feed the step into the history the next plan() will see (carry output forward).
    const result = steps.evidence.executionResult;
    history.push({
      decision,
      executed,
      ...(firedEffect !== undefined ? { effect: firedEffect } : {}),
      ...(result !== undefined ? { result } : {}),
    });

    if (executed && firedTool !== undefined) {
      if (firedEffect === 'read') {
        state.inspected.push(firedTool);
        mergeGathered(state.gathered, result);
      } else {
        state.committed.push(firedTool);
        // A successful commit terminates the journey (3A: exactly one commit ends it).
        break;
      }
    }

    // A non-execution response (clarification / no_action) terminates the journey.
    if (decision.type === 'clarification' || decision.type === 'no_action' || decision.type === 'error') break;
    // A tool_call that faulted before/at execution also terminates.
    if (decision.type === 'tool_call' && !executed) break;
  }

  const terminalState = deriveTerminal(state);
  return { ...identity, state, terminalState };
}

/** Merge primitive fields of an inspect output into the carried-forward gathered state. */
function mergeGathered(gathered: Record<string, unknown>, result: ExecutionResult | undefined): void {
  const data = result?.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object') gathered[k] = v;
  }
}

function deriveTerminal(state: TrajectoryState): TerminalState {
  const lastCommit = state.committed[state.committed.length - 1];
  if (lastCommit !== undefined) return { kind: 'committed', tool: lastCommit };
  const last = state.steps[state.steps.length - 1];
  if (last && (last.decision.type === 'clarification' || last.decision.type === 'no_action')) {
    return { kind: 'deferred' };
  }
  return { kind: 'no_commit' };
}

// --- Judgment ----------------------------------------------------------------------------

const CONSUMER_STEP_CATEGORIES: readonly AttributionCategory[] = [
  'consumer_adapter',
  'model_tool_selection',
  'model_arguments',
  'execution_bridge',
];

function checkInvariant(inv: TrajectoryInvariant, state: TrajectoryState): InvariantResult {
  switch (inv.kind) {
    case 'inspect_before_commit': {
      const committedAt = state.steps.findIndex((s) => s.executed && s.firedTool === inv.commitTool && s.firedEffect !== 'read');
      if (committedAt === -1) return { invariant: inv, held: true, detail: 'commit did not occur; ordering vacuously holds' };
      const inspectedBefore = state.steps.slice(0, committedAt).some((s) => s.executed && s.firedTool === inv.inspectTool);
      return inspectedBefore
        ? { invariant: inv, held: true, detail: `${inv.inspectTool} preceded ${inv.commitTool}` }
        : { invariant: inv, held: false, detail: `committed ${inv.commitTool} before inspecting via ${inv.inspectTool}` };
    }
    case 'no_commit_before_fields': {
      const commitStep = state.steps.find((s) => s.executed && s.firedTool === inv.commitTool && s.firedEffect !== 'read');
      if (!commitStep) return { invariant: inv, held: true, detail: 'commit did not occur; precondition vacuously holds' };
      // Reconstruct the gathered snapshot as it stood BEFORE the commit step.
      const before: Record<string, unknown> = {};
      for (const s of state.steps) {
        if (s.index >= commitStep.index) break;
        if (s.executed && s.firedEffect === 'read') mergeGathered(before, s.steps.evidence.executionResult);
      }
      const missing = inv.requiredFields.filter((f) => !(f in before));
      return missing.length === 0
        ? { invariant: inv, held: true, detail: 'required fields were known before commit' }
        : { invariant: inv, held: false, detail: `committed before required field(s) were known: ${missing.join(', ')}` };
    }
    case 'commit_uses_prior_output': {
      const commitStep = state.steps.find((s) => s.executed && s.firedTool === inv.commitTool && s.firedEffect !== 'read');
      if (!commitStep) return { invariant: inv, held: true, detail: 'commit did not occur; propagation vacuously holds' };
      if (!(inv.fromField in state.gathered)) {
        return { invariant: inv, held: false, detail: `no prior output supplied field "${inv.fromField}" to carry forward` };
      }
      const args = (commitStep.decision.type === 'tool_call' ? commitStep.decision.arguments : undefined) as Record<string, unknown> | undefined;
      const used = args ? args[inv.argKey] : undefined;
      const expected = state.gathered[inv.fromField];
      return canonical(used) === canonical(expected)
        ? { invariant: inv, held: true, detail: `${inv.commitTool}.${inv.argKey} carried ${inv.fromField} forward` }
        : { invariant: inv, held: false, detail: `${inv.commitTool}.${inv.argKey} did not carry the prior output "${inv.fromField}" forward (used ${canonical(used)}, prior ${canonical(expected)})` };
    }
    case 'exactly_one_commit': {
      const n = state.committed.filter((t) => t === inv.commitTool).length;
      return n === 1
        ? { invariant: inv, held: true, detail: `exactly one ${inv.commitTool} commit` }
        : { invariant: inv, held: false, detail: `expected exactly one ${inv.commitTool} commit, observed ${n}` };
    }
  }
}

/**
 * Judge a whole trajectory. Per-step Phase II attribution is preserved; the trajectory layer
 * adds ordering / state-propagation / terminal judgment. `trajectory_orchestration` is emitted
 * ONLY when every executed step was individually valid but the journey logic was wrong (D26).
 */
export function evaluateTrajectory(obs: TrajectoryObservation, spec: TrajectorySpec): TrajectoryDerived {
  const stepDeriveds = obs.state.steps.map((s) => s.derived);
  const attribution: AttributionEntry[] = [];

  // 1. Surface consumer-side STEP faults first (a step was itself invalid, e.g. wrong tool).
  //    When present, the failure is owned by that step category — NOT orchestration (D26).
  const consumerStepFaults: AttributionEntry[] = [];
  for (const d of stepDeriveds) {
    for (const a of d.attribution) {
      if (CONSUMER_STEP_CATEGORIES.includes(a.category)) consumerStepFaults.push(a);
    }
  }

  // 2. Terminal-state judgment against the frozen rubric.
  const reachedRequiredTerminal = spec.requiredTerminalStates.some((t) => terminalEq(t, obs.terminalState));
  const hitForbiddenTerminal = (spec.forbiddenTerminalStates ?? []).some((t) => terminalEq(t, obs.terminalState));

  // 3. Invariants — only meaningful to attribute to orchestration when steps were valid.
  const invariantResults = spec.invariants.map((inv) => checkInvariant(inv, obs.state));

  const orchestrationEntries: AttributionEntry[] = [];
  if (consumerStepFaults.length === 0) {
    for (const r of invariantResults) {
      if (!r.held) {
        orchestrationEntries.push({ category: 'trajectory_orchestration', verdict: 'FAIL', signal: r.invariant.kind, detail: r.detail });
      }
    }
    if (!reachedRequiredTerminal) {
      orchestrationEntries.push({ category: 'trajectory_orchestration', verdict: 'FAIL', signal: 'terminal_state', detail: `terminal ${describeTerminal(obs.terminalState)} is not an allowable terminal state for this trajectory` });
    }
    if (hitForbiddenTerminal) {
      orchestrationEntries.push({ category: 'trajectory_orchestration', verdict: 'FAIL', signal: 'forbidden_terminal', detail: `reached a forbidden terminal state: ${describeTerminal(obs.terminalState)}` });
    }
  }

  // 4. Provider-owned STEP faults always surface (a provider broke mid-journey, e.g. bad evidence).
  const providerStepFaults: AttributionEntry[] = [];
  for (const d of stepDeriveds) {
    for (const a of d.attribution) {
      if (PROVIDER_OWNED.includes(a.category)) providerStepFaults.push(a);
    }
  }

  // Owner-first aggregation: consumer step fault -> orchestration -> provider fault.
  attribution.push(...consumerStepFaults, ...orchestrationEntries, ...providerStepFaults);

  const providerNonconformance = stepDeriveds.some((d) => d.providerNonconformance);
  const providerGrade: Verdict = providerNonconformance ? 'FAIL' : 'PASS';
  // Trajectory conformance is the consumer/orchestration view — it excludes provider faults.
  const trajectoryConformance: Verdict = consumerStepFaults.length > 0 || orchestrationEntries.length > 0 ? 'FAIL' : 'PASS';

  return {
    terminalState: obs.terminalState,
    reachedRequiredTerminal,
    hitForbiddenTerminal,
    invariantResults,
    stepDeriveds,
    attribution,
    trajectoryConformance,
    providerNonconformance,
    providerGrade,
    pathKey: pathKeyOf(obs.state),
    terminalKey: describeTerminal(obs.terminalState),
  };
}

function describeTerminal(t: TerminalState): string {
  return t.kind === 'committed' ? `committed:${t.tool}` : t.kind;
}

/** The executed route: the ordered sequence of (effect:tool) actually run. */
function pathKeyOf(state: TrajectoryState): string {
  return state.steps
    .filter((s) => s.executed && s.firedTool !== undefined)
    .map((s) => `${s.firedEffect === 'read' ? 'inspect' : 'commit'}:${s.firedTool}`)
    .join(' -> ');
}

// --- Cross-consumer trajectory divergence (D29) ------------------------------------------

export interface TrajectoryDivergenceResult {
  /** Do the executed routes differ? (Different route != wrong.) */
  pathDifference: boolean;
  /** Do the reached terminal states differ? */
  terminalStateDifference: boolean;
  /** Does trajectory conformance (or provider grade) differ across consumers? */
  trajectoryConformanceDifference: boolean;
  byPath: Record<string, { path: string; terminal: string; conformance: Verdict; providerGrade: Verdict }>;
}

export function evaluateTrajectoryDivergence(
  obs: TrajectoryObservation[],
  deriveds: TrajectoryDerived[],
): TrajectoryDivergenceResult {
  const byPath: TrajectoryDivergenceResult['byPath'] = {};
  obs.forEach((o, i) => {
    const d = deriveds[i] as TrajectoryDerived;
    byPath[o.adapterId] = { path: d.pathKey, terminal: d.terminalKey, conformance: d.trajectoryConformance, providerGrade: d.providerGrade };
  });
  const distinct = (xs: string[]): boolean => new Set(xs).size > 1;
  return {
    pathDifference: distinct(deriveds.map((d) => d.pathKey)),
    terminalStateDifference: distinct(deriveds.map((d) => d.terminalKey)),
    trajectoryConformanceDifference: distinct(deriveds.map((d) => `${d.trajectoryConformance}/${d.providerGrade}`)),
    byPath,
  };
}

// --- Convenience -------------------------------------------------------------------------

/** A trajectory case: one journey, one or more consumer trajectories. */
export interface TrajectoryCase {
  caseId: string;
  spec: TrajectorySpec;
  observations: TrajectoryObservation[];
}

/** Reference-lane convenience: register the provider on a fresh runtime and run a trajectory. */
export async function runTrajectory(
  provider: ProviderUnderTest,
  spec: TrajectorySpec,
  adapter: ModelConsumerAdapter,
): Promise<TrajectoryObservation> {
  const runtime = new ReferenceRuntime();
  for (const t of provider.tools) runtime.registerTool(t.def, t.handler);
  return runTrajectoryOnRuntime(runtime, provider.tools.map((t) => t.def), spec, adapter);
}

/** Build a TrajectoryCase by running each adapter's trajectory against one provider surface. */
export async function buildTrajectoryCase(
  caseId: string,
  provider: ProviderUnderTest,
  spec: TrajectorySpec,
  adapters: ModelConsumerAdapter[],
): Promise<TrajectoryCase> {
  const observations: TrajectoryObservation[] = [];
  for (const a of adapters) observations.push(await runTrajectory(provider, spec, a));
  return { caseId, spec, observations };
}

/** Build a TrajectoryCase against an arbitrary runtime (e.g. real Chrome/WebMCP). */
export async function buildTrajectoryCaseOnRuntime(
  caseId: string,
  runtime: WebMcpRuntime,
  defs: ToolDef[],
  spec: TrajectorySpec,
  adapters: ModelConsumerAdapter[],
): Promise<TrajectoryCase> {
  const observations: TrajectoryObservation[] = [];
  for (const a of adapters) observations.push(await runTrajectoryOnRuntime(runtime, defs, spec, a));
  return { caseId, spec, observations };
}

/** Evaluate a whole trajectory case: judge each trajectory, then classify divergence. */
export function evaluateTrajectoryCase(c: TrajectoryCase): {
  deriveds: TrajectoryDerived[];
  divergence: TrajectoryDivergenceResult;
  provider: Verdict;
} {
  const deriveds = c.observations.map((o) => evaluateTrajectory(o, c.spec));
  const divergence = evaluateTrajectoryDivergence(c.observations, deriveds);
  const provider: Verdict = deriveds.some((d) => d.providerGrade === 'FAIL') ? 'FAIL' : 'PASS';
  return { deriveds, divergence, provider };
}
