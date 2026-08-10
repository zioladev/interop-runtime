// The Phase III / 3B golden gate — multi-provider trajectories with lineage-bearing carried
// state. The thing production never truly had: a value produced by one provider's step,
// carried WITH provenance into a later provider's step, and attributed when the journey logic
// around it breaks. Every leg still runs through the SAME common bridge and the SAME per-leg
// engine as Phase II; the multi-provider layer only judges ABOVE the legs.
//
// Two architectural invariants are asserted here as law:
//   D36 — model memory is never authoritative trajectory state (carried state is built from
//         observed evidence; the model's binding claim can't override it).
//   D37 — completing the loop is not completing the trajectory (terminal comes from the frozen
//         predicate, not "all planned steps iterated").
//
// See docs/provider-conformance/16.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeScriptedTrajectoryAdapter,
  runMultiProviderTrajectoryOnReference,
  evaluateMultiProviderTrajectory,
  assembleMultiProviderTrajectoryReport,
  REFERENCE_RUNTIME_ID,
  TRAJECTORY_REPORT_VERSION,
} from '../src/index.ts';
import type { MultiProviderTrajectorySpec, ProviderRef, PlanInput, ConsumerDecision } from '../src/index.ts';
import { cafeProvider, makeCafeProvider, bakeryProvider } from './sample-provider.ts';

const CAFE: ProviderRef = { id: 'cafe', origin: 'cafe.example', toolEndpoint: 'https://cafe.example/order' };
const BAKERY: ProviderRef = { id: 'bakery', origin: 'bakery.example', toolEndpoint: 'https://bakery.example/counter' };

const providers = { cafe: cafeProvider, bakery: bakeryProvider };

function firstOwner(attribution: ReadonlyArray<{ category: string }>): string {
  return attribution[0]?.category ?? 'none';
}

/** The canonical two-provider spec: cafe places an order → bakery adds a pastry to THAT order. */
function orderThenPastrySpec(over: Partial<MultiProviderTrajectorySpec> = {}): MultiProviderTrajectorySpec {
  return {
    trajectoryId: 'order-then-pastry/1',
    text: 'Order a latte at the cafe, then add a croissant to that order at the bakery.',
    providers: [CAFE, BAKERY],
    steps: [
      { stepId: 's1', seq: 1, provider: CAFE, intent: 'place_order', allowedTools: ['lookup_drink', 'place_order'], publishes: [{ key: 'orderId', fromField: 'orderId' }], commitRequired: true },
      { stepId: 's2', seq: 2, provider: BAKERY, intent: 'add_pastry', allowedTools: ['list_pastries', 'add_pastry'], requiredInputs: [{ argKey: 'orderId', fromKey: 'orderId' }], dependsOn: ['s1'], commitRequired: true },
    ],
    ...over,
  };
}

// A trajectory-aware scripted consumer: step 1 orders; step 2 reads the carried orderId (from
// the cafe's evidence) and uses it at the bakery. This exercises real cross-provider carry.
function carryingConsumer(pastryOrderId?: (input: PlanInput) => unknown) {
  return makeScriptedTrajectoryAdapter({
    id: 'scripted', modelId: 'scripted/mp',
    steps: (input: PlanInput): ConsumerDecision => {
      const i = input.history?.length ?? 0;
      if (i === 0) return { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
      const orderId = pastryOrderId ? pastryOrderId(input) : input.carried?.find((c) => c.key === 'orderId')?.value;
      return { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId, pastry: 'croissant' }, bindings: [{ argKey: 'orderId', fromKey: 'orderId' }] };
    },
  });
}

