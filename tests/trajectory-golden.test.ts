// The Phase III golden gate (report contract /2). Six trajectories with KNOWN, authored-in-
// advance attribution truth. They run through the SAME common bridge as Phase II and are
// judged by the SAME per-step engine, then the trajectory layer's ordering / state-propagation
// / terminal / orchestration judgment sits above. The two clauses that make 3A real:
//
//   - a golden SEQUENCING fault attributes to `trajectory_orchestration` (T2, T3);
//   - and doing so NEVER alters the provider grade (the provider is not at fault for the
//     orchestrator's mistake).
//
// See docs/provider-conformance/15.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeScriptedTrajectoryAdapter,
  runTrajectory,
  buildTrajectoryCase,
  evaluateTrajectory,
  evaluateTrajectoryCase,
  assembleTrajectoryReport,
  REFERENCE_RUNTIME_ID,
  TRAJECTORY_REPORT_VERSION,
} from '../src/index.ts';
import type { ConsumerDecision } from '../src/index.ts';
import { journeyProvider, makeJourneyProvider, coffeeJourney } from './sample-provider.ts';

const inspect: ConsumerDecision = { type: 'tool_call', toolName: 'lookup_drink', arguments: { query: 'latte' } };
const inspectMenu: ConsumerDecision = { type: 'tool_call', toolName: 'lookup_drink', arguments: { query: 'menu' } };
const commit: ConsumerDecision = { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
const commitWrongItem: ConsumerDecision = { type: 'tool_call', toolName: 'place_order', arguments: { item: 'espresso', size: 'M' } };
const wrongTool: ConsumerDecision = { type: 'tool_call', toolName: 'cancel_order', arguments: {} };

function firstOwner(attribution: ReadonlyArray<{ category: string }>): string {
  return attribution[0]?.category ?? 'none';
}

// T1 — valid inspect -> commit -> done: PASS.
test('T1 happy trajectory: inspect -> commit is conformant, provider PASS', async () => {
  const adapter = makeScriptedTrajectoryAdapter({ id: 'scripted', steps: [inspect, commit] });
  const obs = await runTrajectory(journeyProvider, coffeeJourney, adapter);
  const d = evaluateTrajectory(obs, coffeeJourney);

  assert.equal(firstOwner(d.attribution), 'none', 'no fault');
  assert.equal(d.trajectoryConformance, 'PASS');
  assert.equal(d.providerGrade, 'PASS');
  assert.equal(d.providerNonconformance, false);
  assert.deepEqual(d.terminalState, { kind: 'committed', tool: 'place_order' });
  assert.equal(d.reachedRequiredTerminal, true);
  assert.ok(d.invariantResults.every((r) => r.held), 'all invariants hold');

  // Per-step Phase II evidence is preserved and correct (D25).
  assert.equal(d.stepDeriveds.length, 2);
  assert.equal(d.stepDeriveds[0].disposition, 'inspected', 'step 1 was a read');
  assert.equal(d.stepDeriveds[1].disposition, 'acted', 'step 2 was a state change');
  assert.equal(d.pathKey, 'inspect:lookup_drink -> commit:place_order');
});

// T2 — commit before inspect: trajectory_orchestration (step itself valid).
test('T2 commit before inspect: -> trajectory_orchestration, provider PASS', async () => {
  const adapter = makeScriptedTrajectoryAdapter({ id: 'scripted', steps: [commit] });
  const obs = await runTrajectory(journeyProvider, coffeeJourney, adapter);
  const d = evaluateTrajectory(obs, coffeeJourney);

  assert.equal(firstOwner(d.attribution), 'trajectory_orchestration');
  assert.equal(d.trajectoryConformance, 'FAIL');
  // The commit step itself was a clean execution — provider is NOT at fault.
  assert.equal(d.providerGrade, 'PASS', 'orchestration fault must not touch provider grade');
  assert.equal(d.providerNonconformance, false);
  assert.equal(d.stepDeriveds[0].outcome, 'executed', 'the step itself succeeded');
  assert.equal(d.stepDeriveds[0].attribution.length, 0, 'the step itself carries no fault');
  const ord = d.invariantResults.find((r) => r.invariant.kind === 'inspect_before_commit');
  assert.ok(ord && !ord.held, 'inspect_before_commit was violated');
});

// T3 — inspect succeeds but its output is not carried forward: trajectory_orchestration.
test('T3 prior output not carried forward: -> trajectory_orchestration, provider PASS', async () => {
  const adapter = makeScriptedTrajectoryAdapter({ id: 'scripted', steps: [inspect, commitWrongItem] });
  const obs = await runTrajectory(journeyProvider, coffeeJourney, adapter);
  const d = evaluateTrajectory(obs, coffeeJourney);

  assert.equal(firstOwner(d.attribution), 'trajectory_orchestration');
  assert.equal(d.trajectoryConformance, 'FAIL');
  assert.equal(d.providerGrade, 'PASS');
  assert.equal(d.providerNonconformance, false);
  // Both steps executed cleanly at the Phase II layer — the fault is purely orchestration.
  assert.ok(d.stepDeriveds.every((s) => s.attribution.length === 0), 'no per-step fault');
  const prop = d.invariantResults.find((r) => r.invariant.kind === 'commit_uses_prior_output');
  assert.ok(prop && !prop.held, 'commit_uses_prior_output was violated');
});

// T4 — wrong tool selected at step 2: model_tool_selection, NOT orchestration.
test('T4 wrong tool at step 2: -> model_tool_selection (not orchestration), provider PASS', async () => {
  const adapter = makeScriptedTrajectoryAdapter({ id: 'scripted', steps: [inspect, wrongTool] });
  const obs = await runTrajectory(journeyProvider, coffeeJourney, adapter);
  const d = evaluateTrajectory(obs, coffeeJourney);

  assert.equal(firstOwner(d.attribution), 'model_tool_selection');
  assert.ok(!d.attribution.some((a) => a.category === 'trajectory_orchestration'),
    'a wrong tool INSIDE a step must not be charged to orchestration');
  assert.equal(d.trajectoryConformance, 'FAIL');
  assert.equal(d.providerGrade, 'PASS');
  assert.equal(d.providerNonconformance, false);
});

// T5 — provider returns bad evidence during a valid trajectory: evidence_contract (provider-owned).
test('T5 bad provider evidence mid-trajectory: -> evidence_contract, provider FAIL', async () => {
  const faulty = makeJourneyProvider({ faultyEvidence: true });
  const adapter = makeScriptedTrajectoryAdapter({ id: 'scripted', steps: [inspect, commit] });
  const obs = await runTrajectory(faulty, coffeeJourney, adapter);
  const d = evaluateTrajectory(obs, coffeeJourney);

  assert.equal(firstOwner(d.attribution), 'evidence_contract');
  assert.equal(d.providerNonconformance, true);
  assert.equal(d.providerGrade, 'FAIL');
  // The orchestration itself was correct — the provider broke, not the journey logic.
  assert.equal(d.trajectoryConformance, 'PASS', 'the trajectory logic was correct');
  assert.ok(!d.attribution.some((a) => a.category === 'trajectory_orchestration'));
});

// T6 — two different valid routes reach the same terminal state: path difference only.
test('T6 different valid routes, same terminal: pathDifference only, no conformance failure', async () => {
  const twoInspects = makeScriptedTrajectoryAdapter({ id: 'gpt', modelId: 'gpt/x', steps: [inspectMenu, inspect, commit] });
  const oneInspect = makeScriptedTrajectoryAdapter({ id: 'claude', modelId: 'claude/x', steps: [inspect, commit] });
  const c = await buildTrajectoryCase('T6', journeyProvider, coffeeJourney, [twoInspects, oneInspect]);
  const { deriveds, divergence, provider } = evaluateTrajectoryCase(c);

  assert.equal(divergence.pathDifference, true, 'routes differ');
  assert.equal(divergence.terminalStateDifference, false, 'same terminal state');
  assert.equal(divergence.trajectoryConformanceDifference, false, 'both conform');
  assert.equal(provider, 'PASS');
  assert.ok(deriveds.every((d) => d.trajectoryConformance === 'PASS'), 'both routes conform');
  assert.ok(deriveds.every((d) => d.attribution.length === 0), 'divergence is not failure');
});

// The success-criterion clause, made explicit at the report level: a /2 report is emitted,
// and a trajectory_orchestration FAIL leaves the provider grade PASS.
test('report /2: orchestration fault is reported without altering provider grade', async () => {
  const bad = makeScriptedTrajectoryAdapter({ id: 'scripted', steps: [commit] }); // commit-before-inspect
  const c = await buildTrajectoryCase('R', journeyProvider, coffeeJourney, [bad]);
  const report = assembleTrajectoryReport({
    providerName: journeyProvider.name,
    declaredTools: journeyProvider.tools.map((t) => t.def),
    runtimeId: REFERENCE_RUNTIME_ID,
    browserVersion: null,
    cases: [c],
    generatedAt: '2026-08-10T00:00:00.000Z',
  });

  assert.equal(report.reportVersion, TRAJECTORY_REPORT_VERSION);
  assert.equal(report.summary.provider, 'PASS', 'provider grade unaffected by orchestration fault');
  assert.equal(report.summary.byLayer['trajectory_orchestration'], 'FAIL', 'the orchestration fault is recorded');
  const path0 = report.trajectories[0].paths[0];
  assert.equal(path0.trajectoryConformance, 'FAIL');
  assert.equal(path0.providerNonconformance, false);
  // The report carries the ordered per-step Phase II view — the journey is not collapsed.
  assert.ok(path0.steps.length >= 1);
});
