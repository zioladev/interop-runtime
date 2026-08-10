# @zioladev/interop-runtime

**Measure where a multi-step, multi-provider WebMCP agent journey actually broke.**

`@zioladev/interop-runtime` runs one **frozen trajectory** — an ordered `inspect → decide → commit`
journey that crosses independent WebMCP providers — through independent **model consumers**
(Claude, GPT, Gemini) and attributes any failure to the **layer that caused it**: the model's
decision, the orchestration around it, the provider, or the runtime. It carries **lineage-bearing
state** from one provider's step into the next, judges completion by a **frozen terminal
predicate**, and compares models without treating a different-but-valid route as a failure.

Where [`@zioladev/provider-conformance`](https://www.npmjs.com/package/@zioladev/provider-conformance)
(Phase II) measures a **single decision** against one provider, this package (Phase III) measures a
**trajectory** across many — and asks the interoperability question:

> Given the same frozen multi-provider trajectory and starting state, do Claude, GPT, and Gemini
> each reach the same allowable terminal state, and where do they diverge?

## The invariants that make it honest

- **The trajectory sits *above* the steps, never in place of them.** Every step keeps its own
  per-decision attribution; the trajectory layer adds ordering, state-propagation, and terminal
  judgment on top.
- **A consumer/orchestration failure is never a provider failure.** The provider grade is computed
  only from provider-owned layers. Sequencing faults land on `trajectory_orchestration`; a model's
  clean decline of a required commit lands on the model — never on the provider.
- **Model memory is never authoritative trajectory state.** Carried state is built from *observed
  execution evidence*; a step's binding is a *claim*, verified against it, never trusted.
- **Completing the loop is not completing the trajectory.** Terminal state comes from the frozen
  predicate — did the required commits actually occur? — not from "all planned steps ran."
- **Different path is not failure.** Two models taking different valid routes to the same allowable
  terminal state, with state preserved and invariants satisfied, both conform.

## What it produces

A versioned, machine-readable trajectory report (`provider-conformance-report/2`) plus a cross-model
artifact:

```
Trajectory: cafe → bakery

anthropic-claude   Path: cafe/commit:place_order -> bakery/commit:add_pastry   Terminal: attained   Conformant: PASS
openai-gpt         Path: cafe/inspect:lookup -> cafe/commit -> bakery/commit    Terminal: attained   Conformant: PASS
google-gemini      Path: cafe/commit -> bakery/(deferred)                       Terminal: not attained  Conformant: FAIL   Attribution: model_tool_selection

Provider: PASS
Cross-model: path difference: yes · terminal difference: yes · conformance difference: yes
```

## Quickstart

```ts
import {
  runCrossModelTrajectory, compareCrossModelTrajectory, renderCrossModelArtifact,
  makeScriptedTrajectoryAdapter,
} from '@zioladev/interop-runtime';

const results = await runCrossModelTrajectory(providers, frozenSpec, [claude, gpt, gemini]);
const comparison = compareCrossModelTrajectory(frozenSpec.trajectoryId, results);
console.log(renderCrossModelArtifact(results, comparison));
```

The reference lane is deterministic (in-process `ReferenceRuntime`). The **live** cross-model
acceptance runs the real APIs entirely from the cloud — see `.github/workflows/crossmodel-live.yml`
and `scripts/crossmodel-live.ts`.

## Independence & provenance

This package takes **no dependency** on `@zioladev/provider-conformance`. It re-authors the small,
stable single-decision primitives it needs (attribution engine, execution bridge, reference
runtime, model adapters, core types) so both packages remain independently functional. The
duplicated pieces are tracked in [`DUPLICATION-LEDGER.md`](./DUPLICATION-LEDGER.md); a shared-layer
review is deferred until after Phase III live validation, rather than minting a common package
before the interfaces have survived real runs.

## Scripts

```
npm run typecheck   # tsc --noEmit
npm test            # node --experimental-strip-types --test  (Node >= 22.6)
npm run build       # emit dist/ (ESM + .d.ts)
```

## License

Apache-2.0. Clean-room — imports nothing from any proprietary source; a test asserts it. See
[`NOTICE`](./NOTICE).
