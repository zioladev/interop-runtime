// The attribution engine: neutral observed facts (StepResults) -> derived judgments
// (outcome, per-category verdicts, attribution owner, provider grade). See §04, §05.
//
// The rule (§05): walk the pipeline from the provider outward and assign the FIRST
// layer whose contract was violated. A consumer-side fault is never provider
// nonconformance.

import type {
  ActionDisposition,
  AttributionCategory,
  AttributionEntry,
  ConformanceCase,
  DivergenceResult,
  Effect,
  Outcome,
  PathDerived,
  PathObservation,
  StepResults,
  TaskSpec,
  Verdict,
} from './types.ts';
import { PROVIDER_OWNED } from './types.ts';

/** Canonical JSON (sorted keys) so argument comparison ignores key order. */
function canonical(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/** The fine-grained observable-outcome key (representational comparison, §07). */
function observableKey(outcome: string, firedTool: string | undefined, args: unknown): string {
  if (outcome === 'executed' && firedTool !== undefined) {
    return `executed:${firedTool}(${canonical(args)})`;
  }
  return outcome;
}

/** Map an outcome (+ the fired tool's effect) to its higher-order action disposition (§07). */
function dispositionOf(outcome: Outcome, firedEffect: Effect | undefined): ActionDisposition {
  switch (outcome) {
    case 'executed':
      // A read execution interrogated the provider without changing state — `inspected`,
      // not `acted`. Only a state-changing execution is `acted`.
      return firedEffect === 'read' ? 'inspected' : 'acted';
    case 'clarification':
    case 'no_tool_selected':
    case 'blocked_by_provider_contract':
    case 'stopped_by_execution_control':
      // Stopped at the execution-control boundary before the provider — deferred, never failed.
      return 'deferred';
    default:
      return 'failed';
  }
}

/**
 * The coarse behavioral key used for *behavioral* divergence. For `acted`, the fired tool +
 * args matter (ordering M vs L is a real difference). For `deferred`/`failed`, the label
 * collapses — clarification vs no_tool_selected is the same practical result, and specific
 * failures are already captured by per-path attribution.
 */
function behavioralKeyOf(disposition: ActionDisposition, firedTool: string | undefined, args: unknown): string {
  if (disposition === 'acted' && firedTool !== undefined) {
    return `acted:${firedTool}(${canonical(args)})`;
  }
  return disposition;
}

/**
 * Evaluate one consumer path. Pure function of its StepResults + the case's task.
 */
export function evaluatePath(
  obs: PathObservation,
  task: TaskSpec,
  expectedTool: string | undefined,
): PathDerived {
  const s: StepResults = obs.steps;
  const cv: Partial<Record<AttributionCategory, Verdict>> = {};
  const attribution: AttributionEntry[] = [];

  const fail = (category: AttributionCategory, signal: string, detail: string): void => {
    cv[category] = 'FAIL';
    attribution.push({ category, verdict: 'FAIL', signal, detail });
  };

  const done = (outcome: PathDerived['outcome'], firedTool?: string, args?: unknown): PathDerived => {
    const observableOutcomeKey = observableKey(outcome, firedTool, args);
    // Task conformance (§08): a clean, terminal *response* must fall within the case's FROZEN
    // allowable set. A response outside it is a consumer-side fault (never provider-owned) —
    // e.g. the model executed using information the task never supplied while the provider
    // declares no default (fabrication). Skipped when a pipeline fault already owns the failure.
    const RESPONSE_OUTCOMES = new Set(['executed', 'clarification', 'no_tool_selected']);
    const hasFault = attribution.some((a) => a.verdict === 'FAIL');
    if (!hasFault && task.allowableOutcomes.length > 0 && RESPONSE_OUTCOMES.has(outcome)
        && !isWithinAllowable(outcome, observableOutcomeKey, task)) {
      // Effect-aware, first-failing-layer attribution (§05). Where does the first mismatch
      // against the frozen rubric enter?
      //   - a read execution (or any non-execution response) that is out of allowable → the
      //     tool SELECTION is the mismatch → model_tool_selection.
      //   - a state-changing execution out of allowable → the selection is plausible but the
      //     supplied required value violates the task's constraints → model_arguments.
      let category: AttributionCategory;
      let detail: string;
      if (outcome === 'executed' && s.providerExec.firedEffect !== 'read') {
        category = 'model_arguments';
        detail = 'executed a state-changing tool using a required value the task did not supply while the provider declares no default';
      } else if (outcome === 'executed') {
        category = 'model_tool_selection';
        detail = 'selected an exploratory read tool that was outside the allowable terminal outcomes for this test case';
      } else {
        category = 'model_tool_selection';
        detail = `model responded "${outcome}", which the task's frozen allowable set does not permit`;
      }
      cv[category] = 'FAIL';
      attribution.push({ category, verdict: 'FAIL', signal: 'task_conformance', detail });
    }
    const providerNonconformance = PROVIDER_OWNED.some((c) => cv[c] === 'FAIL');
    const disposition = dispositionOf(outcome, s.providerExec.firedEffect);
    const behavioralKey = behavioralKeyOf(disposition, firedTool, args);
    return { outcome, disposition, categoryVerdicts: cv, attribution, providerNonconformance, observableOutcomeKey, behavioralKey };
  };

  // 1. Provider definition (static).
  if (!s.definition.valid) {
    fail('provider_definition', 'definition', s.definition.violations.join('; ') || 'invalid provider definition');
    cv.provider_execution = 'NOT_REACHED';
    return done('provider_error');
  }
  cv.provider_definition = 'PASS';

  // 2. Browser/WebMCP runtime surface.
  if (!s.browserRuntime.ok) {
    fail('browser_runtime', 'runtime', s.browserRuntime.detail ?? 'runtime surface unavailable or malformed');
    cv.provider_execution = 'NOT_REACHED';
    return done('runtime_error');
  }
  cv.browser_runtime = 'PASS';

  // 3. Discovery — provider exposed the tool it claimed.
  if (!s.discovery.ok) {
    const detail = s.discovery.missingClaimedTool
      ? `provider claimed a tool that discovery did not surface: ${s.discovery.missingClaimedTool}`
      : 'tool discovery failed';
    fail('provider_runtime', 'discovery', detail);
    cv.provider_execution = 'NOT_REACHED';
    return done('provider_error');
  }
  cv.provider_runtime = 'PASS';

  // 4. Adapter formatting (private adapter step).
  if (!s.adapterFormat.ok) {
    fail('consumer_adapter', 'schema_accepted', s.adapterFormat.error?.message ?? 'schema formatting failed');
    cv.provider_execution = 'NOT_REACHED';
    return done('adapter_error');
  }
  cv.consumer_adapter = 'PASS';

  // 5. The decision.
  const d = s.decision;
  if (d.type === 'error') {
    const transport = d.error.code.startsWith('transport');
    // No dedicated transport category (§05 catalog is nine); a transport fault is the
    // adapter's environment and is charged to consumer_adapter, but the OUTCOME records
    // the distinction. Never provider nonconformance.
    fail('consumer_adapter', 'model_decision', `${d.error.code}: ${d.error.message}`);
    return done(transport ? 'transport_error' : 'adapter_error');
  }
  if (d.type === 'clarification') {
    cv.provider_execution = 'NOT_REACHED';
    return done('clarification');
  }
  if (d.type === 'no_action') {
    // Whether "no tool" is a fault or a legitimate non-action depends on the frozen allowable
    // set (§08) — decided by done()'s task-conformance check, not assumed here.
    cv.provider_execution = 'NOT_REACHED';
    return done('no_tool_selected');
  }

  // d.type === 'tool_call'
  if (expectedTool !== undefined && d.toolName !== expectedTool && !task.allowableOutcomes.includes(`executed:${d.toolName}`)) {
    fail('model_tool_selection', 'model_decision', `selected "${d.toolName}", expected "${expectedTool}"`);
    cv.provider_execution = 'NOT_REACHED';
    return done('no_tool_selected');
  }
  cv.model_tool_selection = 'PASS';

  // 5b. Execution-control seam (Phase V). A required-mode disposition other than `allow` (or a
  // missing/erroring authority) stops the step BEFORE the common bridge. This is a boundary
  // observation, NOT a fault: the provider was never called, so no provider/model/orchestration
  // category is charged and providerNonconformance is untouched. Whether the objective is ultimately
  // attained is left to the trajectory's terminal semantics (a blocked required commit simply does
  // not commit). Placed after model_tool_selection PASS so a valid, well-selected tool_call that the
  // boundary stops is recorded as stopped — never mislabeled a bridge/provider failure.
  if (s.executionControl?.stopped) {
    cv.provider_execution = 'NOT_REACHED';
    return done('stopped_by_execution_control');
  }

  // 6. Common execution bridge.
  if (!s.bridge.attempted) {
    fail('execution_bridge', 'bridge_invoked', 'a tool_call decision was never attempted by the bridge');
    cv.provider_execution = 'NOT_REACHED';
    return done('execution_bridge_error');
  }
  if (!s.bridge.ok) {
    fail('execution_bridge', 'bridge_invoked', s.bridge.error?.message ?? 'bridge failed to invoke a valid decision');
    cv.provider_execution = 'NOT_REACHED';
    return done('execution_bridge_error');
  }
  cv.execution_bridge = 'PASS';

  // 7. Provider input validation on the arguments.
  if (s.argsValidation.checked && !s.argsValidation.ok) {
    const bad = s.argsValidation.missingOrInvalidFields;
    const dropped = s.adapterFormat.droppedRequiredFields;
    const adapterCaused = bad.filter((f) => dropped.includes(f));
    if (adapterCaused.length > 0) {
      // The adapter dropped the field the provider is now rejecting — consumer fault.
      fail('consumer_adapter', 'normalized_arguments', `adapter dropped required field(s): ${adapterCaused.join(', ')}`);
    } else {
      fail('model_arguments', 'normalized_arguments', `model produced invalid/missing field(s): ${bad.join(', ')}`);
    }
    cv.provider_execution = 'NOT_REACHED';
    return done('malformed_arguments');
  }
  cv.model_arguments = 'PASS';

  // 8. Provider execution.
  if (!s.providerExec.reached) {
    fail('execution_bridge', 'provider_execution', 'provider execution not reached despite a valid invocation');
    return done('execution_bridge_error');
  }
  if (!s.providerExec.ok) {
    fail('provider_execution', 'provider_execution', s.providerExec.error?.message ?? 'provider executed incorrectly');
    return done('provider_error', s.providerExec.firedTool, s.bridge.arguments);
  }
  cv.provider_execution = 'PASS';

  // 9. Evidence contract.
  if (s.evidence.checked && !s.evidence.ok) {
    fail('evidence_contract', 'evidence', s.evidence.violations.join('; ') || 'execution evidence violates the ExecutionResult contract');
    return done('provider_error', s.providerExec.firedTool, s.bridge.arguments);
  }
  cv.evidence_contract = 'PASS';

  return done('executed', s.providerExec.firedTool, s.bridge.arguments);
}

/** True if an (outcome, observable-key) is within the case's frozen allowable set (§08). */
function isWithinAllowable(outcome: string, key: string, task: TaskSpec): boolean {
  const allow = task.allowableOutcomes;
  if (allow.includes(outcome)) return true;
  if (allow.includes(key)) return true;
  // Prefix match, e.g. allow "executed:place_order" matches "executed:place_order(...)".
  return allow.some((a) => key.startsWith(a));
}

/** True if a path's observed outcome is within the case's declared allowable set (§08). */
function isAllowable(derived: PathDerived, task: TaskSpec): boolean {
  return isWithinAllowable(derived.outcome, derived.observableOutcomeKey, task);
}

/**
 * Classify cross-consumer divergence for a case (§07). Two levels:
 *   - representational difference: do the fine-grained observable keys differ?
 *     (e.g. `clarification` vs `no_tool_selected` — different labels, same practical result)
 *   - behavioral divergence (`kind`): scored over the coarse behavioral key, so a mere
 *     label difference does not manufacture significance. Divergence != failure.
 */
export function evaluateDivergence(
  paths: PathObservation[],
  deriveds: PathDerived[],
  task: TaskSpec,
): DivergenceResult {
  const byPath: Record<string, string> = {};
  paths.forEach((p, i) => {
    byPath[p.adapterId] = deriveds[i]?.observableOutcomeKey ?? 'unknown';
  });

  const rawKeys = deriveds.map((d) => d.observableOutcomeKey);
  const behavioralKeys = deriveds.map((d) => d.behavioralKey);
  const withinAllowable = deriveds.every((d) => isAllowable(d, task));
  const representationalDifference = new Set(rawKeys).size > 1;

  const firstBehavior = behavioralKeys[0];
  if (behavioralKeys.every((k) => k === firstBehavior)) {
    // No meaningful behavioral divergence — paths did the same practical thing. (Labels may
    // still differ; that is reported as representationalDifference.)
    return { kind: 'none', observedOutcomeKey: firstBehavior, byPath, withinAllowable, representationalDifference };
  }

  // Behavior genuinely differs across paths.
  if (deriveds.some((d) => d.providerNonconformance)) {
    // The provider's own surface behaved differently depending on who called it.
    return { kind: 'conformance', byPath, withinAllowable, representationalDifference };
  }
  if (withinAllowable) {
    // Different behavior, but every path stayed within the declared allowable set — not a failure.
    return { kind: 'behavioral', byPath, withinAllowable, representationalDifference };
  }
  return { kind: 'outcome', byPath, withinAllowable, representationalDifference };
}

/** The provider grade across a case's paths — computed ONLY from provider-owned categories. */
export function providerGrade(deriveds: PathDerived[]): Verdict {
  let grade: Verdict = 'PASS';
  for (const d of deriveds) {
    for (const c of PROVIDER_OWNED) {
      if (d.categoryVerdicts[c] === 'FAIL') return 'FAIL';
      if (d.categoryVerdicts[c] === 'WARN') grade = 'WARN';
    }
  }
  return grade;
}

/** Evaluate a whole case: derive every path, then classify divergence. */
export function evaluateCase(c: ConformanceCase): {
  deriveds: PathDerived[];
  divergence: DivergenceResult;
  provider: Verdict;
} {
  const deriveds = c.paths.map((p) => evaluatePath(p, c.task, c.expectedTool));
  const divergence = evaluateDivergence(c.paths, deriveds, c.task);
  return { deriveds, divergence, provider: providerGrade(deriveds) };
}
