# interop-runtime — specification

`@zioladev/interop-runtime` measures multi-step, multi-provider WebMCP **trajectories** and
attributes any failure to the layer that caused it. It builds on the single-decision measurement
language of `@zioladev/provider-conformance` (Phase II) but is an independent package — see
[`../DUPLICATION-LEDGER.md`](../DUPLICATION-LEDGER.md).

## The documents

| # | Doc | What it fixes |
|---|-----|---------------|
| 11 | [decision-record](./11-decision-record.md) | The full D-series. **D25–D30** (3A: the trajectory layer + `trajectory_orchestration` + report `/2`), **D31–D37** (3B: multi-provider + lineage-bearing carried state + the *model-memory* and *loop≠completion* laws), **D38–D41** (3C: cross-model comparison + the live gate). D1–D24 are retained as Phase II background. |
| 15 | [trajectories](./15-phase-iii-trajectories.md) | 3A — measuring a **trajectory**, not a single decision. The `trajectory_orchestration` owner; report `/2`. |
| 16 | [multiprovider](./16-phase-iii-3b-multiprovider.md) | 3B — **multi-provider** trajectories; provenance-bearing carried state; *model memory ≠ authoritative state*; *loop ≠ completion*. |
| 17 | [crossmodel](./17-phase-iii-3c-crossmodel.md) | 3C — **cross-model** comparison; *different path ≠ failure*; compare on observed execution, not narration; the cloud-only live acceptance gate. |
| 18 | [chrome-acceptance](./18-chrome-acceptance.md) | The final Phase III gate — real Chrome/WebMCP via a `BrowserHost` port. **Refraktor as browser host/transport; interop-runtime as the brain.** No legacy orchestration. |

## Status

The reference lane (deterministic) is proven by the golden trajectory + cross-model tests. The
**live** cross-model acceptance gate runs the real Claude/GPT/Gemini APIs from the cloud
(`.github/workflows/crossmodel-live.yml`).
