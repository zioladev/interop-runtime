// Trajectory report assembly — the versioned, machine-readable contract /2 (Phase III).
//
// Distinct from the /1 single-decision report (report.ts): a /2 report is trajectory-aware.
// Each consumer's report carries the ORDERED steps (each with its own Phase II attribution,
// never erased), the terminal state, the invariant results, and the trajectory judgment —
// then the trajectory-level divergence and the provider grade (provider-owned layers only).

import type { AttributionCategory, PathDerived, Verdict } from './types.ts';
import { evaluateTrajectoryCase } from './trajectory.ts';
import type { TrajectoryCase, TrajectoryDerived } from './trajectory.ts';
import { REPORT_GENERATOR, REPORT_GENERATOR_VERSION, TRAJECTORY_REPORT_VERSION } from './report-version.ts';
import type { ToolDef } from './types.ts';

function stableHash(value: unknown): string {
  const json = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a:${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export interface TrajectoryReportInput {
  providerName: string;
  declaredTools: ToolDef[];
  runtimeId: string;
  browserVersion: string | null;
  cases: TrajectoryCase[];
  /** Fixed timestamp for deterministic artifacts; defaults to now. */
  generatedAt?: string;
}

export interface TrajectoryConformanceReport {
  reportVersion: string;
  reportGenerator: string;
  reportGeneratorVersion: string;
  generatedAt: string;
  provider: {
    name: string;
    providerDefHash: string;
    declaredTools: Array<{ name: string; effect: string }>;
  };
  lane: { runtimeId: string; browserVersion: string | null; toolSurfaceHash: string };
  trajectories: Array<{
    caseId: string;
    trajectoryId: string;
    paths: Array<{
      adapterId: string;
      adapterVersion: string;
      modelId: string;
      route: string;
      terminalState: string;
      reachedRequiredTerminal: boolean;
      invariants: Array<{ kind: string; held: boolean; detail: string }>;
      /** Ordered per-step Phase II judgments — the trajectory never erases them (D25). */
      steps: Array<{
        index: number;
        outcome: string;
        disposition: string;
        firstOwner: AttributionCategory | 'none';
        providerNonconformance: boolean;
      }>;
      trajectoryConformance: Verdict;
      providerNonconformance: boolean;
      attribution: TrajectoryDerived['attribution'];
    }>;
    divergence: {
      pathDifference: boolean;
      terminalStateDifference: boolean;
      trajectoryConformanceDifference: boolean;
      byPath: Record<string, { path: string; terminal: string; conformance: Verdict; providerGrade: Verdict }>;
    };
    provider: Verdict;
  }>;
  summary: {
    provider: Verdict;
    byLayer: Record<string, Verdict>;
    notes: Array<{ layer: string; verdict: Verdict; signal: string; detail: string }>;
  };
}

export function assembleTrajectoryReport(input: TrajectoryReportInput): TrajectoryConformanceReport {
  const providerDefHash = stableHash(input.declaredTools);
  const toolSurfaceHash = stableHash(input.declaredTools.map((t) => ({ name: t.name, inputSchema: t.inputSchema, effect: t.effect })));

  const notes: TrajectoryConformanceReport['summary']['notes'] = [];
  const byLayer: Record<string, Verdict> = {};
  let providerGrade: Verdict = 'PASS';

  const rank: Record<Verdict, number> = { PASS: 0, NOT_REACHED: 0, WARN: 1, FAIL: 2 };
  const bump = (key: string, v: Verdict): void => {
    if (byLayer[key] === undefined || rank[v] > rank[byLayer[key]]) byLayer[key] = v;
  };

  const trajectories = input.cases.map((c) => {
    const { deriveds, divergence, provider } = evaluateTrajectoryCase(c);
    if (provider === 'FAIL') providerGrade = 'FAIL';
    else if (provider === 'WARN' && providerGrade === 'PASS') providerGrade = 'WARN';

    const paths = c.observations.map((o, i) => {
      const d = deriveds[i] as TrajectoryDerived;
      for (const a of d.attribution) {
        bump(a.category, a.verdict);
        notes.push({ layer: a.category, verdict: a.verdict, signal: a.signal, detail: a.detail });
      }
      bump(o.adapterId, d.trajectoryConformance);
      return {
        adapterId: o.adapterId,
        adapterVersion: o.adapterVersion,
        modelId: o.modelId,
        route: d.pathKey || '(no execution)',
        terminalState: d.terminalKey,
        reachedRequiredTerminal: d.reachedRequiredTerminal,
        invariants: d.invariantResults.map((r) => ({ kind: r.invariant.kind, held: r.held, detail: r.detail })),
        steps: d.stepDeriveds.map((s: PathDerived, idx) => ({
          index: idx,
          outcome: s.outcome,
          disposition: s.disposition,
          firstOwner: (s.attribution[0]?.category ?? 'none') as AttributionCategory | 'none',
          providerNonconformance: s.providerNonconformance,
        })),
        trajectoryConformance: d.trajectoryConformance,
        providerNonconformance: d.providerNonconformance,
        attribution: d.attribution,
      };
    });

    return {
      caseId: c.caseId,
      trajectoryId: c.spec.trajectoryId,
      paths,
      divergence,
      provider,
    };
  });

  byLayer['provider'] = providerGrade;

  return {
    reportVersion: TRAJECTORY_REPORT_VERSION,
    reportGenerator: REPORT_GENERATOR,
    reportGeneratorVersion: REPORT_GENERATOR_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    provider: {
      name: input.providerName,
      providerDefHash,
      declaredTools: input.declaredTools.map((t) => ({ name: t.name, effect: t.effect })),
    },
    lane: { runtimeId: input.runtimeId, browserVersion: input.browserVersion, toolSurfaceHash },
    trajectories,
    summary: { provider: providerGrade, byLayer, notes },
  };
}
