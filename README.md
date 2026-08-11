# @zioladev/interop-runtime

**Run stateful objectives across independent WebMCP providers.**

`@zioladev/interop-runtime` is a model-agnostic runtime for executing **ordered, multi-step
trajectories** across independent provider surfaces. It carries authoritative outputs from one step
into subsequent steps **with provenance**, resolves provider transitions through a
runtime-independent **host boundary**, and determines completion from **explicit terminal
requirements** — not from model narration or from "the loop finished."

The runtime separates **planning from execution**: model adapters *decide*, a common execution
bridge *acts*, and observed runtime evidence — never model memory — becomes the authoritative
trajectory state. No provider-specific orchestration is required. The **same** trajectory engine runs
against a deterministic in-process reference runtime or a browser host implementing **native
`document.modelContext`** (WebMCP), byte-identical spec on both.

## Quickstart

```ts
import {
  runMultiProviderTrajectory,
  evaluateMultiProviderTrajectory,
  makeReferenceSurfaceResolver,
  makeScriptedTrajectoryAdapter,
} from '@zioladev/interop-runtime';

// 1. A trajectory: an ordered objective across independent providers, with the terminal
//    requirements that define "done" — state-changing commits and/or required non-mutating work.
const spec = {
  trajectoryId: 'cafe-then-gallery',
  text: 'Order a latte at the cafe, then check a color against the gallery palette.',
  providers: [cafe, gallery],            // ProviderRef[] — id + independent origin
  steps: [
    { stepId: 's1', seq: 1, provider: cafe,    intent: 'order_latte',
      allowedTools: ['read_menu', 'order_latte'], commitRequired: true,  requiredForTerminal: true },
    { stepId: 's2', seq: 2, provider: gallery, intent: 'check_design_drift',
      allowedTools: ['check_design_drift'], dependsOn: ['s1'], requiredForTerminal: true },
  ],
};

// 2. A surface resolver: HOW the runtime reaches each provider. Deterministic in-process here; swap
//    makeBrowserSurfaceResolver(host, defs) to run the SAME spec against native WebMCP in a browser.
const resolver = makeReferenceSurfaceResolver(providerImpls);

// 3. Run it: resolve provider → prepare surface → discover tools → decide (adapter) → execute →
//    carry resulting state with provenance → transition provider → continue → judge terminal.
const observation = await runMultiProviderTrajectory(resolver, spec, adapter);
const result = evaluateMultiProviderTrajectory(observation, spec);

result.terminalAttained;        // was the required world-state actually reached?
result.trajectoryConformance;   // PASS / FAIL
result.routeKey;                // the executed route across providers
observation.carried;            // lineage-bearing carried state (built from evidence, not memory)
observation.records;            // per-step execution evidence
```

`adapter` is any `ModelConsumerAdapter` — a deterministic `makeScriptedTrajectoryAdapter(...)` for
reproducible runs, or a live model adapter (`makeClaudeAdapter`/`makeGptAdapter`/`makeGeminiAdapter`).
The engine owns sequencing, state, and terminal judgment regardless of which one decides.

## Runtime primitives

These are the things the runtime *is*, not tests of it:

- **Ordering.** The trajectory owns sequencing *above* individual execution steps. A step may declare
  `dependsOn` predecessors; the engine runs the objective, not a flat list of calls.
- **Portable, authoritative state.** A step `publishes` outputs into carried state, lifted from its
  **execution evidence**; a later step's `requiredInputs` bind to that lineage. The model's claim
  about what it carried is only a claim — the runtime verifies it against observed evidence (D36).
- **Terminal semantics.** Completing the loop is not completing the objective. Terminal state is a
  frozen predicate: every `commitRequired` leg must have committed **and** every `requiredForTerminal`
  leg must have been attained — including **required non-mutating work** (D43), so a mandatory final
  read/verification counts toward "done" without being mislabeled a commit.
- **Runtime-independent host boundary.** Providers are reached through a `SurfaceResolver` /
  `BrowserHost` port the runtime *defines* and a host *implements* — navigate, discover, execute one
  call. The engine imports nothing from the host, so it stays authoritative for sequencing, state,
  and terminal judgment while the arms and legs change (in-process reference ⇄ native WebMCP browser).

