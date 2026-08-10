// Live orchestration of ONE consumer path through the whole spine (§02):
// load provider -> normalize surface -> ModelConsumerAdapter.plan() -> ConsumerDecision
// -> common execution bridge -> provider evidence -> StepResults. Deterministic on the
// reference-runtime lane.

import type {
  ConformanceCase,
  ConsumerDecision,
  ExecutionResult,
  ModelConsumerAdapter,
  PathObservation,
  StepResults,
  TaskSpec,
  ToolDef,
} from './types.ts';
import { ReferenceRuntime, REFERENCE_RUNTIME_ID } from './reference-runtime.ts';
import type { WebMcpRuntime } from './reference-runtime.ts';
import { discover, execute } from './bridge.ts';
import { validateInput, validateProvider } from './normalize.ts';

export { REFERENCE_RUNTIME_ID };

export interface ProviderTool {
  def: ToolDef;
  handler: (args: unknown) => ExecutionResult | Promise<ExecutionResult>;
}

export interface ProviderUnderTest {
  name: string;
  tools: ProviderTool[];
}

function checkEvidence(effect: ToolDef['effect'], result: ExecutionResult): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (effect === 'state-changing') {
    if (result.executed === true && (result.confirmationId === undefined || result.confirmationId === '')) {
      violations.push('state-changing tool reported executed:true without a confirmationId');
    }
  }
  if (result.executed === undefined || typeof result.executed !== 'boolean') {
    violations.push('ExecutionResult is missing a boolean "executed" field');
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Run one adapter against a given WebMcpRuntime (already carrying the registered provider) for
 * one task. This is the runtime-agnostic core — the SAME code path for the reference lane and
 * the real Chrome/WebMCP lane. `defs` are the provider's declared definitions (for effect +
 * static validation); the runtime supplies discovery + execution.
 */
export async function runPathOnRuntime(
  runtime: WebMcpRuntime,
  defs: ToolDef[],
  task: TaskSpec,
  adapter: ModelConsumerAdapter,
): Promise<PathObservation> {
  const identity = { adapterId: adapter.id, adapterVersion: adapter.version, modelId: adapter.modelId };

  // 1. Definition (static).
  const definition = validateProvider(defs);

  // 2. Browser/runtime health at discovery. If the runtime surface is unavailable or malformed,
  //    that is a browser_runtime fault — the engine attributes it there, provider NOT_REACHED,
  //    Provider PASS. (The Chrome-lane fault-isolation proof: Browser Runtime FAIL / Provider PASS.)
  let handles;
  try {
    handles = await runtime.getTools();
    if (!Array.isArray(handles)) throw new Error('getTools() did not return an array');
  } catch (err) {
    const steps: StepResults = {
      definition,
      browserRuntime: { ok: false, detail: err instanceof Error ? err.message : String(err) },
      discovery: { ok: false, names: [] },
      adapterFormat: { ok: true, normalizationApplied: [], droppedRequiredFields: [] },
      decision: { type: 'no_action', reason: 'runtime surface unavailable' },
      bridge: { attempted: false, ok: false },
      providerExec: { reached: false, ok: false },
      argsValidation: { checked: false, ok: true, missingOrInvalidFields: [] },
      evidence: { checked: false, ok: true, violations: [] },
    };
    return { ...identity, steps };
  }

  const discoveredNames = handles.map((h) => h.name);
  const missingClaimed = defs.map((d) => d.name).find((n) => !discoveredNames.includes(n));
  const discovery = {
    ok: missingClaimed === undefined,
    names: discoveredNames,
    ...(missingClaimed !== undefined ? { missingClaimedTool: missingClaimed } : {}),
  };

  const normalized = await discover(runtime, defs);

  // 3. The adapter decides (never executes).
  const decision = await adapter.plan({ task, tools: normalized });

  return { ...identity, steps: await observeDecisionOnRuntime(runtime, defs, decision, { definition, discovery }) };
}

/** Static + discovery context shared by every step observed against a runtime. */
export interface ObservationContext {
  definition: StepResults['definition'];
  discovery: StepResults['discovery'];
  /** How the adapter formatted the surface (default: a trivial, faithful format). */
  adapterFormat?: StepResults['adapterFormat'];
}

