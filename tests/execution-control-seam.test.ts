// Phase V 5B — the optional execution-control seam in interop-runtime. The headline: in `required`
// mode, a `block` means the provider call count is ZERO. Plus the full matrix, and the three
// mechanical separations: model decision / provider conformance / trajectory qualification each ≠
// execution permission.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runMultiProviderTrajectoryOnReference,
  evaluateMultiProviderTrajectory,
  makeScriptedTrajectoryAdapter,
  type ProviderUnderTest,
  type ExecutionControlDisposition,
  type ExecutionControlConfig,
  type MultiProviderTrajectorySpec,
  type ConsumerDecision,
} from '../src/index.ts';

const CAFE = { id: 'cafe', origin: 'cafe.example', toolEndpoint: 'https://cafe.example/order' };

interface Counters { read: number; order: number }
function cafeProvider(c: Counters): Record<string, ProviderUnderTest> {
  return {
    cafe: {
      name: 'cafe',
      tools: [
        { def: { name: 'read_menu', description: 'read', effect: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
          handler: () => { c.read++; return { executed: true, data: { menu: ['latte'] } }; } },
        { def: { name: 'order_latte', description: 'order', effect: 'state-changing', inputSchema: { type: 'object', properties: { size: { type: 'string' } }, required: [], additionalProperties: true } },
          handler: () => { c.order++; return { executed: true, confirmationId: 'CAFE-1', data: { orderId: 'CAFE-1' } }; } },
      ],
    },
  };
}

const commitSpec: MultiProviderTrajectorySpec = {
  trajectoryId: 'ec/commit', text: 'order a latte', providers: [CAFE],
  steps: [{ stepId: 's1', seq: 1, provider: CAFE, intent: 'order_latte', allowedTools: ['read_menu', 'order_latte'], commitRequired: true, requiredForTerminal: true }],
};
const readSpec: MultiProviderTrajectorySpec = {
  trajectoryId: 'ec/read', text: 'read the menu', providers: [CAFE],
  steps: [{ stepId: 's1', seq: 1, provider: CAFE, intent: 'read_menu', allowedTools: ['read_menu'], requiredForTerminal: true }],
};

const orderAdapter = () => makeScriptedTrajectoryAdapter({ id: 'orders', modelId: 'orders/x', steps: [{ type: 'tool_call', toolName: 'order_latte', arguments: { size: 'M' } }] });
const readAdapter = () => makeScriptedTrajectoryAdapter({ id: 'reads', modelId: 'reads/x', steps: [{ type: 'tool_call', toolName: 'read_menu', arguments: {} }] });

// A spy authority: counts evaluate() calls; returns a fixed disposition, or throws.
function spy(disposition: ExecutionControlDisposition, opts: { throw?: boolean } = {}) {
  return { calls: 0, async evaluate() { this.calls++; if (opts.throw) throw new Error('authority error'); return disposition; } };
}

async function runCommit(config: ExecutionControlConfig, c: Counters) {
  const obs = await runMultiProviderTrajectoryOnReference(cafeProvider(c), commitSpec, orderAdapter(), { executionControl: config });
  return { obs, derived: evaluateMultiProviderTrajectory(obs, commitSpec), rec: obs.records[0]! };
}

// ── The matrix ─────────────────────────────────────────────────────────────────────────────────────
test('required + allow → evaluator once, provider once, executed', async () => {
  const c: Counters = { read: 0, order: 0 }; const ev = spy('allow');
  const { derived, rec } = await runCommit({ mode: 'required', provider: ev }, c);
  assert.equal(ev.calls, 1);
  assert.equal(c.order, 1, 'provider called exactly once under allow');
  assert.equal(rec.steps.executionControl?.disposition, 'allow');
  assert.equal(rec.steps.executionControl?.providerReached, true);
  assert.equal(rec.executed, true);
  assert.equal(derived.terminalAttained, true);
  assert.equal(derived.providerGrade, 'PASS');
});

test('HEADLINE — required + block → evaluator once, provider call count = ZERO', async () => {
  const c: Counters = { read: 0, order: 0 }; const ev = spy('block');
  const { derived, rec } = await runCommit({ mode: 'required', provider: ev }, c);
  assert.equal(ev.calls, 1);
  assert.equal(c.order, 0, 'the provider was NEVER called');
  assert.equal(rec.steps.executionControl?.disposition, 'block');
  assert.equal(rec.steps.executionControl?.stopped, true);
  assert.equal(rec.steps.executionControl?.providerReached, false);
  assert.equal(rec.executed, false);
  assert.equal(rec.derived.outcome, 'stopped_by_execution_control');
  // A block is NOT a provider failure — the provider was never called (D3-style separation).
  assert.equal(rec.derived.providerNonconformance, false);
  assert.equal(derived.providerGrade, 'PASS', 'blocking is not a provider FAIL');
  // Control outcome is observably DISTINCT from the provider ExecutionResult (there is none).
  assert.equal(rec.steps.evidence.executionResult, undefined);
  // The objective was not attained — but that is the terminal semantics' call, not a control fault.
  assert.equal(derived.terminalAttained, false);
});

test('required + indeterminate → evaluator once, provider zero', async () => {
  const c: Counters = { read: 0, order: 0 }; const ev = spy('indeterminate');
  const { rec } = await runCommit({ mode: 'required', provider: ev }, c);
  assert.equal(ev.calls, 1);
  assert.equal(c.order, 0, 'indeterminate is never permission');
  assert.equal(rec.steps.executionControl?.disposition, 'indeterminate');
  assert.equal(rec.steps.executionControl?.stopped, true);
});

test('required + evaluator throws → provider zero, recorded unavailable (still fail closed)', async () => {
  const c: Counters = { read: 0, order: 0 }; const ev = spy('allow', { throw: true });
  const { rec } = await runCommit({ mode: 'required', provider: ev }, c);
  assert.equal(ev.calls, 1);
  assert.equal(c.order, 0);
  assert.equal(rec.steps.executionControl?.unavailable, true);
  assert.equal(rec.steps.executionControl?.disposition, undefined, 'a throw yields no disposition');
  assert.equal(rec.steps.executionControl?.stopped, true);
});

test('required + missing authority → provider zero (evaluate never called)', async () => {
  const c: Counters = { read: 0, order: 0 };
  const { rec } = await runCommit({ mode: 'required' }, c); // no provider
  assert.equal(c.order, 0);
  assert.equal(rec.steps.executionControl?.evaluated, false);
  assert.equal(rec.steps.executionControl?.unavailable, true);
  assert.equal(rec.steps.executionControl?.stopped, true);
});

test('off + state-changing → evaluate zero, provider executes (existing Phase III semantics)', async () => {
  const c: Counters = { read: 0, order: 0 }; const ev = spy('block'); // even a would-be blocker is never consulted
  const { derived, rec } = await runCommit({ mode: 'off', provider: ev }, c);
  assert.equal(ev.calls, 0, 'off mode makes no evaluation');
  assert.equal(c.order, 1);
  assert.equal(rec.steps.executionControl, undefined, 'off mode records no control claim');
  assert.equal(derived.terminalAttained, true);
});

test('required + read → evaluate zero, read executes normally (reads bypass the seam)', async () => {
  const c: Counters = { read: 0, order: 0 }; const ev = spy('block');
  const obs = await runMultiProviderTrajectoryOnReference(cafeProvider(c), readSpec, readAdapter(), { executionControl: { mode: 'required', provider: ev } });
  assert.equal(ev.calls, 0, 'non-state-changing tools bypass execution control');
  assert.equal(c.read, 1, 'the read executed');
  assert.equal(obs.records[0]!.steps.executionControl, undefined);
});

// ── The three separations: nothing but an `allow` grants execution permission ───────────────────────
test('model DECISION ≠ permission — the model selected+argued the tool; block still stops it', async () => {
  // The scripted adapter emphatically decides the state-changing tool (the model's "go ahead").
  const c: Counters = { read: 0, order: 0 }; const ev = spy('block');
  const { rec } = await runCommit({ mode: 'required', provider: ev }, c);
  assert.equal(rec.decision.type, 'tool_call', 'the model did decide to call the tool');
  assert.equal(ev.calls, 1, 'the authority is still consulted regardless of the model decision');
  assert.equal(c.order, 0, 'the model wanting it does not grant permission');
});

test('provider CONFORMANCE ≠ permission — a conformant provider is still gated', async () => {
  // cafeProvider returns a fully conformant ExecutionResult (executed + confirmationId). It does not
  // matter: under block the provider is never reached, so its conformance never grants an allow.
  const c: Counters = { read: 0, order: 0 }; const ev = spy('block');
  const { rec } = await runCommit({ mode: 'required', provider: ev }, c);
  assert.equal(ev.calls, 1);
  assert.equal(c.order, 0, 'a would-be conformant provider is never called');
  assert.equal(rec.steps.evidence.executionResult, undefined);
});

test('trajectory QUALIFICATION ≠ permission — a clean prior step does not grant the commit', async () => {
  // A two-step trajectory: a clean READ (would qualify a read leg) then a state-changing COMMIT. The
  // earlier clean step grants nothing — the commit is still gated, and blocked.
  const spec: MultiProviderTrajectorySpec = {
    trajectoryId: 'ec/read-then-commit', text: 'read then order', providers: [CAFE],
    steps: [
      { stepId: 's1', seq: 1, provider: CAFE, intent: 'read_menu', allowedTools: ['read_menu'], requiredForTerminal: true },
      { stepId: 's2', seq: 2, provider: CAFE, intent: 'order_latte', allowedTools: ['order_latte'], dependsOn: ['s1'], commitRequired: true, requiredForTerminal: true },
    ],
  };
  const adapter = makeScriptedTrajectoryAdapter({ id: 'rt', modelId: 'rt/x', steps: [
    { type: 'tool_call', toolName: 'read_menu', arguments: {} } as ConsumerDecision,
    { type: 'tool_call', toolName: 'order_latte', arguments: { size: 'M' } } as ConsumerDecision,
  ] });
  const c: Counters = { read: 0, order: 0 }; const ev = spy('block');
  const obs = await runMultiProviderTrajectoryOnReference(cafeProvider(c), spec, adapter, { executionControl: { mode: 'required', provider: ev } });
  assert.equal(c.read, 1, 'the read leg ran (a clean prior step)');
  assert.equal(ev.calls, 1, 'the authority is consulted only for the state-changing leg');
  assert.equal(c.order, 0, 'a clean prior step does not grant the commit');
  assert.equal(obs.records[0]!.steps.executionControl, undefined, 'the read leg bypassed the seam');
  assert.equal(obs.records[1]!.steps.executionControl?.stopped, true, 'the commit leg was stopped');
});
