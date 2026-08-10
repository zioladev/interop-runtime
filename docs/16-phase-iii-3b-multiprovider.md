# 16 — Phase III / 3B: multi-provider trajectories

> 3A proved the trajectory measurement abstraction on **one** provider. 3B generalizes it across
> **providers** — and makes the thing production never truly had a first-class primitive:
> **typed, attributable, lineage-bearing state propagation from one provider's step into the next.**

This milestone was scoped *after* a clean-room extraction inventory against the production
TreeFrog/Refraktor code (the archaeology). That dig is the reason 3B looks the way it does — so it
is worth stating the finding plainly, because it is the extraction story:

> TreeFrog had the **skeleton** — an itinerary object and a declared-vs-actual "verify the journey"
> conformance check. When we generalized it, we found the production consumer **had no true portable
> state propagation between steps**: each surface was executed in isolation, and step N+1 never saw
> step N's output. So we did not merely polish an old implementation — we improved the architecture
> as we generalized it, making **lineage-bearing carried state** a first-class interoperability
> primitive.

3B is **single consumer, multiple providers, reference lane.** Cross-model comparison is 3C; real
multi-origin Chrome is later. Same discipline as always: prove the instrument before adding
dimensionality.

## Provider identity: origin ≠ tool endpoint (D31)

A trajectory step names its provider as `{id, origin, toolEndpoint?}`:

- **`origin`** — the security/identity boundary (the independent origin).
- **`toolEndpoint`** — the exact tool-bearing location, when it differs from the origin root.

They are kept **distinct**, never collapsed into one URL, because production taught us that a
provider's landing page is not its tool-bearing page — targeting the apex breaks discovery.

## Carried state is lineage-bearing (D32) — the centerpiece

```ts
interface CarriedValue {
  key: string;
  value: unknown;
  producedBy: { stepId: string; providerId: string; toolName: string };
  evidenceRef?: string;
}
```

A value produced by one provider's step is carried into a later provider's step **with its
provenance**: which step, which provider, which tool produced it — and a reference to the evidence
it came from. A later step may declare that one of its inputs is sourced from a prior carried value
(`requiredInputs: [{ argKey, fromKey }]`), and the engine verifies the binding against the
authoritative carried state.

This is **not** a flat bag of merged values. Flat state loses lineage, and lineage is exactly what
makes downstream questions answerable: *where did this value originate? which provider produced it?
was it actually observed, or invented later?* Those questions become essential the moment anyone
reasons about transaction assurance — which is why 3B pays the cost of provenance now.

## Two architectural invariants, learned in production, now law

**D36 — Model memory is never authoritative trajectory state.** The model may *receive* carried
state as context and reason over it, but the authoritative carried state is built by the engine from
**observed execution evidence only**. A step's `bindings` are a *claim*; the engine verifies the
claim against authoritative state and never trusts it as truth. (Production once had a model re-emit
a *fabricated* tool-result as if it were real — see the dig. If the model's assertion could define
state, attribution would be forgeable.)

**D37 — Completing the loop is not completing the trajectory.** Terminal state is decided by the
frozen terminal predicate — *did the required commits actually occur?* — never by "all planned steps
were iterated." Production granted "done" when a leg produced only a summary; iterating the plan and
attaining the outcome are different facts, and only the second is completion.

## Lane discipline (D34): the requirement is the contract's; the mechanism is the lane's

A provider transition and surface-readiness are trajectory **requirements** the engine expresses and
records (`provider_transition → surface_ready → discovery_complete`). **How** readiness happens is
owned by the lane's `SurfaceResolver`:

- **reference lane** — resolves each provider's in-process surface instantly and deterministically;
- **Chrome lane** (future) — navigate → bounded readiness poll → optional rediscovery nudge.

No navigation/polling logic lives in the trajectory engine. The contract owns the requirement; the
lane owns the plumbing.

## The Selvage wall, phrased exactly (D35)

> Phase III **may** observe that a commit occurred, failed, or used stale/inconsistent carried state,
> and **may report** that fact. It **may not** decide whether a commit is authorized to proceed.

Orchestration can say *"you committed before inspecting."* It can never say *"therefore I prevented
the commit."* That is Selvage territory. Measurement observes; governance intervenes; they never
touch. The package imports nothing from `@selvage/*`.

## The 3B gate (D33) — met

Every leg still runs through the **same** common bridge (`observeDecisionOnRuntime`) and the **same**
per-leg engine (`evaluatePath`) as Phase II; the multi-provider layer only judges *above* the legs,
attributing sequencing faults to `trajectory_orchestration` — which, being consumer/orchestrator
owned, never alters the provider grade.

| Fixture | Journey | Expected owner | Provider |
|---|---|---|---|
| **G3B-1** | cafe `place_order` → bakery `add_pastry` using the carried `orderId` | none (PASS) | PASS |
| **G3B-2** | bakery requires an `orderId` no prior step produced | `trajectory_orchestration` | PASS |
| **G3B-3** | cafe step deferred; bakery step runs anyway (`dependsOn` unmet) | `trajectory_orchestration` | PASS |
| **G3B-4** | every planned step iterated, but a required commit never happened (**D37**) | `trajectory_orchestration` | PASS |
| **G3B-5** | inspected the provider but the required commit never occurred | `trajectory_orchestration` | PASS |
| **G3B-6** | valid journey, provider returns bad evidence | `evidence_contract` | **FAIL** |
| **D36** | step 2 *claims* to bind the carried `orderId` but supplies a different value | `trajectory_orchestration` | PASS |

The carried value's lineage (`producedBy: {stepId, providerId, toolName}`) is recorded in the `/2`
report. The provider grade stays isolated throughout: an orchestration or lane fault is never
provider nonconformance.

## Locked non-goals for 3B

- no cross-model comparison (that is **3C**, seeded from the production adapter-parity matrix);
- no real multi-origin Chrome lane (later);
- no retry/error-recovery engine;
- no stale-term / authorization semantics (**held back so Phase III does not drift into Selvage**).

Next: **3C** asks the richest Phase III question — *given the same multi-provider trajectory spec and
starting state, do Claude, GPT, and Gemini each reach an allowable terminal state, and where do
their trajectories differ?* — where fabrication/self-verification (FX2) and asking-instead-of-
committing (FX3) become the interesting divergences.
