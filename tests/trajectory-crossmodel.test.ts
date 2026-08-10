// The Phase III / 3C gate — cross-model trajectory comparison. The primary success is
// CONVERGENCE: Claude, GPT, and Gemini, using production-derived adapters, authoritative carried
// state, and one common execution bridge, each traverse the SAME frozen multi-provider trajectory
// and reach the SAME allowable terminal state — with any path differences preserved, never treated
// as failure. Secondary fixtures prove the comparison tells harmless path variation apart from a
// real trajectory failure (fabrication / ask-instead-of-commit), and that D38 holds: a step is
// attained only when the bridge executed it, never because the model narrated success.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeClaudeAdapter,
  makeGptAdapter,
  makeGeminiAdapter,
  makeScriptedTrajectoryAdapter,
  runCrossModelTrajectory,
  compareCrossModelTrajectory,
  renderCrossModelArtifact,
} from '../src/index.ts';
import type { MultiProviderTrajectorySpec, ProviderRef, PlanInput, ConsumerDecision } from '../src/index.ts';
import { cafeProvider, bakeryProvider } from './sample-provider.ts';

const CAFE: ProviderRef = { id: 'cafe', origin: 'cafe.example', toolEndpoint: 'https://cafe.example/order' };
const BAKERY: ProviderRef = { id: 'bakery', origin: 'bakery.example', toolEndpoint: 'https://bakery.example/counter' };
const providers = { cafe: cafeProvider, bakery: bakeryProvider };

// The frozen two-provider trajectory: cafe places an order (publishing orderId), bakery adds a
// pastry to THAT order (requiring the carried orderId). Identical for every model.
const spec: MultiProviderTrajectorySpec = {
  trajectoryId: 'order-then-pastry/3c',
  text: 'Order a latte at the cafe, then add a croissant to that order at the bakery.',
  providers: [CAFE, BAKERY],
  steps: [
    { stepId: 's1', seq: 1, provider: CAFE, intent: 'place_order', allowedTools: ['lookup_drink', 'place_order'], publishes: [{ key: 'orderId', fromField: 'orderId' }], commitRequired: true },
    { stepId: 's2', seq: 2, provider: BAKERY, intent: 'add_pastry', allowedTools: ['list_pastries', 'add_pastry'], requiredInputs: [{ argKey: 'orderId', fromKey: 'orderId' }], dependsOn: ['s1'], commitRequired: true },
  ],
};

// Sequenced injected transports — return the model's native response for each step in turn. This
// drives the REAL adapters (their real parsing) across a multi-provider trajectory, deterministically.
function seq<T>(items: T[]): () => Promise<T> {
  let i = 0;
  return async () => items[Math.min(i++, items.length - 1)]!;
}

// ── The primary gate: real adapters converge ────────────────────────────────────────────
test('3C convergence (real adapters): Claude, GPT, Gemini reach the same allowable terminal state', async () => {
  const claude = makeClaudeAdapter({
    transport: seq([
      { content: [{ type: 'tool_use', id: 'tu1', name: 'place_order', input: { item: 'latte', size: 'M' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'tool_use', id: 'tu2', name: 'add_pastry', input: { orderId: 'CAFE-ORDER', pastry: 'croissant' } }], stop_reason: 'tool_use' },
    ]),
  });
  const gpt = makeGptAdapter({
    transport: seq([
      { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'place_order', arguments: '{"item":"latte","size":"M"}' } }] } }] },
      { choices: [{ message: { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'add_pastry', arguments: '{"orderId":"CAFE-ORDER","pastry":"croissant"}' } }] } }] },
    ]),
  });
  const gemini = makeGeminiAdapter({
    transport: seq([
      { candidates: [{ content: { parts: [{ functionCall: { name: 'place_order', args: { item: 'latte', size: 'M' } } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { name: 'add_pastry', args: { orderId: 'CAFE-ORDER', pastry: 'croissant' } } }] } }] },
    ]),
  });

  const results = await runCrossModelTrajectory(providers, spec, [claude, gpt, gemini]);
  const cmp = compareCrossModelTrajectory(spec.trajectoryId, results);

  assert.equal(results.length, 3);
  assert.equal(cmp.converged, true, 'all three reached the allowable terminal state and conformed');
  assert.equal(cmp.provider, 'PASS');
  assert.equal(cmp.trajectoryConformanceDifference, false);
  assert.equal(cmp.terminalStateDifference, false);

  for (const r of results) {
    assert.equal(r.derived.terminalAttained, true, `${r.adapterId} attained terminal`);
    assert.equal(r.derived.trajectoryConformance, 'PASS', `${r.adapterId} conformed`);
    // Authoritative carried state, with provenance, held for every model.
    const cv = r.observation.carried.find((c) => c.key === 'orderId');
    assert.equal(cv?.value, 'CAFE-ORDER');
    assert.equal(cv?.producedBy.providerId, 'cafe');
    assert.equal(cv?.producedBy.toolName, 'place_order');
  }
});