## Runtime invariants

Architectural guarantees the runtime holds, by construction:

- **The trajectory sits *above* the steps, never in place of them.** Every step keeps its own
  per-decision attribution; the trajectory layer only adds ordering, state-propagation, and terminal
  judgment on top.
- **Model memory is never authoritative trajectory state.** Carried state is built from observed
  execution evidence; a binding is a claim, verified against it, never trusted.
- **Completing the loop is not completing the trajectory.** Terminal state comes from the frozen
  predicate — did the required commits and required steps actually attain? — not from "all steps ran."
- **A consumer/orchestration failure is never a provider failure.** The provider grade is computed
  only from provider-owned layers; sequencing faults land on `trajectory_orchestration`, a model's
  clean decline of a required commit lands on the model — never on the provider.
- **A different valid path is not a failure.** Two adapters taking different valid routes to the same
  allowable terminal state, with state preserved and invariants satisfied, both conform.

## Evidence & interoperability analysis

Every run produces a versioned, machine-readable trajectory report (`provider-conformance-report/2`)
plus structured evidence you can use to identify **step failures, orchestration faults, provider
faults, path differences, and cross-model divergence** — each failure attributed to the layer that
caused it (the model's decision, the orchestration, the provider, or the runtime).

### Testing interoperability across model consumers

Because the runtime is model-agnostic, running the *same* frozen trajectory through several adapters
turns cross-model evaluation into a capability of the runtime — do Claude, GPT, and Gemini each reach
the same allowable terminal state, and where do they diverge?

```ts
import {
  runCrossModelTrajectory, compareCrossModelTrajectory, renderCrossModelArtifact,
} from '@zioladev/interop-runtime';

const results = await runCrossModelTrajectory(providers, frozenSpec, [claude, gpt, gemini]);
const comparison = compareCrossModelTrajectory(frozenSpec.trajectoryId, results);
console.log(renderCrossModelArtifact(results, comparison));
```

```
Trajectory: cafe → bakery

anthropic-claude   Path: cafe/commit:place_order -> bakery/commit:add_pastry   Terminal: attained   Conformant: PASS
openai-gpt         Path: cafe/inspect:lookup -> cafe/commit -> bakery/commit    Terminal: attained   Conformant: PASS
google-gemini      Path: cafe/commit -> bakery/(deferred)                       Terminal: not attained  Conformant: FAIL   Attribution: model_tool_selection

Provider: PASS
Cross-model: path difference: yes · terminal difference: yes · conformance difference: yes
```

The reference lane is deterministic (in-process `ReferenceRuntime`). The **live** cross-model
acceptance runs the real model APIs from the cloud — see `.github/workflows/crossmodel-live.yml` and
`scripts/crossmodel-live.ts`. A `makeBrowserSurfaceResolver` lane drives the identical spec on native
WebMCP through a privileged browser host (the runtime is the brain; the host is the arms and legs).

## Relationship to `@zioladev/provider-conformance`

Where [`@zioladev/provider-conformance`](https://www.npmjs.com/package/@zioladev/provider-conformance)
(Phase II) measures a **single decision** against one provider, this package (Phase III) executes a
**trajectory** across many and emits evidence about it.

It takes **no dependency** on that package: the small, stable single-decision primitives it needs
(attribution engine, execution bridge, reference runtime, model adapters, core types) are re-authored
here so both packages remain independently functional. The duplicated pieces are tracked in
[`DUPLICATION-LEDGER.md`](./DUPLICATION-LEDGER.md); a shared-layer extraction is deferred until the
interfaces have survived real runs, rather than minting a common package prematurely.

## Scripts

```
npm run typecheck   # tsc --noEmit
npm test            # node --experimental-strip-types --test  (Node >= 22.6)
npm run build       # emit dist/ (ESM + .d.ts)
```

## License

Apache-2.0. Clean-room — imports nothing from any proprietary source; a test asserts it. See
[`NOTICE`](./NOTICE).
