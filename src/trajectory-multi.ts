// The multi-provider trajectory layer (Phase III / 3B).
//
// 3A proved the trajectory measurement abstraction on ONE provider. 3B generalizes it across
// PROVIDERS — the thing TreeFrog's four-surface hop demonstrated but never truly had:
// **typed, attributable, lineage-bearing state propagation from one provider's step into the
// next.** Production carried the plan forward but not the outputs; here, carried state is a
// first-class interoperability primitive.
//
// Two architectural invariants, both learned the hard way in production, are law here:
//
//   D36 — MODEL MEMORY IS NEVER AUTHORITATIVE TRAJECTORY STATE. The model may receive carried
//         state as context and reason over it, but the authoritative carried state is built by
//         this engine from OBSERVED EXECUTION EVIDENCE only. A step's `bindings` are a CLAIM,
//         verified against that authoritative state — never trusted as truth.
//
//   D37 — COMPLETING THE LOOP IS NOT COMPLETING THE TRAJECTORY. Terminal state is decided by the
//         frozen terminal predicate (which required commits actually occurred), never by "the
//         planned steps were all iterated."
//
// The Selvage wall is immaculate (D35): this layer may OBSERVE that a commit occurred, failed,
// or used a value with broken lineage, and REPORT it. It never decides whether a commit is
// authorized — it does not intercept, gate, bind, or block. Measurement observes; governance
// intervenes; they never touch.
//
// Lane discipline (D34): a provider transition and surface-readiness are trajectory REQUIREMENTS
// the engine expresses; HOW readiness happens (navigate → poll → nudge on Chrome; instant on the
// reference lane) is owned by the lane's SurfaceResolver, never by this engine.

