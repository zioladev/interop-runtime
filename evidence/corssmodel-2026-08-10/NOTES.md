# 3C cross-model live evidence

Models: anthropic-claude (claude-haiku-4-5-20251001), openai-gpt (gpt-4o-mini), google-gemini (gemini-2.5-pro)
Frozen trajectory: order-then-pastry/3c-live
Runtime: reference-runtime/1 — the REFERENCE lane, NOT real Chrome/WebMCP.

Each model traversed the SAME frozen multi-provider spec (fixture.json — committed before this
run, never edited after observing behavior), with authoritative carried state and one common
execution bridge. evidence.json preserves EVERY step's raw model response, the carried state with
provenance, and the per-layer attribution. Path differences are recorded, never treated as failure;
the provider grade is computed from provider-owned layers only. No claims beyond what is recorded.
