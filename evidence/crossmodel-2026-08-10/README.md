# 3C cross-model live acceptance — frozen evidence (2026-08-10)

The first live cross-model, multi-provider **interoperability trajectory** run for
`@zioladev/interop-runtime`: real Claude, GPT, and Gemini each traversed the **same frozen
multi-provider spec**, from the cloud (GitHub Actions), with authoritative carried state and one
common execution bridge.

## Discipline (why this folder exists)

- The fixture (`fixture.json`) was **frozen before the run** and **not edited after observing
  behavior**.
- The evidence files below are preserved **exactly as produced** by the run — not polished,
  trimmed, or re-interpreted after seeing the result. The `MANIFEST` (SHA-256) certifies that.
- The run used the **`reference-runtime/1`** lane (deterministic, in-process), **not** real
  Chrome/WebMCP. A real Chrome/WebMCP acceptance is a separate, still-pending gate.

## What the evidence records (factual)

Models: `claude-haiku-4-5-20251001`, `gpt-4o-mini`, `gemini-2.5-pro`. All three reached the same
allowable terminal state via the same route (`cafe/commit:place_order → bakery/commit:add_pastry`);
the cafe's `orderId` was carried across the origin boundary into the bakery step and verified used
(`carried_input_used`); provider grade PASS throughout; `pathDifference: no`,
`terminalStateDifference: no`, `trajectoryConformanceDifference: no` — convergence. Every model's
**raw response at every step** is preserved. Nothing is claimed beyond the per-layer verdicts and
raw responses recorded here.

## Files

| File | What it is |
|---|---|
| `fixture.json` | The FROZEN trajectory spec + provider definitions (committed before the run). |
| `evidence.json` | Machine-readable: per-model, per-step raw responses + carried state (with provenance) + per-layer attribution + the cross-model comparison. |
| `artifact.txt` | The human-readable cross-model artifact (the rendered comparison). |
| `crossmodel-live-log.txt` | The full workflow log, including each model's per-step raw response verbatim. |
| `NOTES.md` | The run's own notes (models, runtime, discipline), as produced. |
| `MANIFEST` | SHA-256 of each evidence file — proof the bundle is frozen as produced. |

## Reproduction

Run `.github/workflows/crossmodel-live.yml` (workflow_dispatch) with `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY` set, over the frozen `crossModelJourneySpec`
(`tests/sample-provider.ts`). Model behavior is observation, not ground truth; a re-run may
converge identically or diverge — either is a valid observation.
