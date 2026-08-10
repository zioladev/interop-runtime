// A faithful in-process WebMCP reference runtime (lane: reference-runtime/1).
//
// It mirrors the real `document.modelContext` surface confirmed in Phase I acceptance:
// registerTool / getTools / executeTool, where executeTool requires a RegisteredTool
// HANDLE (not a name string) and returns the ToolResult as a JSON string.
//
// It is a faithful shim, never presented as browser conformance (§09).

import type { ExecutionResult, ToolDef } from './types.ts';

export const REFERENCE_RUNTIME_ID = 'reference-runtime/1';

/**
 * The minimal WebMCP runtime surface the common bridge speaks to — satisfied by BOTH the
 * in-process ReferenceRuntime AND a real `document.modelContext` (via detectWebMcpRuntime).
 * This is what makes "the lane changes; the measurement language does not" true in code (§14):
 * discovery + execution are expressed once, over this interface, for every lane.
 */
export interface RuntimeTool {
  readonly name: string;
  readonly description?: string;
  /** Schema as a JSON string (real runtime) or an object, or absent. */
  readonly inputSchema?: string | object;
}

export interface WebMcpRuntime {
  getTools(): RuntimeTool[] | Promise<RuntimeTool[]>;
  /** executeTool requires the RegisteredTool HANDLE from getTools(), returns a JSON string. */
  executeTool(tool: RuntimeTool, argsString: string): Promise<string>;
}

/** Opaque handle returned by getTools(). executeTool requires one of these. */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  /** Schema as a JSON string, mirroring how the live runtime hands it back. */
  readonly inputSchema: string;
  /** Brand so a bare name string cannot masquerade as a handle. */
  readonly __registered: true;
}

type Handler = (args: unknown) => ExecutionResult | Promise<ExecutionResult>;

export class ReferenceRuntime {
  #tools = new Map<string, { def: ToolDef; handler: Handler; handle: RegisteredTool }>();

  registerTool(def: ToolDef, handler: Handler): void {
    const handle: RegisteredTool = {
      name: def.name,
      description: def.description,
      inputSchema: JSON.stringify(def.inputSchema),
      __registered: true,
    };
    this.#tools.set(def.name, { def, handler, handle });
  }

  getTools(): RegisteredTool[] {
    return [...this.#tools.values()].map((t) => t.handle);
  }

  /** Execute a tool. Requires the RegisteredTool handle; a string throws. */
  async executeTool(tool: RegisteredTool, argsString: string): Promise<string> {
    if (typeof (tool as unknown) === 'string' || !tool || tool.__registered !== true) {
      throw new TypeError('executeTool requires a RegisteredTool handle, not a name string');
    }
    const entry = this.#tools.get(tool.name);
    if (!entry) throw new Error(`unknown tool: ${tool.name}`);
    const args = argsString ? JSON.parse(argsString) : {};
    const result = await entry.handler(args);
    return JSON.stringify(result);
  }
}
