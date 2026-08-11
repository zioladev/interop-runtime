# 18 — The Chrome/WebMCP acceptance lane (Refraktor as host)

> **New interop-runtime brain; existing Refraktor browser arms and legs.**

The final Phase III gate runs a frozen multi-provider trajectory against **real** Chrome/WebMCP,
across independent origins. An unprivileged page cannot reach another origin's
`document.modelContext`, and navigating the tab destroys the page that would be orchestrating — so
the run needs a **privileged host**. Rather than build a second extension or a headless harness,
the acceptance uses **Refraktor** (the existing extension) purely as the **browser host/transport**:
it supplies browser privilege and survives origin transitions. Headless Chromium stays a Phase VI
hosted-qualification concern, not this gate.

## The hard invariant

`@zioladev/interop-runtime` stays **authoritative** for trajectory state, carried-state provenance,
sequencing, and terminal-state evaluation. Refraktor is handed **one navigation, one discovery, or
one tool call at a time** and never decides the sequence. **Refraktor's legacy itinerary /
orchestration logic (`buildItinerary`, `verifyJourney`, `create_itinerary`, `fulfillStep`) is NOT
used for the acceptance run.** If any of that drove the journey, the gate would be measuring the old
system, not the new one. The port shape below makes that impossible: the host has no method that
plans or sequences.

## The port (defined here; implemented by the host)

interop-runtime defines `BrowserHost` (`src/browser-host.ts`) and imports nothing from Refraktor.
A host implements it; interop-runtime drives it via `makeBrowserSurfaceResolver(host, defsByProvider)`,
a Chrome-lane `SurfaceResolver` the trajectory engine already knows how to use (D34).

```ts
interface BrowserHost {
  prepareSurface(provider: ProviderRef): Promise<{ ready: boolean; detail?: string }>;
  listTools(): Promise<RuntimeTool[]>;
  callTool(toolName: string, argsString: string): Promise<string>;
  browserVersion?(): Promise<string | null> | string | null;
}
```

The engine, per step: `resolver.resolve(provider)` → host navigates + waits for discovery → returns
a runtime that proxies `getTools`/`executeTool` to the active page. The common execution bridge then
runs the model's decision against that surface exactly as on the reference lane. The lane changes;
the measurement language does not. The report is stamped `runtimeId: chrome-webmcp` + `browserVersion`.

## Fault isolation (unchanged)

A surface that never becomes discoverable resolves `{ ready: false }` → the engine attributes
`browser_runtime` with the **provider PASS** (proven in `tests/browser-lane.test.ts`). A browser
failure is never provider nonconformance — the same isolation the Phase II Chrome lane established.

## Refraktor wiring (what the host side implements — no legacy orchestration)

The Refraktor-side adapter (living in the Refraktor repo, not here) maps each `BrowserHost` method to
Refraktor's **existing low-level bridge only**:

| `BrowserHost` | Refraktor bridge (existing) | Notes |
|---|---|---|
| `prepareSurface(provider)` | `navigateAndDiscover(step.url)` — navigate the active tab to `provider.toolEndpoint`, then the readiness poll (bounded timeout + one refresh nudge) | Return `{ ready:false, detail }` on timeout / no tools / nav error — never throw. Per-origin, non-transitive discovery. |
| `listTools()` | the discovered-tools cache for the active page (`bridge.js` `discovered[]`, via the SW relay) | Return the tools as `{ name, description, inputSchema }`. |
| `callTool(name, argsString)` | `executeToolOnPageRaw` → `EXECUTE_TOOL_REQUEST` → in-page `bridge.js executeTool` (resolves the real `RegisteredTool` handle by name, calls `document.modelContext.executeTool`) → `unwrapResult` | interop-runtime passes the name across the port; Refraktor keeps the real page handle. Return the ToolResult as a JSON string. |
| `browserVersion()` | capture from the runtime (UA / captured version) | Stamped into `lane.browserVersion`. |

The acceptance entry (also Refraktor-side) loads a bundled `@zioladev/interop-runtime`, constructs
the `BrowserHost` from the wiring above, and calls `runMultiProviderTrajectory(makeBrowserSurfaceResolver(host, defsByProvider), frozenSpec, adapter)` — **the same frozen spec and terminal predicates as the deterministic and 3C-live gates.** It preserves every step's raw response and writes the `chrome-webmcp` report + evidence, exactly like the reference/live gates.

## Non-goals

- No new extension, no headless harness (Phase VI).
- No dependency on Refraktor from interop-runtime, and no Refraktor product dependency on interop-runtime beyond loading it as the brain for the acceptance run.
- No reuse of Refraktor's legacy orchestration — the new runtime drives the journey.

Deterministic proof that the brain can drive a browser journey through this port (a fake host
standing in for Refraktor, plus browser-fault isolation) is in `tests/browser-lane.test.ts`. The
real Chrome run against Refraktor is the remaining, human-driven acceptance.
