// The Chrome/WebMCP acceptance lane — a SurfaceResolver backed by a privileged BROWSER HOST.
//
// The whole design in one sentence: **interop-runtime is the brain; the browser host is the arms
// and legs.** interop-runtime remains authoritative for trajectory state, carried-state
// provenance, sequencing, and terminal-state evaluation. A privileged host (the Refraktor
// extension in the acceptance gate) supplies only browser reach: it navigates to each provider's
// origin, waits until that surface's WebMCP tools are discoverable, lists them, and executes one
// tool call at a time on the active page — surviving the origin transitions an unprivileged page
// cannot.
//
// interop-runtime DEFINES this port; a host IMPLEMENTS it. This package imports nothing from the
// host. That inversion is what keeps the host's own legacy orchestration OUT of the journey: the
// host is handed one navigation, one discovery, or one tool call at a time and never decides the
// sequence — the trajectory engine here does. (Headless Chromium is a Phase VI hosted-qualification
// concern, not this gate.)

import type { ProviderRef, ToolDef } from './types.ts';
import type { WebMcpRuntime, RegisteredTool, RuntimeTool } from './reference-runtime.ts';
import type { SurfaceResolver, ResolvedSurface } from './trajectory-multi.ts';

/** The runtime lane id for a trajectory driven through a real browser host. */
export const CHROME_WEBMCP_RUNTIME_ID = 'chrome-webmcp';

/**
 * The PORT a privileged browser host implements so interop-runtime can drive a trajectory through
 * a real browser. Every method acts on the CURRENTLY ACTIVE surface (the one last prepared). The
 * host owns navigation, discovery readiness, and single-call execution — nothing else. It never
 * plans, sequences, carries state, or judges terminal state; those stay in interop-runtime.
 */
export interface BrowserHost {
  /**
   * Navigate/focus the surface for `provider` (its origin / tool endpoint) and wait until its
   * WebMCP tools are discoverable. Returns readiness — a surface that never becomes discoverable
   * is a BROWSER-side fault (reported `browser_runtime`, provider PASS), so a host SHOULD resolve
   * `{ ready: false, detail }` rather than throw.
   */
  prepareSurface(provider: ProviderRef): Promise<{ ready: boolean; detail?: string }>;
  /** List the WebMCP tools currently registered on the active surface. */
  listTools(): Promise<RuntimeTool[]>;
  /** Execute one tool call on the active surface; returns the ToolResult as a JSON string. */
  callTool(toolName: string, argsString: string): Promise<string>;
  /** Optional: the browser version, to stamp into the report lane. */
  browserVersion?(): Promise<string | null> | string | null;
}

/**
 * A WebMcpRuntime that proxies discovery + execution through a BrowserHost to the real active
 * page. The common execution bridge speaks to this exactly as it speaks to the in-process
 * ReferenceRuntime — the lane changes, the measurement language does not.
 */
class BrowserRuntime implements WebMcpRuntime {
  readonly #host: BrowserHost;
  constructor(host: BrowserHost) {
    this.#host = host;
  }
  getTools(): Promise<RuntimeTool[]> {
    return Promise.resolve(this.#host.listTools());
  }
  executeTool(tool: RuntimeTool | RegisteredTool, argsString: string): Promise<string> {
    // The host re-resolves the real page handle by name internally (the privileged side keeps the
    // object the runtime handed it — never a reconstructed one). We pass the name across the port.
    return this.#host.callTool(tool.name, argsString);
  }
}

/**
 * A Chrome-lane SurfaceResolver backed by a BrowserHost. For each step, the trajectory engine asks
 * this to resolve the step's provider surface; it has the host navigate + wait for discovery, then
 * hands back a runtime that proxies to the active page. The engine then plans (via the model
 * adapter) and executes (via the common bridge) against that surface — staying authoritative for
 * everything above a single navigate/discover/execute.
 *
 * `defsByProvider` supplies each provider's declared tool definitions (for static validation +
 * effect classification); the host supplies live discovery + execution.
 */
export function makeBrowserSurfaceResolver(
  host: BrowserHost,
  defsByProvider: Record<string, ToolDef[]>,
): SurfaceResolver {
  return {
    async resolve(provider: ProviderRef): Promise<ResolvedSurface> {
      const prep = await host.prepareSurface(provider);
      const defs = provider.id in defsByProvider ? defsByProvider[provider.id]! : [];
      return {
        runtime: new BrowserRuntime(host),
        defs,
        ready: prep.ready,
        ...(prep.detail !== undefined ? { detail: prep.detail } : {}),
      };
    },
  };
}