import type {
  AttributionCategory,
  AttributionEntry,
  CarriedValue,
  ConsumerDecision,
  Effect,
  ModelConsumerAdapter,
  PathDerived,
  PriorStep,
  ProviderRef,
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

// --- Frozen spec ------------------------------------------------------------------------

/** One planned leg of a multi-provider journey (the itinerary-like standard, frozen a priori). */
export interface PlannedStep {
  stepId: string;
  seq: number;
  provider: ProviderRef;
  intent: string;
  /** The tools this leg is sanctioned to use on its provider. A call outside the set is a model fault. */
  allowedTools: string[];
  /** Inputs this leg requires to be CARRIED from a prior step: `argKey` must equal carried `fromKey`. */
  requiredInputs?: { argKey: string; fromKey: string }[];
  /** Prior stepIds that must have SUCCEEDED before this leg may legitimately run. */
  dependsOn?: string[];
  /** Outputs this leg publishes into carried state, lifted from its execution evidence (`data[fromField]`). */
  publishes?: { key: string; fromField: string }[];
  /** Whether this leg must end in a successful STATE-CHANGING execution. Orthogonal to
   *  `requiredForTerminal`: `commitRequired` is about the EFFECT (a state change must happen);
   *  it does not by itself assert the step is part of the terminal objective (though in practice a
   *  required commit usually is — mark it `requiredForTerminal` too when it is). */
  commitRequired?: boolean;
  /** Whether SUCCESSFUL ATTAINMENT of this leg is part of the frozen terminal predicate — i.e. the
   *  journey's objective is unmet until this step completes, regardless of whether it mutates state.
   *  This is orthogonal to `commitRequired` (D43): a non-mutating final verification/analysis (e.g. a
   *  read that must run to complete the errand) is `requiredForTerminal: true, commitRequired: false`;
   *  an optional exploratory read is neither. "Finishing the commits ≠ finishing the journey." */
  requiredForTerminal?: boolean;
}

export interface MultiProviderTrajectorySpec {
  trajectoryId: string;
  text: string;
  providers: ProviderRef[];
  steps: PlannedStep[];
  /** Termination guard; defaults to the number of planned steps. */
  maxSteps?: number;
}

// --- Lane-owned surface resolution (D34) ------------------------------------------------

/** A ready provider surface: its runtime + declared defs, or a reason it is not discoverable. */
export interface ResolvedSurface {
  runtime: WebMcpRuntime;
  defs: ToolDef[];
  ready: boolean;
  detail?: string;
}

/**
 * The lane's job: given a provider identity, make its surface DISCOVERABLE and return it. The
 * reference lane resolves instantly; a Chrome lane would navigate → poll for readiness → nudge.
 * The trajectory engine calls this and records the transition; it never contains the mechanism.
 */
export interface SurfaceResolver {
  resolve(provider: ProviderRef): Promise<ResolvedSurface>;
}

/**
 * The reference-lane resolver: one in-process ReferenceRuntime per provider, built once and
 * cached, always instantly ready. An unknown provider resolves `ready:false` (a lane/browser
 * fault, never the provider's fault).
 */
export function makeReferenceSurfaceResolver(providers: Record<string, ProviderUnderTest>): SurfaceResolver {
  const cache = new Map<string, ResolvedSurface>();
  return {
    async resolve(provider: ProviderRef): Promise<ResolvedSurface> {
      const cached = cache.get(provider.id);
      if (cached) return cached;
      const put = provider.id in providers ? providers[provider.id] : undefined;
      if (!put) {
        const miss: ResolvedSurface = { runtime: new ReferenceRuntime(), defs: [], ready: false, detail: `no surface registered for provider "${provider.id}"` };
        cache.set(provider.id, miss);
        return miss;
      }
      const runtime = new ReferenceRuntime();
      for (const t of put.tools) runtime.registerTool(t.def, t.handler);
      const resolved: ResolvedSurface = { runtime, defs: put.tools.map((t) => t.def), ready: true };
      cache.set(provider.id, resolved);
      return resolved;
    },
  };
}

// --- Execution --------------------------------------------------------------------------

export interface TransitionEvent {
  fromProviderId?: string;
  toProviderId: string;
  surfaceReady: boolean;
  detail?: string;
}

/** One executed leg: transition + Phase II facts/judgment + what it contributed to carried state. */
export interface MultiStepRecord {
  step: PlannedStep;
  transition: TransitionEvent;
  decision: ConsumerDecision;
  steps: StepResults;
  derived: PathDerived;
  executed: boolean;
  firedTool?: string;
  firedEffect?: Effect;
  /** The carried state available to this leg WHEN it planned (snapshot; keeps evaluation pure). */
  carriedBefore: CarriedValue[];
  /** What this leg published into carried state, from its own evidence (D36). */
  published: CarriedValue[];
}

export interface MultiProviderTrajectoryObservation {
  adapterId: string;
  adapterVersion: string;
  modelId: string;
  records: MultiStepRecord[];
  /** The full carried state at the end of the run, with provenance. */
  carried: CarriedValue[];
}

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

function healthyBase(definition: StepResults['definition'], discovery: StepResults['discovery'], decision: ConsumerDecision): StepResults {
  return {
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
}

/**
 * Drive a multi-provider trajectory across independent provider surfaces. Deterministic on the
 * reference lane. Carried state is produced ONLY from observed evidence (D36); completion is
 * judged later from the frozen predicate, not from the loop ending (D37).
 */
export async function runMultiProviderTrajectory(
  resolver: SurfaceResolver,
  spec: MultiProviderTrajectorySpec,
  adapter: ModelConsumerAdapter,
): Promise<MultiProviderTrajectoryObservation> {
  const identity = { adapterId: adapter.id, adapterVersion: adapter.version, modelId: adapter.modelId };
  const carried: CarriedValue[] = [];
  const records: MultiStepRecord[] = [];
  const history: PriorStep[] = [];
  let prevProviderId: string | undefined;
  const maxSteps = spec.maxSteps ?? spec.steps.length;
  const task: TaskSpec = { taskId: `${spec.trajectoryId}#step`, text: spec.text, allowableOutcomes: [] };

  for (const step of spec.steps.slice(0, maxSteps)) {
    const carriedBefore = carried.map((c) => ({ ...c }));

    // 1. Provider transition + surface readiness (lane-owned mechanism; engine only records it).
    const resolved = await resolver.resolve(step.provider);
    const transition: TransitionEvent = {
      ...(prevProviderId !== undefined ? { fromProviderId: prevProviderId } : {}),
      toProviderId: step.provider.id,
      surfaceReady: resolved.ready,
      ...(resolved.detail !== undefined ? { detail: resolved.detail } : {}),
    };
    prevProviderId = step.provider.id;

    const definition = validateProvider(resolved.defs);

    // Surface not discoverable → a browser_runtime fault (lane-owned), provider PASS, no execution.
    if (!resolved.ready) {
      const steps: StepResults = {
        ...healthyBase(definition, { ok: false, names: [] }, { type: 'no_action', reason: 'surface not ready' }),
        browserRuntime: { ok: false, detail: resolved.detail ?? 'surface not ready' },
      };
      const derived = evaluatePath({ ...identity, steps }, task, undefined);
      records.push({ step, transition, decision: steps.decision, steps, derived, executed: false, carriedBefore, published: [] });
      history.push({ decision: steps.decision, executed: false });
      continue;
    }

    const handles = await resolved.runtime.getTools();
    const names = handles.map((h) => h.name);
    const missing = resolved.defs.map((d) => d.name).find((n) => !names.includes(n));
    const discovery = { ok: missing === undefined, names, ...(missing !== undefined ? { missingClaimedTool: missing } : {}) };
    const normalized = await discover(resolved.runtime, resolved.defs);

    // 2. The adapter decides (never executes), given carried state + history as CONTEXT (D36).
    const decision = await adapter.plan({ task, tools: normalized, history, carried: carriedBefore });

    // 3. Journey-level tool sanction: a tool_call outside the leg's sanctioned set is a model
    //    fault (the model chose a tool the task never authorized), NOT orchestration (D26).
    if (decision.type === 'tool_call' && !step.allowedTools.includes(decision.toolName)) {
      const steps = healthyBase(definition, discovery, decision);
      const derived = evaluatePath({ ...identity, steps }, task, ' unsanctioned');
      records.push({ step, transition, decision, steps, derived, executed: false, carriedBefore, published: [] });
      history.push({ decision, executed: false });
      continue;
    }

    // 4. Observe the decision against THIS provider's surface (same bridge as Phase II).
    const steps = await observeDecisionOnRuntime(resolved.runtime, resolved.defs, decision, { definition, discovery });
    const derived = evaluatePath({ ...identity, steps }, task, undefined);
    const firedTool = steps.providerExec.firedTool;
    const firedEffect = steps.providerExec.firedEffect;
    const executed = steps.providerExec.reached && steps.providerExec.ok;

    // 5. Publish outputs into carried state FROM EVIDENCE ONLY, with provenance (D36).
    const published: CarriedValue[] = [];
    if (executed && firedTool !== undefined) {
      const data = steps.evidence.executionResult?.data;
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        for (const pub of step.publishes ?? []) {
          if (pub.fromField in (data as Record<string, unknown>)) {
            const cv: CarriedValue = {
              key: pub.key,
              value: (data as Record<string, unknown>)[pub.fromField],
              producedBy: { stepId: step.stepId, providerId: step.provider.id, toolName: firedTool },
              evidenceRef: step.stepId,
            };
            published.push(cv);
            carried.push(cv);
          }
        }
      }
    }

    records.push({
      step,
      transition,
      decision,
      steps,
      derived,
      executed,
      ...(firedTool !== undefined ? { firedTool } : {}),
      ...(firedEffect !== undefined ? { firedEffect } : {}),
      carriedBefore,
      published,
    });
    const result = steps.evidence.executionResult;
    history.push({ decision, executed, ...(firedEffect !== undefined ? { effect: firedEffect } : {}), ...(result !== undefined ? { result } : {}) });
  }

  return { ...identity, records, carried };
}

// --- Judgment ---------------------------------------------------------------------------

const CONSUMER_STEP_CATEGORIES: readonly AttributionCategory[] = [
  'consumer_adapter',
  'model_tool_selection',
  'model_arguments',
  'execution_bridge',
];

export interface MultiInvariantResult {
  stepId: string;
  kind: string;
  held: boolean;
  detail: string;
}

export interface MultiProviderTrajectoryDerived {
  /** Per-leg Phase II judgments — never erased (D25). */
  stepDeriveds: PathDerived[];
  invariantResults: MultiInvariantResult[];
  attribution: AttributionEntry[];
  trajectoryConformance: Verdict;
  providerNonconformance: boolean;
  providerGrade: Verdict;
  /** The frozen terminal predicate (D37/D43): every commit-required leg committed AND every
   *  required-for-terminal (possibly non-mutating) leg was successfully attained. */
  terminalAttained: boolean;
  /** The executed route across providers, for the record. */
  routeKey: string;
}

/** A leg committed iff it executed a STATE-CHANGING tool successfully. */
function didCommit(r: MultiStepRecord): boolean {
  return r.executed && r.firedEffect !== undefined && r.firedEffect !== 'read';
}

/** True iff this leg carries a step-level fault that already owns its non-execution. */
function hasStepFault(d: PathDerived): boolean {
  return d.attribution.length > 0;
}

/** A non-commit leg is ATTAINED iff it successfully executed a tool with no step-level fault — the
 *  attainment notion for a `requiredForTerminal` step that (correctly) mutates nothing (D43). */
function didAttainNonCommit(r: MultiStepRecord): boolean {
  return r.executed && !hasStepFault(r.derived);
}

/**
 * Judge a multi-provider trajectory. Per-leg Phase II attribution is preserved; the multi-provider
 * layer adds provenance/dependency/terminal judgment. `trajectory_orchestration` is emitted ONLY
 * when the individual legs were valid but the cross-provider journey logic was wrong (D26).
 */
export function evaluateMultiProviderTrajectory(
  obs: MultiProviderTrajectoryObservation,
  spec: MultiProviderTrajectorySpec,
): MultiProviderTrajectoryDerived {
  const stepDeriveds = obs.records.map((r) => r.derived);
  const byId = new Map(obs.records.map((r) => [r.step.stepId, r]));

  const consumerStepFaults: AttributionEntry[] = [];
  const providerStepFaults: AttributionEntry[] = [];
  const browserFaults: AttributionEntry[] = [];
  for (const d of stepDeriveds) {
    for (const a of d.attribution) {
      if (CONSUMER_STEP_CATEGORIES.includes(a.category)) consumerStepFaults.push(a);
      else if (PROVIDER_OWNED.includes(a.category)) providerStepFaults.push(a);
      else if (a.category === 'browser_runtime') browserFaults.push(a);
    }
  }

  const invariantResults: MultiInvariantResult[] = [];
  const orchestration: AttributionEntry[] = [];
  // A model that cleanly declines a required commit (asks / inspects / narrates "done" without
  // executing) is a MODEL-LAYER fault, not orchestration (D38): the runtime behaved correctly by
  // NOT advancing on the model's word; the first incorrect decision was the model's. Orchestration
  // owns runtime/sequencing/state faults — a broken runtime that BELIEVES the narration and
  // advances would be orchestration, but this engine never does that.
  const modelDeclineFaults: AttributionEntry[] = [];
  const orchFail = (stepId: string, kind: string, detail: string): void => {
    invariantResults.push({ stepId, kind, held: false, detail });
    orchestration.push({ category: 'trajectory_orchestration', verdict: 'FAIL', signal: kind, detail });
  };
  const orchOk = (stepId: string, kind: string, detail: string): void => {
    invariantResults.push({ stepId, kind, held: true, detail });
  };

  // Orchestration is only meaningful to attribute when the legs were individually valid (D26).
  if (consumerStepFaults.length === 0) {
    for (const r of obs.records) {
      const s = r.step;

      // A) Required carried inputs — provenance propagation (FX1 / FX1-failure).
      for (const req of s.requiredInputs ?? []) {
        const cv = r.carriedBefore.find((c) => c.key === req.fromKey);
        if (!cv) {
          orchFail(s.stepId, 'missing_carried_input', `${s.stepId} requires carried input "${req.fromKey}" for arg "${req.argKey}", but no prior step produced it`);
        } else if (r.decision.type === 'tool_call') {
          const argVal = (r.decision.arguments as Record<string, unknown> | undefined)?.[req.argKey];
          if (canonical(argVal) !== canonical(cv.value)) {
            orchFail(s.stepId, 'carried_input_not_used', `${s.stepId} arg "${req.argKey}" did not carry forward "${req.fromKey}" (from ${cv.producedBy.providerId}/${cv.producedBy.toolName}); used ${canonical(argVal)}, carried ${canonical(cv.value)}`);
          } else {
            orchOk(s.stepId, 'carried_input_used', `${s.stepId}.${req.argKey} carried "${req.fromKey}" forward from ${cv.producedBy.providerId}/${cv.producedBy.toolName}`);
          }
        }
      }

      // B) Dependency after prerequisite failure (FX5).
      for (const dep of s.dependsOn ?? []) {
        const depRec = byId.get(dep);
        const depOk = depRec ? depRec.executed : false;
        if (!depOk && r.executed) {
          orchFail(s.stepId, 'dependency_after_failure', `${s.stepId} executed despite unsatisfied prerequisite "${dep}" (${depRec ? 'failed' : 'absent'})`);
        }
      }

      // C) Terminal predicate — a commit-required leg that did not commit (FX6 / FX7). The
      //    trajectory RECORDS this as an observation; the ATTRIBUTION follows the first incorrect
      //    decision (D38): if the leg carries its own step-level fault, that owns it; if the leg's
      //    required input was missing (a runtime/state fault, already flagged above), that owns it;
      //    otherwise the model cleanly chose not to commit — a MODEL fault (model_tool_selection),
      //    never orchestration, because a correct runtime does not advance on the model's word.
      if (s.commitRequired) {
        if (didCommit(r)) {
          orchOk(s.stepId, 'required_commit', `${s.stepId} performed its required commit`);
        } else {
          const how = r.executed ? 'inspected only (no state change)' : (r.decision.type === 'clarification' || r.decision.type === 'no_action' ? 'declined to commit (asked / narrated instead of executing)' : 'did not commit');
          invariantResults.push({ stepId: s.stepId, kind: 'terminal_not_attained', held: false, detail: `${s.stepId} is commit-required but ${how} — completing the loop is not completing the trajectory` });
          const ownedByStep = hasStepFault(r.derived) || browserFaults.length > 0;
          const ownedByMissingInput = orchestration.some((o) => o.signal === 'missing_carried_input' && o.detail.includes(s.stepId));
          if (!ownedByStep && !ownedByMissingInput) {
            modelDeclineFaults.push({ category: 'model_tool_selection', verdict: 'FAIL', signal: 'trajectory_requirement_unmet', detail: `${s.stepId} required a state-changing commit to reach the terminal state, but the model ${how}` });
          }
        }
      }

      // D) Required-for-terminal, NON-commit leg (D43): a mandatory non-mutating step (e.g. a final
      //    verification/analysis) that must SUCCESSFULLY execute for the journey's objective to be
      //    met. Commit legs are handled in (C); this covers the orthogonal case where nothing is
      //    mutated but the errand is still incomplete without it. Same owner-first attribution.
      if (s.requiredForTerminal && !s.commitRequired) {
        if (didAttainNonCommit(r)) {
          orchOk(s.stepId, 'required_terminal_step', `${s.stepId} completed its required (non-mutating) step`);
        } else {
          const how = r.executed ? 'executed with a fault' : (r.decision.type === 'clarification' || r.decision.type === 'no_action' ? 'declined (asked / narrated instead of executing)' : 'did not execute');
          invariantResults.push({ stepId: s.stepId, kind: 'terminal_not_attained', held: false, detail: `${s.stepId} is required for terminal completion but ${how} — completing the commits is not completing the journey` });
          const ownedByStep = hasStepFault(r.derived) || browserFaults.length > 0;
          const ownedByMissingInput = orchestration.some((o) => o.signal === 'missing_carried_input' && o.detail.includes(s.stepId));
          if (!ownedByStep && !ownedByMissingInput) {
            modelDeclineFaults.push({ category: 'model_tool_selection', verdict: 'FAIL', signal: 'trajectory_requirement_unmet', detail: `${s.stepId} was required for terminal completion, but the model ${how}` });
          }
        }
      }
    }
  }

  // The frozen terminal predicate (D37/D43): every commit-required leg actually committed AND every
  // required-for-terminal leg was successfully attained. The two clauses are orthogonal — a required
  // non-mutating leg (commitRequired:false, requiredForTerminal:true) must still be attained; an
  // optional read (neither) never blocks terminal. With no requiredForTerminal steps the second
  // clause is vacuously true, so pre-D43 specs behave identically.
  const commitsDone = spec.steps.filter((s) => s.commitRequired).every((s) => {
    const r = byId.get(s.stepId);
    return r !== undefined && didCommit(r);
  });
  const requiredReadsDone = spec.steps.filter((s) => s.requiredForTerminal && !s.commitRequired).every((s) => {
    const r = byId.get(s.stepId);
    return r !== undefined && didAttainNonCommit(r);
  });
  const terminalAttained = commitsDone && requiredReadsDone;

  // Owner-first aggregation: model-layer faults (step-level + declined-commit) → orchestration
  // (runtime/state/sequencing) → provider fault → browser (lane).
  const attribution = [...consumerStepFaults, ...modelDeclineFaults, ...orchestration, ...providerStepFaults, ...browserFaults];

  const providerNonconformance = stepDeriveds.some((d) => d.providerNonconformance);
  const providerGrade: Verdict = providerNonconformance ? 'FAIL' : 'PASS';
  const trajectoryConformance: Verdict =
    consumerStepFaults.length > 0 || modelDeclineFaults.length > 0 || orchestration.length > 0 ? 'FAIL' : 'PASS';

  const routeKey = obs.records
    .filter((r) => r.executed && r.firedTool !== undefined)
    .map((r) => `${r.step.provider.id}/${r.firedEffect === 'read' ? 'inspect' : 'commit'}:${r.firedTool}`)
    .join(' -> ');

  return {
    stepDeriveds,
    invariantResults,
    attribution,
    trajectoryConformance,
    providerNonconformance,
    providerGrade,
    terminalAttained,
    routeKey,
  };
}

// --- Convenience ------------------------------------------------------------------------

/** Reference-lane convenience: build a resolver from a provider map and run a trajectory. */
export async function runMultiProviderTrajectoryOnReference(
  providers: Record<string, ProviderUnderTest>,
  spec: MultiProviderTrajectorySpec,
  adapter: ModelConsumerAdapter,
): Promise<MultiProviderTrajectoryObservation> {
  return runMultiProviderTrajectory(makeReferenceSurfaceResolver(providers), spec, adapter);
}

export interface MultiProviderTrajectoryCase {
  caseId: string;
  spec: MultiProviderTrajectorySpec;
  observation: MultiProviderTrajectoryObservation;
}

/** Evaluate a whole multi-provider case (single consumer; cross-model divergence is 3C). */
export function evaluateMultiProviderTrajectoryCase(c: MultiProviderTrajectoryCase): {
  derived: MultiProviderTrajectoryDerived;
  provider: Verdict;
} {
  const derived = evaluateMultiProviderTrajectory(c.observation, c.spec);
  return { derived, provider: derived.providerGrade };
}