// G3B-1 — successful cross-provider provenance carry.
test('G3B-1 carry success: cafe orderId flows to the bakery; PASS with provenance', async () => {
  const obs = await runMultiProviderTrajectoryOnReference(providers, orderThenPastrySpec(), carryingConsumer());
  const d = evaluateMultiProviderTrajectory(obs, orderThenPastrySpec());

  assert.equal(firstOwner(d.attribution), 'none');
  assert.equal(d.trajectoryConformance, 'PASS');
  assert.equal(d.providerGrade, 'PASS');
  assert.equal(d.terminalAttained, true, 'both commit-required legs committed');
  assert.equal(d.routeKey, 'cafe/commit:place_order -> bakery/commit:add_pastry');

  // The carried value carries LINEAGE: which step, which provider, which tool produced it.
  const carried = obs.carried.find((c) => c.key === 'orderId');
  assert.ok(carried, 'orderId was carried');
  assert.deepEqual(carried.producedBy, { stepId: 's1', providerId: 'cafe', toolName: 'place_order' });
  assert.equal(carried.value, 'CAFE-ORDER');
  // s2 actually used it.
  assert.ok(d.invariantResults.some((r) => r.stepId === 's2' && r.kind === 'carried_input_used' && r.held));
  // Per-leg Phase II evidence is preserved (D25).
  assert.equal(d.stepDeriveds.length, 2);
  assert.equal(d.stepDeriveds[0].disposition, 'acted');
  assert.equal(d.stepDeriveds[1].disposition, 'acted');
});

// G3B-2 — a required carried value that no prior step produced → trajectory_orchestration.
test('G3B-2 missing carried input: -> trajectory_orchestration, provider PASS', async () => {
  // s1 only INSPECTS (a read that yields no orderId); s2 still requires orderId.
  const spec = orderThenPastrySpec({
    steps: [
      { stepId: 's1', seq: 1, provider: CAFE, intent: 'lookup', allowedTools: ['lookup_drink', 'place_order'], publishes: [{ key: 'orderId', fromField: 'orderId' }] },
      { stepId: 's2', seq: 2, provider: BAKERY, intent: 'add_pastry', allowedTools: ['add_pastry'], requiredInputs: [{ argKey: 'orderId', fromKey: 'orderId' }], commitRequired: true },
    ],
  });
  const adapter = makeScriptedTrajectoryAdapter({
    id: 'scripted',
    steps: (input: PlanInput): ConsumerDecision => {
      const i = input.history?.length ?? 0;
      if (i === 0) return { type: 'tool_call', toolName: 'lookup_drink', arguments: { query: 'latte' } };
      return { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId: 'INVENTED', pastry: 'croissant' } };
    },
  });
  const obs = await runMultiProviderTrajectoryOnReference(providers, spec, adapter);
  const d = evaluateMultiProviderTrajectory(obs, spec);

  assert.equal(firstOwner(d.attribution), 'trajectory_orchestration');
  assert.equal(d.providerGrade, 'PASS');
  assert.equal(d.providerNonconformance, false);
  assert.ok(d.invariantResults.some((r) => r.stepId === 's2' && r.kind === 'missing_carried_input' && !r.held));
});

// G3B-3 — downstream step runs despite an unsatisfied prerequisite → trajectory_orchestration
// (FX5). The prerequisite is a non-required inspect the model skipped; s2 barrels ahead anyway.
// This isolates the RUNTIME fault: it advanced a dependent leg past an unsatisfied prerequisite.
test('G3B-3 dependency after prerequisite failure: -> trajectory_orchestration', async () => {
  const spec = orderThenPastrySpec({
    steps: [
      { stepId: 's1', seq: 1, provider: CAFE, intent: 'lookup', allowedTools: ['lookup_drink'] },
      { stepId: 's2', seq: 2, provider: BAKERY, intent: 'add_pastry', allowedTools: ['add_pastry'], dependsOn: ['s1'], commitRequired: true },
    ],
  });
  // s1's inspect is skipped (prerequisite unsatisfied); s2 barrels ahead and commits anyway.
  const adapter = makeScriptedTrajectoryAdapter({
    id: 'scripted',
    steps: (input: PlanInput): ConsumerDecision => {
      const i = input.history?.length ?? 0;
      if (i === 0) return { type: 'no_action', reason: 'skipped the lookup' };
      return { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId: 'CAFE-ORDER', pastry: 'croissant' } };
    },
  });
  const obs = await runMultiProviderTrajectoryOnReference(providers, spec, adapter);
  const d = evaluateMultiProviderTrajectory(obs, spec);

  assert.equal(firstOwner(d.attribution), 'trajectory_orchestration');
  assert.equal(d.providerGrade, 'PASS');
  assert.ok(d.invariantResults.some((r) => r.stepId === 's2' && r.kind === 'dependency_after_failure' && !r.held));
});

