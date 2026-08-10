# 15 — Phase III: the trajectory layer (report contract `/2`)

> Phase II measures a **decision**. Phase III measures a **trajectory**.

Phase II answers: *given one provider surface and one task, what did one model decide, and
whose layer owns any failure?* That is a single `inspect **or** decide **or** commit` step.
Phase III answers the next question: *when a task takes several steps —
`inspect → decide → commit`, carrying each step's output forward toward a terminal state — did
the **journey** hold together, and whose layer owns any failure there?*

This is milestone **3A**: single provider, multi-step, reference-runtime lane only. Multiple
providers (3B), multiple model families over one trajectory (3C), and the real Chrome/WebMCP
trajectory lane come later — the same discipline that made Phase II real: **prove the
instrument before increasing dimensionality.**

## The law: the trajectory layer sits *above* the steps, never in place of them

```
Trajectory
  ├─ Step 1  ── Phase II attribution (evaluatePath)   ← never erased
  ├─ Step 2  ── Phase II attribution (evaluatePath)   ← never erased
  ├─ Step 3  ── Phase II attribution (evaluatePath)   ← never erased
  └─ Trajectory judgment
        ├─ ordering
        ├─ state propagation
        ├─ terminal state
        └─ trajectory_orchestration attribution
```

Every step is executed through the **same common bridge** as Phase II
(`observeDecisionOnRuntime`) and judged by the **same engine** (`evaluatePath`). A trajectory
is *an ordered sequence of independently attributable decisions and executions* (D25). The
new work is only the judgment **above** the steps. Collapsing a journey into one PASS/FAIL
would throw away the fault isolation the whole system exists to provide.

## The new attribution owner: `trajectory_orchestration`

Trajectories introduce a failure mode single decisions cannot have: **sequencing**. Valid
steps, wrong journey. `trajectory_orchestration` (D26) owns:

- valid steps in an invalid order;
- failing to carry a prior output forward;
- skipping a required prerequisite step;
- committing before required inspection;
- transitioning to the wrong next step;
- continuing past the point the journey should have terminated.

It is **consumer/orchestrator-owned**, so — exactly like the other consumer-side categories —
it **never** alters the provider grade. The prime invariant is unchanged: a consumer-side (now
also orchestration-side) failure is never provider nonconformance.

**The discipline (D26).** Attribute to `trajectory_orchestration` *only* when each individual
step was itself valid but the journey logic around it was wrong. A wrong tool selected *inside*
a step stays `model_tool_selection`. Bad provider evidence *inside* a step stays
`evidence_contract`. The trajectory layer adds a lens; it does not relabel what the step layer
already owns.

Adding a category changes the semantic meaning of the contract, so the report version bumps:
`/1` stays the single-decision report; **`/2`** is trajectory-aware (D27). They are kept
distinct on purpose — `/2` is not an optional field bolted onto `/1`.

## Frozen fixtures: constrain what must be *true*, not *how* to get there (D28)

A trajectory fixture (`TrajectorySpec`) freezes, a priori:

- the **initial state**;
- the **allowed step types** (the sanctioned tool set);
- the **required terminal state(s)** and any **forbidden** ones;
- the semantically necessary **invariants**;
- and the **maxSteps** termination guard.

It does **not** freeze a canonical path. `inspect menu → inspect item → commit` and
`inspect item → commit` both conform if the invariants hold. Requiring one route would punish
legitimate model strategy. The 3A invariant vocabulary is deliberately small and mechanical:
`inspect_before_commit`, `no_commit_before_fields`, `commit_uses_prior_output`,
`exactly_one_commit` — extended, never redefined, later.

## Divergence, lifted to journeys (D29)

Three orthogonal flags:

- `pathDifference` — the executed routes differ;
- `terminalStateDifference` — the reached terminal states differ;
- `trajectoryConformanceDifference` — one conforms and another doesn't.

Same terminal state via different valid paths is **path difference, not behavioral failure** —
the Phase II law *different ≠ wrong* raised to the trajectory. Meaningful divergence is a
different terminal state, a violated invariant, a failure to terminate, or one consumer
succeeding where another cannot.

## The 3A gate (D30)

3A is **not** "done" when the happy journey passes. It is done when a golden **sequencing**
fault attributes to `trajectory_orchestration` **without altering the provider grade** — i.e.
when the new category is proven to actually work. The golden set:

| Fixture | Journey | Expected owner | Provider |
|---|---|---|---|
| **T1** | `lookup_drink → place_order` (valid) | none (PASS) | PASS |
| **T2** | `place_order` before any lookup | `trajectory_orchestration` | PASS |
| **T3** | lookup succeeds, commit ignores its output | `trajectory_orchestration` | PASS |
| **T4** | lookup, then a tool outside the sanctioned set | `model_tool_selection` (not orchestration) | PASS |
| **T5** | valid journey, provider returns bad evidence | `evidence_contract` (provider-owned) | **FAIL** |
| **T6** | two valid routes to the same terminal state | none — `pathDifference` only | PASS |

T2 and T3 prove the new category fires. T4 proves a wrong tool *inside* a step is not
laundered into orchestration. T5 proves a provider fault still surfaces *through* the
trajectory layer and lands on the provider. T6 proves *different route ≠ wrong*.

## Locked non-goals for 3A

- no live-browser trajectories (reference lane only);
- no retry / error-recovery engine;
- no multi-provider handoff (3B);
- **no Selvage / authorization** — transaction assurance stays out until the trajectory layer
  itself is proven.

The report contract does not become "real" until, as in Phase II, both independent dimensions
are green — here, the golden trajectory gate (this) and, eventually, a real Chrome/WebMCP
trajectory run. 3A delivers the first.