/**
 * Observe ONE already-made decision against a runtime, producing StepResults. This is the
 * single execution path shared by the single-decision runner (runPathOnRuntime) and every
 * step of the trajectory engine (Phase III) — the same-surface invariant expressed in code:
 * the bridge that executes is identical no matter who decided or how many steps precede it.
 */
export async function observeDecisionOnRuntime(
  runtime: WebMcpRuntime,
  defs: ToolDef[],
  decision: ConsumerDecision,
  ctx: ObservationContext,
): Promise<StepResults> {
  const adapterFormat = ctx.adapterFormat ?? { ok: true, normalizationApplied: [] as string[], droppedRequiredFields: [] as string[] };

  const base: StepResults = {
    definition: ctx.definition,
    browserRuntime: { ok: true },
    discovery: ctx.discovery,
    adapterFormat,
    decision,
    bridge: { attempted: false, ok: false },
    providerExec: { reached: false, ok: false },
    argsValidation: { checked: false, ok: true, missingOrInvalidFields: [] },
    evidence: { checked: false, ok: true, violations: [] },
  };

  // Non-tool_call decisions stop here; the engine derives the rest.
  if (decision.type !== 'tool_call') return base;

  const def = defs.find((d) => d.name === decision.toolName);
  if (!def) {
    // The model named a tool the surface never offered — the bridge can find no handle.
    return { ...base, bridge: { attempted: true, ok: false, toolName: decision.toolName, error: { code: 'bridge_no_handle', message: `no tool "${decision.toolName}"` } } };
  }

  // 4. Provider input validation (the provider rejects malformed input before executing).
  const av = validateInput(def.inputSchema, decision.arguments);
  if (!av.ok) {
    return {
      ...base,
      bridge: { attempted: true, ok: true, toolName: decision.toolName, arguments: decision.arguments },
      argsValidation: { checked: true, ok: false, missingOrInvalidFields: av.missingOrInvalidFields },
    };
  }

  // 5. Execute through the common bridge and collect evidence.
  const outcome = await execute(runtime, decision.toolName, decision.arguments);
  if (!outcome.ok) {
    return {
      ...base,
      bridge: { attempted: true, ok: false, toolName: decision.toolName, arguments: decision.arguments, ...(outcome.error ? { error: outcome.error } : {}) },
      argsValidation: { checked: true, ok: true, missingOrInvalidFields: [] },
    };
  }

  const result = outcome.executionResult as ExecutionResult;
  const ev = checkEvidence(def.effect, result);
  return {
    ...base,
    bridge: { attempted: true, ok: true, toolName: decision.toolName, arguments: decision.arguments },
    argsValidation: { checked: true, ok: true, missingOrInvalidFields: [] },
    providerExec: { reached: true, ok: true, firedTool: decision.toolName, firedEffect: def.effect },
    evidence: { checked: true, ok: ev.ok, executionResult: result, violations: ev.violations },
  };
}

/** Reference-lane convenience: register the provider on a fresh ReferenceRuntime, then run. */
export async function runPath(
  provider: ProviderUnderTest,
  task: TaskSpec,
  adapter: ModelConsumerAdapter,
): Promise<PathObservation> {
  const runtime = new ReferenceRuntime();
  for (const t of provider.tools) runtime.registerTool(t.def, t.handler);
  return runPathOnRuntime(runtime, provider.tools.map((t) => t.def), task, adapter);
}

/** Convenience: build a ConformanceCase by running each adapter against one provider/task. */
export async function buildCase(
  caseId: string,
  provider: ProviderUnderTest,
  task: TaskSpec,
  adapters: ModelConsumerAdapter[],
  expectedTool?: string,
): Promise<ConformanceCase> {
  const paths: PathObservation[] = [];
  for (const a of adapters) paths.push(await runPath(provider, task, a));
  return { caseId, task, ...(expectedTool !== undefined ? { expectedTool } : {}), paths };
}

/** Build a ConformanceCase against an arbitrary runtime (e.g. real Chrome/WebMCP). */
export async function buildCaseOnRuntime(
  caseId: string,
  runtime: WebMcpRuntime,
  defs: ToolDef[],
  task: TaskSpec,
  adapters: ModelConsumerAdapter[],
  expectedTool?: string,
): Promise<ConformanceCase> {
  const paths: PathObservation[] = [];
  for (const a of adapters) paths.push(await runPathOnRuntime(runtime, defs, task, a));
  return { caseId, task, ...(expectedTool !== undefined ? { expectedTool } : {}), paths };
}
