// The cross-model trajectory layer (Phase III / 3C).
//
// The Phase III question, at its richest: given the SAME frozen multi-provider trajectory spec,
// the SAME starting state, the SAME provider surfaces, the SAME authoritative carried-state model,
// the SAME common execution bridge, and the SAME terminal-state rules — do Claude, GPT, and Gemini
// each reach an allowable terminal state, and where do their trajectories diverge?
//
// Two laws govern the comparison:
//
//   "Different path does not equal failure." (Phase II's rule, lifted to trajectories.) Two models
//   that take different but valid routes to the same allowable terminal state, preserving carried
//   state and satisfying every invariant, are BOTH conformant — path difference, not failure.
//
//   D38 — Trajectory comparison is based on OBSERVED EXECUTIONS and AUTHORITATIVE CARRIED STATE,
//   never on the model's narration of progress. A step is attained only when the common bridge
//   actually executed the provider tool; a model that says "done" without executing has not
//   attained anything (this is D36/FX2 turned into a comparison rule).
//
// Nothing new executes here: each model runs the exact same multi-provider engine (§16). This
// module only RUNS N model adapters over one frozen spec and COMPARES the resulting trajectories.

import type { ModelConsumerAdapter, Verdict } from './types.ts';
import type { ProviderUnderTest } from './run-case.ts';
import { runMultiProviderTrajectoryOnReference, evaluateMultiProviderTrajectory } from './trajectory-multi.ts';
import type { MultiProviderTrajectorySpec, MultiProviderTrajectoryObservation, MultiProviderTrajectoryDerived } from './trajectory-multi.ts';

export interface CrossModelTrajectoryResult {
  adapterId: string;
  adapterVersion: string;
  modelId: string;
  observation: MultiProviderTrajectoryObservation;
  derived: MultiProviderTrajectoryDerived;
}

/**
 * Run each model adapter over the SAME frozen multi-provider spec. Each model gets a FRESH set of
 * provider surfaces (a fresh reference resolver), so one model's state never bleeds into another's
 * — the only thing shared is the frozen spec, the provider definitions, and the measurement.
 */
export async function runCrossModelTrajectory(
  providers: Record<string, ProviderUnderTest>,
  spec: MultiProviderTrajectorySpec,
  adapters: ModelConsumerAdapter[],
): Promise<CrossModelTrajectoryResult[]> {
  const results: CrossModelTrajectoryResult[] = [];
  for (const a of adapters) {
    const observation = await runMultiProviderTrajectoryOnReference(providers, spec, a);
    const derived = evaluateMultiProviderTrajectory(observation, spec);
    results.push({ adapterId: a.id, adapterVersion: a.version, modelId: a.modelId, observation, derived });
  }
  return results;
}

export interface CrossModelPerModel {
  modelId: string;
  route: string;
  terminalAttained: boolean;
  trajectoryConformance: Verdict;
  providerGrade: Verdict;
  firstOwner: string;
}

export interface CrossModelComparison {
  trajectoryId: string;
  byModel: Record<string, CrossModelPerModel>;
  /** Do the executed routes differ across models? (Different route != wrong.) */
  pathDifference: boolean;
  /** Do the models reach different terminal-attainment outcomes? */
  terminalStateDifference: boolean;
  /** Do the models differ in trajectory conformance? */
  trajectoryConformanceDifference: boolean;
  /** The provider grade across ALL models — provider-owned layers only. */
  provider: Verdict;
  /** The convergence success: every model reached the allowable terminal state AND conformed. */
  converged: boolean;
}

function firstOwnerOf(d: MultiProviderTrajectoryDerived): string {
  return d.attribution[0]?.category ?? 'none';
}

/**
 * Compare the models' trajectories. Path differences are recorded but never, on their own, a
 * failure: the meaningful divergence is a different terminal state, a violated invariant, or a
 * conformance difference.
 */
export function compareCrossModelTrajectory(
  trajectoryId: string,
  results: CrossModelTrajectoryResult[],
): CrossModelComparison {
  const byModel: Record<string, CrossModelPerModel> = {};
  for (const r of results) {
    byModel[r.adapterId] = {
      modelId: r.modelId,
      route: r.derived.routeKey || '(no execution)',
      terminalAttained: r.derived.terminalAttained,
      trajectoryConformance: r.derived.trajectoryConformance,
      providerGrade: r.derived.providerGrade,
      firstOwner: firstOwnerOf(r.derived),
    };
  }
  const distinct = (xs: string[]): boolean => new Set(xs).size > 1;
  const provider: Verdict = results.some((r) => r.derived.providerGrade === 'FAIL') ? 'FAIL' : 'PASS';
  const converged = results.length > 0 && results.every((r) => r.derived.terminalAttained && r.derived.trajectoryConformance === 'PASS');

  return {
    trajectoryId,
    byModel,
    pathDifference: distinct(results.map((r) => r.derived.routeKey)),
    terminalStateDifference: distinct(results.map((r) => String(r.derived.terminalAttained))),
    trajectoryConformanceDifference: distinct(results.map((r) => `${r.derived.trajectoryConformance}/${r.derived.providerGrade}`)),
    provider,
    converged,
  };
}

/** Render the human-facing cross-model artifact (the "where did the trajectories diverge?" view). */
export function renderCrossModelArtifact(
  results: CrossModelTrajectoryResult[],
  comparison: CrossModelComparison,
): string {
  const lines: string[] = [];
  lines.push(`Trajectory: ${comparison.trajectoryId}`);
  lines.push('');
  for (const r of results) {
    const m = comparison.byModel[r.adapterId];
    if (!m) continue;
    lines.push(`${r.adapterId} (${m.modelId})`);
    lines.push(`  Path: ${m.route}`);
    lines.push(`  Terminal: ${m.terminalAttained ? 'attained' : 'not attained'}`);
    lines.push(`  Conformant: ${m.trajectoryConformance}`);
    if (m.trajectoryConformance !== 'PASS') lines.push(`  Attribution: ${m.firstOwner}`);
    lines.push('');
  }
  lines.push(`Provider: ${comparison.provider}`);
  lines.push(
    `Cross-model: path difference: ${comparison.pathDifference ? 'yes' : 'no'} · ` +
    `terminal difference: ${comparison.terminalStateDifference ? 'yes' : 'no'} · ` +
    `conformance difference: ${comparison.trajectoryConformanceDifference ? 'yes' : 'no'}`,
  );
  if (comparison.converged) {
    lines.push('Convergence: all models reached the allowable terminal state and conformed' + (comparison.pathDifference ? ' (via different valid paths).' : '.'));
  }
  return lines.join('\n');
}
