// The common execution bridge (§02). It is the ONLY thing that executes, for every adapter
// AND every lane. Adapters decide what to call; the bridge executes that decision against a
// WebMcpRuntime — the in-process ReferenceRuntime or a real `document.modelContext`. Expressing
// discovery + execution once, over the runtime interface, is what makes the Chrome lane a
// drop-in: the lane changes, this code does not (§14).

import type { ExecutionResult, NormalizedTool, ToolDef } from './types.ts';
import { normalizeDiscovered } from './normalize.ts';
import type { WebMcpRuntime } from './reference-runtime.ts';

export interface BridgeOutcome {
  ok: boolean;
  firedTool?: string;
  executionResult?: ExecutionResult;
  error?: { code: string; message: string };
}

/** Discover the provider surface through the runtime and normalize it once. */
export async function discover(runtime: WebMcpRuntime, defs: ToolDef[]): Promise<NormalizedTool[]> {
  const handles = await runtime.getTools();
  return normalizeDiscovered(handles, defs);
}

/**
 * Execute one tool_call decision against the runtime. The bridge always resolves the
 * RegisteredTool HANDLE from getTools() and calls executeTool with the handle — never a name
 * string. (A harness that passed a string would be an execution_bridge fault.) Works
 * identically against the reference runtime and a real `document.modelContext`.
 */
export async function execute(
  runtime: WebMcpRuntime,
  toolName: string,
  args: unknown,
): Promise<BridgeOutcome> {
  const handles = await runtime.getTools();
  const handle = handles.find((t) => t.name === toolName);
  if (!handle) {
    return { ok: false, error: { code: 'bridge_no_handle', message: `no RegisteredTool handle for "${toolName}"` } };
  }
  try {
    const raw = await runtime.executeTool(handle, JSON.stringify(args ?? {}));
    const result = JSON.parse(raw) as ExecutionResult;
    return { ok: true, firedTool: toolName, executionResult: result };
  } catch (err) {
    return {
      ok: false,
      error: { code: 'bridge_execute_failed', message: err instanceof Error ? err.message : String(err) },
    };
  }
}