// G3B-4 — every planned step iterated, but the trajectory is NOT complete (D37). The model
// cleanly declined the required commit, so the OWNER is the model (D38), while the trajectory
// records terminal-not-attained as the observation.
test('G3B-4 loop completed but terminal not attained (D37): model declined -> model_tool_selection', async () => {
  const spec = orderThenPastrySpec();
  // s1 commits; s2 defers — the loop runs both planned steps, but s2's required commit never happens.
  const adapter = makeScriptedTrajectoryAdapter({
    id: 'scripted',
    steps: (input: PlanInput): ConsumerDecision => {
      const i = input.history?.length ?? 0;
      if (i === 0) return { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
      return { type: 'no_action', reason: 'forgot the pastry' };
    },
  });
  const obs = await runMultiProviderTrajectoryOnReference(providers, spec, adapter);
  const d = evaluateMultiProviderTrajectory(obs, spec);

  assert.equal(obs.records.length, spec.steps.length, 'the loop iterated every planned step');
  assert.equal(d.terminalAttained, false, 'yet the trajectory is not complete');
  // The runtime did NOT advance on the decline; the first incorrect decision is the model's (D38).
  assert.equal(firstOwner(d.attribution), 'model_tool_selection');
  assert.ok(!d.attribution.some((a) => a.category === 'trajectory_orchestration'), 'the runtime behaved correctly — not an orchestration fault');
  assert.ok(d.invariantResults.some((r) => r.stepId === 's2' && r.kind === 'terminal_not_attained' && !r.held));
  assert.equal(d.providerGrade, 'PASS');
});

// G3B-5 — inspected the provider but the required state-changing commit never happened (FX7):
// a model decision, not an orchestration fault (D38).
test('G3B-5 inspected but required commit never occurred: -> model_tool_selection', async () => {
  const spec: MultiProviderTrajectorySpec = {
    trajectoryId: 'inspect-not-commit/1',
    text: 'Place the order.',
    providers: [CAFE],
    steps: [{ stepId: 's1', seq: 1, provider: CAFE, intent: 'place_order', allowedTools: ['lookup_drink', 'place_order'], commitRequired: true }],
  };
  const adapter = makeScriptedTrajectoryAdapter({ id: 'scripted', steps: [{ type: 'tool_call', toolName: 'lookup_drink', arguments: { query: 'latte' } }] });
  const obs = await runMultiProviderTrajectoryOnReference(providers, spec, adapter);
  const d = evaluateMultiProviderTrajectory(obs, spec);

  assert.equal(d.stepDeriveds[0].disposition, 'inspected', 'the leg inspected (a read)');
  assert.equal(d.terminalAttained, false);
  assert.equal(firstOwner(d.attribution), 'model_tool_selection');
  assert.ok(d.invariantResults.some((r) => r.kind === 'terminal_not_attained' && !r.held));
  assert.equal(d.providerGrade, 'PASS');
});

// G3B-6 — a provider breaks its evidence contract mid-journey → evidence_contract, provider FAIL.
test('G3B-6 provider fault mid-journey: -> evidence_contract, provider FAIL, orchestration clean', async () => {
  const faultyCafe = makeCafeProvider({ faultyEvidence: true });
  const obs = await runMultiProviderTrajectoryOnReference({ cafe: faultyCafe, bakery: bakeryProvider }, orderThenPastrySpec(), carryingConsumer());
  const d = evaluateMultiProviderTrajectory(obs, orderThenPastrySpec());

  assert.equal(firstOwner(d.attribution), 'evidence_contract');
  assert.equal(d.providerGrade, 'FAIL');
  assert.equal(d.providerNonconformance, true);
  assert.ok(!d.attribution.some((a) => a.category === 'trajectory_orchestration'), 'the orchestration itself was correct');
});

// D36 — the model's binding CLAIM cannot override authoritative carried state.
test('D36 model memory is not authoritative: a false binding value is caught, not trusted', async () => {
  // s2 CLAIMS to bind orderId but supplies a value that is NOT the carried one.
  const adapter = carryingConsumer(() => 'WRONG-ORDER');
  const obs = await runMultiProviderTrajectoryOnReference(providers, orderThenPastrySpec(), adapter);
  const d = evaluateMultiProviderTrajectory(obs, orderThenPastrySpec());

  // The authoritative carried value remains the cafe's real orderId, from evidence.
  const carried = obs.carried.find((c) => c.key === 'orderId');
  assert.equal(carried?.value, 'CAFE-ORDER');
  // And the engine flags that s2 did not actually carry it forward — the claim didn't launder it.
  assert.equal(firstOwner(d.attribution), 'trajectory_orchestration');
  assert.ok(d.invariantResults.some((r) => r.stepId === 's2' && r.kind === 'carried_input_not_used' && !r.held));
  assert.equal(d.providerGrade, 'PASS');
});

// Report /2 (multi-provider): the carried lineage is recorded and provider grade stays isolated.
test('report /2 multi-provider: records provenance; orchestration fault keeps provider PASS', async () => {
  const spec = orderThenPastrySpec();
  // A missing-carried-input orchestration fault (s2 requires orderId that s1's inspect won't yield).
  const badSpec = orderThenPastrySpec({
    steps: [
      { stepId: 's1', seq: 1, provider: CAFE, intent: 'lookup', allowedTools: ['lookup_drink'], publishes: [{ key: 'orderId', fromField: 'orderId' }] },
      { stepId: 's2', seq: 2, provider: BAKERY, intent: 'add_pastry', allowedTools: ['add_pastry'], requiredInputs: [{ argKey: 'orderId', fromKey: 'orderId' }], commitRequired: true },
    ],
  });
  const good = await runMultiProviderTrajectoryOnReference(providers, spec, carryingConsumer());
  const badAdapter = makeScriptedTrajectoryAdapter({
    id: 'scripted',
    steps: (input) => (input.history?.length ?? 0) === 0
      ? { type: 'tool_call', toolName: 'lookup_drink', arguments: { query: 'latte' } }
      : { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId: 'INVENTED', pastry: 'croissant' } },
  });
  const bad = await runMultiProviderTrajectoryOnReference(providers, badSpec, badAdapter);

  const report = assembleMultiProviderTrajectoryReport({
    runtimeId: REFERENCE_RUNTIME_ID,
    browserVersion: null,
    generatedAt: '2026-08-10T00:00:00.000Z',
    cases: [
      { caseId: 'good', spec, observation: good },
      { caseId: 'bad', spec: badSpec, observation: bad },
    ],
  });

  assert.equal(report.reportVersion, TRAJECTORY_REPORT_VERSION);
  // Provider grade stays PASS across both — the orchestration fault never touches the provider.
  assert.equal(report.summary.provider, 'PASS');
  assert.equal(report.summary.byLayer['trajectory_orchestration'], 'FAIL');
  // The good trajectory records the carried value's lineage (which provider/tool produced it).
  const goodT = report.trajectories.find((t) => t.caseId === 'good');
  assert.ok(goodT);
  assert.equal(goodT.terminalAttained, true);
  const carried = goodT.carried.find((c) => c.key === 'orderId');
  assert.equal(carried?.producedBy.providerId, 'cafe');
  // Two distinct providers are recorded on the trajectory.
  assert.deepEqual(goodT.providers.map((p) => p.id).sort(), ['bakery', 'cafe']);
});
