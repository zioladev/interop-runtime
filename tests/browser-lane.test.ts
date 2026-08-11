// The Chrome/WebMCP acceptance lane, proven deterministically. A FAKE BrowserHost stands in for
// the privileged host (the Refraktor extension): it "navigates" between two in-memory provider
// surfaces and executes one call at a time. The trajectory engine — the brain — drives the whole
// journey through the host port; the host never sequences, carries state, or judges terminal state.
// This proves interop-runtime can drive a browser journey with an external host as arms and legs,
// and that a browser-side fault isolates to `browser_runtime` with the provider PASS.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBrowserSurfaceResolver,
  CHROME_WEBMCP_RUNTIME_ID,
  runMultiProviderTrajectory,
  evaluateMultiProviderTrajectory,
  evaluateMultiProviderTrajectoryCase,
  assembleMultiProviderTrajectoryReport,
  makeScriptedTrajectoryAdapter,
  ReferenceRuntime,
} from '../src/index.ts';
import type { BrowserHost, MultiProviderTrajectorySpec, ProviderRef, ProviderUnderTest, RuntimeTool, PlanInput, ConsumerDecision } from '../src/index.ts';
import { cafeProvider, bakeryProvider } from './sample-provider.ts';

const CAFE: ProviderRef = { id: 'cafe', origin: 'cafe.example', toolEndpoint: 'https://cafe.example/order' };
const BAKERY: ProviderRef = { id: 'bakery', origin: 'bakery.example', toolEndpoint: 'https://bakery.example/counter' };

const spec: MultiProviderTrajectorySpec = {
  trajectoryId: 'order-then-pastry/chrome',
  text: 'Order a latte at the cafe, then add a croissant to that order at the bakery.',
  providers: [CAFE, BAKERY],
  steps: [
    { stepId: 's1', seq: 1, provider: CAFE, intent: 'place_order', allowedTools: ['lookup_drink', 'place_order'], publishes: [{ key: 'orderId', fromField: 'orderId' }], commitRequired: true },
    { stepId: 's2', seq: 2, provider: BAKERY, intent: 'add_pastry', allowedTools: ['list_pastries', 'add_pastry'], requiredInputs: [{ argKey: 'orderId', fromKey: 'orderId' }], dependsOn: ['s1'], commitRequired: true },
  ],
};

// A fake privileged host: one in-process ReferenceRuntime per provider, an "active" surface set by
// navigation, and a set of origins it cannot reach (to exercise browser-fault isolation). It ONLY
// navigates / lists / executes — it holds no trajectory state.
class FakeBrowserHost implements BrowserHost {
  #runtimes = new Map<string, ReferenceRuntime>();
  #active?: ReferenceRuntime;
  #unreachable: Set<string>;
  navigations: string[] = [];