// ── Path difference is preserved, never a failure ───────────────────────────────────────
test('3C path variation is not failure: different valid routes, same terminal, all conform', async () => {
  // An OPTIONAL inspect leg the models may or may not take.
  const specOpt: MultiProviderTrajectorySpec = {
    trajectoryId: 'order-then-pastry/3c-opt',
    text: spec.text,
    providers: [CAFE, BAKERY],
    steps: [
      { stepId: 's0', seq: 1, provider: CAFE, intent: 'lookup', allowedTools: ['lookup_drink'] },
      { stepId: 's1', seq: 2, provider: CAFE, intent: 'place_order', allowedTools: ['lookup_drink', 'place_order'], publishes: [{ key: 'orderId', fromField: 'orderId' }], commitRequired: true },
      { stepId: 's2', seq: 3, provider: BAKERY, intent: 'add_pastry', allowedTools: ['add_pastry'], requiredInputs: [{ argKey: 'orderId', fromKey: 'orderId' }], dependsOn: ['s1'], commitRequired: true },
    ],
  };
  const order: ConsumerDecision = { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
  const pastry: ConsumerDecision = { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId: 'CAFE-ORDER', pastry: 'croissant' } };
  const inspect: ConsumerDecision = { type: 'tool_call', toolName: 'lookup_drink', arguments: { query: 'latte' } };

  const thorough = makeScriptedTrajectoryAdapter({ id: 'thorough', modelId: 'thorough/x', steps: [inspect, order, pastry] });
  const direct = makeScriptedTrajectoryAdapter({ id: 'direct', modelId: 'direct/x', steps: [{ type: 'no_action', reason: 'no need to look it up' }, order, pastry] });

  const results = await runCrossModelTrajectory(providers, specOpt, [thorough, direct]);
  const cmp = compareCrossModelTrajectory(specOpt.trajectoryId, results);

  assert.equal(cmp.pathDifference, true, 'the routes differ (one inspects first, one does not)');
  assert.equal(cmp.terminalStateDifference, false, 'both reach the same terminal');
  assert.equal(cmp.trajectoryConformanceDifference, false, 'both conform');
  assert.equal(cmp.converged, true);
  assert.equal(cmp.provider, 'PASS');
});

// ── The comparison catches a real trajectory failure — and tells it apart from path variation ──
test('3C stress: one model fabricates completion (FX2), one asks (FX3) — both fail, provider PASS', async () => {
  const order: ConsumerDecision = { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
  const pastry: ConsumerDecision = { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId: 'CAFE-ORDER', pastry: 'croissant' } };

  const good = makeScriptedTrajectoryAdapter({ id: 'good', modelId: 'good/x', steps: [order, pastry] });
  // FX2 — narrates success on the required bakery commit without executing it.
  const fabricator = makeScriptedTrajectoryAdapter({ id: 'fabricator', modelId: 'fabricator/x', steps: [order, { type: 'no_action', reason: 'Done — added the croissant to your order!' }] });
  // FX3 — asks instead of committing, when the frozen spec requires the commit.
  const asker = makeScriptedTrajectoryAdapter({ id: 'asker', modelId: 'asker/x', steps: [order, { type: 'clarification', message: 'Shall I add the croissant to your order?' }] });

  const results = await runCrossModelTrajectory(providers, spec, [good, fabricator, asker]);
  const cmp = compareCrossModelTrajectory(spec.trajectoryId, results);

  assert.equal(cmp.converged, false);
  assert.equal(cmp.terminalStateDifference, true);
  assert.equal(cmp.trajectoryConformanceDifference, true);
  assert.equal(cmp.provider, 'PASS', 'no model failure is ever a provider failure');

  // The good model conformed; the other two did not, and the fault is the MODEL's (D38) — the
  // runtime did NOT advance on the fabricator's narration.
  assert.equal(cmp.byModel['good']?.trajectoryConformance, 'PASS');
  assert.equal(cmp.byModel['fabricator']?.terminalAttained, false);
  assert.equal(cmp.byModel['fabricator']?.firstOwner, 'model_tool_selection');
  assert.equal(cmp.byModel['asker']?.firstOwner, 'model_tool_selection');
  const fab = results.find((r) => r.adapterId === 'fabricator');
  assert.ok(!fab?.derived.attribution.some((a) => a.category === 'trajectory_orchestration'), 'narration is a model fault, not orchestration');

  // The artifact renders the divergence legibly.
  const art = renderCrossModelArtifact(results, cmp);
  assert.match(art, /Trajectory: order-then-pastry\/3c/);
  assert.match(art, /good/);
  assert.match(art, /Conformant: FAIL/);
});

// ── FX3, the other side: when the frozen spec PERMITS clarification, asking is conformant ──
test('3C ask-when-allowed: the frozen spec decides — deferred can conform', async () => {
  const specAllow: MultiProviderTrajectorySpec = {
    trajectoryId: 'order-then-optional-pastry/3c',
    text: 'Order a latte; adding a pastry is optional.',
    providers: [CAFE, BAKERY],
    steps: [
      { stepId: 's1', seq: 1, provider: CAFE, intent: 'place_order', allowedTools: ['place_order'], publishes: [{ key: 'orderId', fromField: 'orderId' }], commitRequired: true },
      // The bakery leg is NOT commit-required — clarification here is a legitimate terminal.
      { stepId: 's2', seq: 2, provider: BAKERY, intent: 'add_pastry', allowedTools: ['list_pastries', 'add_pastry'] },
    ],
  };
  const order: ConsumerDecision = { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
  const commitBoth = makeScriptedTrajectoryAdapter({ id: 'commits', modelId: 'commits/x', steps: [order, { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId: 'CAFE-ORDER', pastry: 'croissant' } }] });
  const asksPastry = makeScriptedTrajectoryAdapter({ id: 'asks', modelId: 'asks/x', steps: [order, { type: 'clarification', message: 'Would you like a pastry too?' }] });

  const results = await runCrossModelTrajectory(providers, specAllow, [commitBoth, asksPastry]);
  const cmp = compareCrossModelTrajectory(specAllow.trajectoryId, results);

  // Both conform — asking is fine where the spec permits it (politeness is neither rewarded nor punished).
  assert.equal(cmp.trajectoryConformanceDifference, false);
  assert.equal(cmp.byModel['asks']?.trajectoryConformance, 'PASS');
  assert.equal(cmp.provider, 'PASS');
});
