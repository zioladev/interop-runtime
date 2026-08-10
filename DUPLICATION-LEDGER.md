# Duplication ledger — shared-candidate primitives

Per the Phase III extraction decision: `@zioladev/interop-runtime` takes **no dependency** on
`@zioladev/provider-conformance`. To keep both packages independently functional, the small, stable
single-decision primitives the trajectory runtime needs are **re-authored here** rather than
imported. That is a deliberate, temporary duplication — recorded here so a future shared-layer
review has an exact list.

**Rule (ratified):** do **not** create a neutral shared package (e.g. `@zioladev/consumer-core` or
`@zioladev/model-adapters`) merely to remove this duplication. Only after Phase III **live**
validation, review whether the genuinely stable common pieces have survived real runs and justify a
neutral package. Removing duplication before the interfaces are proven would be the wrong trade.

## Duplicated files (byte-for-byte or near-identical with `@zioladev/provider-conformance`)

| File | What it is | Stability | Shared-package candidate? |
|---|---|---|---|
| `src/types.ts` | Core contracts: `Effect`, `ToolDef`, `ConsumerDecision`, `PlanInput`, `ModelConsumerAdapter`, `AttributionCategory`, `PROVIDER_OWNED`, `StepResults`, `PathDerived`, … | High (the measurement vocabulary) | **Strong** — but note interop adds `trajectory_orchestration`, `PriorStep`, `CarriedValue`, `ProviderRef`, `ArgBinding`, and `PlanInput.history/carried`, which are Phase III concepts. A shared type package would need to keep those additive/optional. |
| `src/engine.ts` | `evaluatePath` (the per-step attribution walk) + divergence/grade helpers | High | **Strong** — the single-decision attribution engine is the shared spine. |
| `src/bridge.ts` | `discover` / `execute` — the common execution bridge over `WebMcpRuntime` | High | **Strong** |
| `src/reference-runtime.ts` | `ReferenceRuntime` + `WebMcpRuntime`/`RuntimeTool`/`RegisteredTool` | High | **Strong** |
| `src/normalize.ts` | `validateProvider` / `validateInput` / `normalizeDiscovered` | High | Medium |
| `src/run-case.ts` | `observeDecisionOnRuntime` (the shared step-execution path) + single-decision runners | Medium | Medium — `observeDecisionOnRuntime` is the shared bit; the single-decision `buildCase` conveniences are Phase II's. |
| `src/adapters/scripted.ts` | `makeScriptedAdapter` + `makeScriptedTrajectoryAdapter` | High | Medium |
| `src/adapters/claude.ts` | Anthropic adapter (+ history threading) | Medium (vendor API shape drifts) | **Strong candidate for `@zioladev/model-adapters`** |
| `src/adapters/gpt.ts` | OpenAI adapter (+ history threading) | Medium | **Strong candidate** |
| `src/adapters/gemini.ts` | Gemini adapter (+ `cleanSchemaForGemini` + history threading) | Medium | **Strong candidate** |
| `src/adapters/history.ts` | Vendor history/carried threading helpers | Medium | Ships with the adapters if they move. |
| `src/report-version.ts` | Report version + generator identity constants | High | Low (each report contract owns its version) |

## Intentionally NOT duplicated (left in `@zioladev/provider-conformance`)

- The `/1` single-decision report (`report.ts`, `render.ts`) — that is Phase II's product.
- `webmcp-runtime.ts` (real `document.modelContext` detection) + the Chrome/WebMCP acceptance lane —
  Phase II's `/1` lane. When interop grows a real multi-origin Chrome trajectory lane, it will
  re-author the minimum runtime-detection piece it needs then, not before.
- The Phase II golden fixtures, `e2e`/`ambiguous`/`divergence` tests, and the `/1` evidence bundles.

## Divergence risk (what to watch)

The adapters and `types.ts` are the most likely to drift between the two packages. If a vendor API
change or an attribution-taxonomy change lands in one, port it to the other in the same change, or
accept that the shared-layer review will reconcile them. When that review happens, the adapters
(`claude`/`gpt`/`gemini`/`history` + `cleanSchemaForGemini`) are the first, strongest candidate for a
neutral `@zioladev/model-adapters`; the `types`/`engine`/`bridge`/`reference-runtime` spine is the
second, for a `@zioladev/consumer-core`.