  constructor(providers: Record<string, ProviderUnderTest>, unreachable: string[] = []) {
    for (const [id, p] of Object.entries(providers)) {
      const rt = new ReferenceRuntime();
      for (const t of p.tools) rt.registerTool(t.def, t.handler);
      this.#runtimes.set(id, rt);
    }
    this.#unreachable = new Set(unreachable);
  }
  async prepareSurface(provider: ProviderRef): Promise<{ ready: boolean; detail?: string }> {
    this.navigations.push(provider.id);
    if (this.#unreachable.has(provider.id)) return { ready: false, detail: `no WebMCP surface on ${provider.origin}` };
    const rt = this.#runtimes.get(provider.id);
    if (!rt) return { ready: false, detail: `unknown provider ${provider.id}` };
    this.#active = rt;
    return { ready: true };
  }
  async listTools(): Promise<RuntimeTool[]> {
    return this.#active ? this.#active.getTools() : [];
  }
  async callTool(toolName: string, argsString: string): Promise<string> {
    if (!this.#active) throw new Error('no active surface');
    const handle = this.#active.getTools().find((t) => t.name === toolName);
    if (!handle) throw new Error(`no handle for ${toolName}`);
    return this.#active.executeTool(handle, argsString);
  }
  browserVersion(): string { return 'FakeChrome/152'; }
}

const providers = { cafe: cafeProvider, bakery: bakeryProvider };
const defsByProvider = {
  cafe: cafeProvider.tools.map((t) => t.def),
  bakery: bakeryProvider.tools.map((t) => t.def),
};

function carryingConsumer() {
  return makeScriptedTrajectoryAdapter({
    id: 'scripted', modelId: 'scripted/chrome',
    steps: (input: PlanInput): ConsumerDecision => {
      const i = input.history?.length ?? 0;
      if (i === 0) return { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } };
      const orderId = input.carried?.find((c) => c.key === 'orderId')?.value;
      return { type: 'tool_call', toolName: 'add_pastry', arguments: { orderId, pastry: 'croissant' } };
    },
  });
}

// The happy Chrome-lane journey: the brain drives navigation + execution through the host.
test('chrome lane: interop-runtime drives a cross-origin journey through the host (brain vs arms/legs)', async () => {
  const host = new FakeBrowserHost(providers);
  const resolver = makeBrowserSurfaceResolver(host, defsByProvider);
  const obs = await runMultiProviderTrajectory(resolver, spec, carryingConsumer());
  const d = evaluateMultiProviderTrajectory(obs, spec);

  assert.equal(d.trajectoryConformance, 'PASS');
  assert.equal(d.providerGrade, 'PASS');
  assert.equal(d.terminalAttained, true);
  assert.equal(d.routeKey, 'cafe/commit:place_order -> bakery/commit:add_pastry');
  // The host navigated to each origin in order — the ENGINE decided the sequence, the host obeyed.
  assert.deepEqual(host.navigations, ['cafe', 'bakery']);
  // Carried state crossed the origin boundary, with provenance from the cafe's execution.
  const cv = obs.carried.find((c) => c.key === 'orderId');
  assert.equal(cv?.value, 'CAFE-ORDER');
  assert.deepEqual(cv?.producedBy, { stepId: 's1', providerId: 'cafe', toolName: 'place_order' });

  // The /2 report is stamped with the chrome-webmcp lane + browser version.
  const report = assembleMultiProviderTrajectoryReport({
    cases: [{ caseId: 'chrome', spec, observation: obs }],
    runtimeId: CHROME_WEBMCP_RUNTIME_ID,
    browserVersion: host.browserVersion(),
    generatedAt: '2026-08-11T00:00:00.000Z',
  });
  assert.equal(report.lane.runtimeId, 'chrome-webmcp');
  assert.equal(report.lane.browserVersion, 'FakeChrome/152');
  assert.equal(report.summary.provider, 'PASS');
});

// Browser-fault isolation: a surface that never becomes discoverable is a browser_runtime fault,
// and the PROVIDER stays PASS — the same fault isolation the Phase II Chrome lane proved.
test('chrome lane: an unreachable surface -> browser_runtime FAIL / provider PASS', async () => {
  const host = new FakeBrowserHost(providers, ['bakery']); // bakery origin never exposes WebMCP
  const resolver = makeBrowserSurfaceResolver(host, defsByProvider);
  const c = { caseId: 'chrome-fault', spec, observation: await runMultiProviderTrajectory(resolver, spec, carryingConsumer()) };
  const { derived, provider } = evaluateMultiProviderTrajectoryCase(c);

  assert.equal(provider, 'PASS', 'a browser-side failure is never provider nonconformance');
  assert.equal(derived.providerNonconformance, false);
  assert.equal(derived.terminalAttained, false, 'the bakery commit never happened');
  assert.ok(derived.attribution.some((a) => a.category === 'browser_runtime'), 'the fault is owned by the browser runtime');
  // The cafe leg still succeeded before the browser fault on the bakery leg.
  assert.equal(derived.stepDeriveds[0]?.outcome, 'executed');
});
