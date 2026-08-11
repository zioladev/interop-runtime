// D43 — `requiredForTerminal` is orthogonal to `commitRequired`.
//
// `commitRequired` = this leg must perform a successful STATE-CHANGING execution.
// `requiredForTerminal` = successful ATTAINMENT of this leg is part of the frozen terminal predicate,
//   whether or not it mutates anything. A non-mutating final verification/analysis (a read that must
//   run to complete the errand) is `requiredForTerminal: true, commitRequired: false` — and it must
//   NEVER be reclassified as a commit. "Finishing the commits ≠ finishing the journey."
//
// Surface: cafe `place_order` (state-changing commit) + bakery `list_pastries` (read). This is the
// reference-lane analogue of the native-town gate (Valentin order_latte + Sirocco check_design_drift).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runMultiProviderTrajectoryOnReference,
  evaluateMultiProviderTrajectory,
  makeScriptedTrajectoryAdapter,
} from '../src/index.ts';
import type { MultiProviderTrajectorySpec, ProviderRef, ConsumerDecision, PlanInput } from '../src/index.ts';
import { cafeProvider, bakeryProvider } from './sample-provider.ts';

const CAFE: ProviderRef = { id: 'cafe', origin: 'cafe.example', toolEndpoint: 'https://cafe.example/order' };
const BAKERY: ProviderRef = { id: 'bakery', origin: 'bakery.example', toolEndpoint: 'https://bakery.example/counter' };
const providers = { cafe: cafeProvider, bakery: bakeryProvider };

// s1: cafe place_order — a commit that is also part of the objective (commitRequired + requiredForTerminal).
// s2: bakery list_pastries — a READ; `s2Required` toggles whether it is requiredForTerminal or merely optional.
function spec(s2Required: boolean): MultiProviderTrajectorySpec {
  return {
    trajectoryId: 'order-then-view/rft',
    text: 'Order a latte at the cafe, then view the pastry list at the bakery.',
    providers: [CAFE, BAKERY],
    steps: [
      { stepId: 's1', seq: 1, provider: CAFE, intent: 'order', allowedTools: ['lookup_drink', 'place_order'], commitRequired: true, requiredForTerminal: true },
      { stepId: 's2', seq: 2, provider: BAKERY, intent: 'view', allowedTools: ['list_pastries'], dependsOn: ['s1'], commitRequired: false, requiredForTerminal: s2Required },
    ],
  };
}

const order: ConsumerDecision = { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
const view: ConsumerDecision = { type: 'tool_call', toolName: 'list_pastries', arguments: {} };
const decline: ConsumerDecision = { type: 'no_action', reason: 'narrated done without executing' };

// A scripted consumer: decision by step index (history length: 0 → s1, 1 → s2).
const consumer = (s1: ConsumerDecision, s2: ConsumerDecision) =>
  makeScriptedTrajectoryAdapter({
    id: 'scripted',
    modelId: 'scripted/rft',
    steps: (input: PlanInput): ConsumerDecision => ((input.history?.length ?? 0) === 0 ? s1 : s2),
  });

test('D43: required non-state-changing step attained → terminal PASS (and stays a read)', async () => {
  const s = spec(true);
  const obs = await runMultiProviderTrajectoryOnReference(providers, s, consumer(order, view));
  const d = evaluateMultiProviderTrajectory(obs, s);

  assert.equal(d.terminalAttained, true, 'commit + required read both attained → terminal');
  assert.equal(d.trajectoryConformance, 'PASS');
  assert.equal(d.providerGrade, 'PASS');
  // The required leg fired a READ and was never reclassified as a commit.
  assert.equal(obs.records[1].firedEffect, 'read', 'list_pastries stays non-state-changing');
  assert.ok(d.invariantResults.some((i) => i.kind === 'required_terminal_step' && i.stepId === 's2' && i.held));
});

test('D43: commit succeeds but the required read does not execute → terminal NOT attained', async () => {
  const s = spec(true);
  const obs = await runMultiProviderTrajectoryOnReference(providers, s, consumer(order, decline));
  const d = evaluateMultiProviderTrajectory(obs, s);

  // The commit DID land — finishing the commit is not finishing the journey.
  assert.notEqual(obs.records[0].firedEffect, 'read', 's1 committed');
  assert.equal(d.terminalAttained, false, 'the required non-mutating leg never ran');
  assert.ok(d.invariantResults.some((i) => i.kind === 'terminal_not_attained' && i.stepId === 's2'));
  assert.ok(
    d.attribution.some((a) => a.category === 'model_tool_selection' && a.signal === 'trajectory_requirement_unmet'),
    'the clean decline of a required leg is a MODEL fault, not orchestration',
  );
});

test('D43: optional read absent → terminal unaffected', async () => {
  const s = spec(false); // s2 is neither commitRequired nor requiredForTerminal
  const obs = await runMultiProviderTrajectoryOnReference(providers, s, consumer(order, decline));
  const d = evaluateMultiProviderTrajectory(obs, s);

  assert.equal(d.terminalAttained, true, 'the commit alone attains terminal when s2 is optional');
  assert.equal(d.trajectoryConformance, 'PASS');
  assert.ok(!d.invariantResults.some((i) => i.kind === 'terminal_not_attained'), 'no terminal fault for an optional read');
});
