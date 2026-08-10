# 17 — Phase III / 3C: cross-model trajectory comparison

> The richest Phase III question: given the **same** frozen multi-provider trajectory spec, the
> **same** starting state, the **same** provider surfaces, the **same** authoritative carried-state
> model, the **same** common execution bridge, and the **same** terminal-state rules — do Claude,
> GPT, and Gemini each reach an allowable terminal state, and where do their trajectories diverge?

This is the step up the whole program was building toward: **we are no longer measuring isolated
model decisions (Phase II) or one model's journey (3A/3B) — we are measuring cross-model
interoperability over multi-provider trajectories.** Single reference lane, single frozen spec,
production-derived adapters. No new execution: every model runs the exact same multi-provider engine
(§16); 3C only *runs* N adapters over one spec and *compares* the results.

## The two laws of comparison

**Different path is not failure (D40).** Two models that take different but valid routes to the same
allowable terminal state — preserving carried state, satisfying every invariant — are BOTH
conformant. If Claude does `inspect → commit` and GPT does `inspect → inspect → commit`, and both
reach the same terminal with state intact:

```
path difference:                yes
terminal-state difference:      no
trajectory-conformance difference: no
provider:                       PASS
```

That is the *good* kind of divergence. It is the Phase II rule (§07, *different ≠ wrong*) lifted to
trajectories. **The system's job is to tell the truth — never to manufacture divergence for drama.**
If all three converge, that is the valuable result.

**Comparison is on observed executions, not narration (D38).** A step is *attained* only when the
common bridge actually executed the provider tool. A model that says "done, order placed" without
executing has attained nothing. This is D36/FX2 turned into a comparison rule: we compare *facts*,
not *stories*.

## Attribution ownership, refined (D39)

3C sharpened where a trajectory fault is owned:

> **Model errs → model layer. Runtime mishandles → orchestration.**

When a model **cleanly declines a required commit** — asks, inspects, or narrates instead of
executing — the trajectory *records* terminal-not-attained, but the fault is **`model_tool_selection`**,
because a correct runtime does not advance on the model's word. `trajectory_orchestration` is reserved
for the runtime mishandling case (a broken runtime that *believes* the narration and advances). Our
engine never does that (D38), so a clean decline is always the model's fault. (This reclassified the
3B terminal-non-attainment fixtures from orchestration to `model_tool_selection`.)

And politeness is not in the rubric: **the frozen spec decides** whether asking is acceptable. If the
spec permits clarification at that point, a deferral is conformant. If the spec says the data are
known and a commit is required, then "shall I place it?" → no commit → terminal not attained → a real
trajectory failure, however politely phrased.

## Three layers of comparison

- **Step-level** (Phase II shaped): per model, per step — decision, tool, arguments, execution,
  evidence, attribution. (Preserved per leg; never erased.)
- **Trajectory-level** (§16): per model — path sequence, carried-state usage, provider transitions,
  invariant satisfaction, terminal attainment.
- **Cross-model** (this milestone): path differences, terminal-state differences, trajectory-
  conformance differences — and the provider grade across all models (provider-owned layers only).

The artifact reads like:

```
Trajectory: cafe → bakery

anthropic-claude (claude-…)
  Path: cafe/commit:place_order -> bakery/commit:add_pastry
  Terminal: attained
  Conformant: PASS

openai-gpt (gpt-…)
  Path: cafe/inspect:lookup_drink -> cafe/commit:place_order -> bakery/commit:add_pastry
  Terminal: attained
  Conformant: PASS

google-gemini (gemini-…)
  Path: cafe/commit:place_order -> bakery/(deferred)
  Terminal: not attained
  Conformant: FAIL
  Attribution: model_tool_selection

Provider: PASS
Cross-model: path difference: yes · terminal difference: yes · conformance difference: yes
```

## The 3C gate — met (deterministically)

**Success criterion:** Claude, GPT, and Gemini each successfully traverse the same frozen
multi-provider trajectory using production-derived adapters, authoritative carried state, and one
common execution bridge, reaching the same allowable terminal state — the report preserving any path
differences without treating valid variation as failure.

The gate is met with the **production-derived adapters** (`makeClaudeAdapter` / `makeGptAdapter` /
`makeGeminiAdapter`) driven deterministically through sequenced injected transports, so their real
tool-call parsing runs across a multi-provider trajectory with no network:

- **Convergence** — all three reach the same allowable terminal state, carried `orderId` authoritative
  (provenance preserved per model), provider PASS, no conformance difference.
- **Path variation is not failure** — two models take different valid routes to the same terminal;
  `pathDifference: true`, `conformanceDifference: false`, converged.
- **Real failure is caught and told apart** — a model that fabricates completion (FX2) or asks when a
  commit is required (FX3) is `model_tool_selection` / terminal-not-attained, while the good model
  conforms; provider PASS throughout; a fabricator's narration is never accepted as attainment.
- **Ask-when-allowed conforms** — where the frozen spec permits clarification, a deferral passes.

## Scope / non-goals (3C)

- reference lane only; **no live multi-origin Chrome** yet;
- **no retries / recovery**; no Selvage; **no semantic judge layer**;
- **the allowable paths and terminal rules are frozen before any model runs** — never adjusted after
  seeing behavior.

## The live acceptance gate (D41) — cloud-only

The deterministic gate proves the comparison and the adapters' parsing; the **live** gate runs the
real APIs. It is **cloud-only**, exactly like the 2C three-way and the Chrome-lane acceptance — a
`workflow_dispatch` GitHub Action (`.github/workflows/crossmodel-live.yml` /
`provider-conformance-crossmodel-live.yml`) using repository secrets `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` / `GEMINI_API_KEY`. No local terminal, IDE, or environment is required.

- **Threading (built first).** Each production-derived adapter now threads `history` + `carried`
  into the model's prompt in that vendor's native tool-call/tool-result format — Anthropic
  `tool_use`/`tool_result`, OpenAI `tool_calls`/`role:tool`, Gemini `functionCall`/`functionResponse`
  (matched by tool name). A single-decision (Phase II) plan is byte-identical to before. The carried
  state is presented as authoritative context (D36); the prior results are the observed evidence (D38).
- **Frozen first.** The fixture (`crossModelJourneySpec`) is committed before the run and never edited
  after observing behavior. Same frozen spec, common bridge, and terminal predicates as the
  deterministic gate.
- **Every step's raw is preserved.** `scripts/crossmodel-live.ts` records **each model's raw response
  at every trajectory step** (not just the final), alongside the carried state with provenance and the
  per-layer attribution, and uploads a self-contained `crossmodel-bundle/` (evidence.json · artifact.txt
  · fixture.json · NOTES.md) as a workflow artifact. Phase II taught us that keeping only the final
  response loses exactly the evidence that explains where a trajectory broke.

The measurement language does not change; the live gate only exercises it against the real model APIs.
