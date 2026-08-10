// Multi-provider trajectory report — still the /2 contract (Phase III), now populated across
// PROVIDERS. It records each leg's provider identity + Phase II judgment, the lineage-bearing
// carried state, the terminal-attainment verdict, and the trajectory judgment — with the
// provider grade computed from provider-owned layers ONLY, so an orchestration or lane fault
// never becomes provider nonconformance.

import type { AttributionCategory, CarriedValue, Verdict } from './types.ts';
import { evaluateMultiProviderTrajectory } from './trajectory-multi.ts';
import type { MultiProviderTrajectoryCase } from './trajectory-multi.ts';
import { REPORT_GENERATOR, REPORT_GENERATOR_VERSION, TRAJECTORY_REPORT_VERSION } from './report-version.ts';

export interface MultiProviderReportInput {
  cases: MultiProviderTrajectoryCase[];
  runtimeId: string;
  browserVersion: string | null;
  generatedAt?: string;
}

export interface MultiProviderTrajectoryReport {
  reportVersion: string;
  reportGenerator: string;
  reportGeneratorVersion: string;
  generatedAt: string;
  trajectories: Array<{
    caseId: string;
    trajectoryId: string;
    providers: Array<{ id: string; origin: string; toolEndpoint?: string }>;
    route: string;
    terminalAttained: boolean;
    trajectoryConformance: Verdict;
    providerNonconformance: boolean;
    provider: Verdict;
    legs: Array<{
      stepId: string;
      providerId: string;
      transitionReady: boolean;
      outcome: string;
      disposition: string;
      firstOwner: AttributionCategory | 'none';
      providerNonconformance: boolean;
    }>;
    carried: Array<{ key: string; producedBy: CarriedValue['producedBy']; evidenceRef?: string }>;
    invariants: Array<{ stepId: string; kind: string; held: boolean; detail: string }>;
    attribution: Array<{ category: string; verdict: string; signal: string; detail: string }>;
  }>;
  summary: { provider: Verdict; byLayer: Record<string, Verdict>; notes: Array<{ layer: string; verdict: string; signal: string; detail: string }> };
}

export function assembleMultiProviderTrajectoryReport(input: MultiProviderReportInput): MultiProviderTrajectoryReport {
  const rank: Record<Verdict, number> = { PASS: 0, NOT_REACHED: 0, WARN: 1, FAIL: 2 };
  const byLayer: Record<string, Verdict> = {};
  const notes: MultiProviderTrajectoryReport['summary']['notes'] = [];
  let providerGrade: Verdict = 'PASS';
  const bump = (k: string, v: Verdict): void => { if (byLayer[k] === undefined || rank[v] > rank[byLayer[k]]) byLayer[k] = v; };

  const trajectories = input.cases.map((c) => {
    const d = evaluateMultiProviderTrajectory(c.observation, c.spec);
    if (d.providerGrade === 'FAIL') providerGrade = 'FAIL';
    for (const a of d.attribution) { bump(a.category, a.verdict); notes.push({ layer: a.category, verdict: a.verdict, signal: a.signal, detail: a.detail }); }

    return {
      caseId: c.caseId,
      trajectoryId: c.spec.trajectoryId,
      providers: c.spec.providers.map((p) => ({ id: p.id, origin: p.origin, ...(p.toolEndpoint !== undefined ? { toolEndpoint: p.toolEndpoint } : {}) })),
      route: d.routeKey || '(no execution)',
      terminalAttained: d.terminalAttained,
      trajectoryConformance: d.trajectoryConformance,
      providerNonconformance: d.providerNonconformance,
      provider: d.providerGrade,
      legs: c.observation.records.map((r, i) => ({
        stepId: r.step.stepId,
        providerId: r.step.provider.id,
        transitionReady: r.transition.surfaceReady,
        outcome: d.stepDeriveds[i]?.outcome ?? 'unknown',
        disposition: d.stepDeriveds[i]?.disposition ?? 'unknown',
        firstOwner: (d.stepDeriveds[i]?.attribution[0]?.category ?? 'none') as AttributionCategory | 'none',
        providerNonconformance: d.stepDeriveds[i]?.providerNonconformance ?? false,
      })),
      carried: c.observation.carried.map((cv) => ({ key: cv.key, producedBy: cv.producedBy, ...(cv.evidenceRef !== undefined ? { evidenceRef: cv.evidenceRef } : {}) })),
      invariants: d.invariantResults.map((r) => ({ stepId: r.stepId, kind: r.kind, held: r.held, detail: r.detail })),
      attribution: d.attribution.map((a) => ({ category: a.category, verdict: a.verdict, signal: a.signal, detail: a.detail })),
    };
  });

  byLayer['provider'] = providerGrade;

  return {
    reportVersion: TRAJECTORY_REPORT_VERSION,
    reportGenerator: REPORT_GENERATOR,
    reportGeneratorVersion: REPORT_GENERATOR_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    trajectories,
    summary: { provider: providerGrade, byLayer, notes },
  };
}
