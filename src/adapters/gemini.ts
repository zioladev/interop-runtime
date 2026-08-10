// The third real model-family ModelConsumerAdapter: Google Gemini (Milestone 2C).
//
// Same discipline as Claude/GPT: plan() DECIDES, never executes; transport injected
// (deterministic tests, no key); zero-dep raw fetch; raw response preserved as evidence.
//
// Gemini is the one family that needs real schema normalization: its functionDeclarations use
// an OpenAPI subset that rejects JSON-Schema keywords like `additionalProperties` and `$ref`,
// and expresses nullability via `nullable` rather than a `["T","null"]` union. cleanSchema()
// handles that. Gemini also delivers functionCall args as an OBJECT (not a JSON string) and
// synthesizes no tool-call id — both handled here.

import type { ConsumerDecision, JsonSchema, ModelConsumerAdapter, PlanInput } from '../types.ts';
import { CONTINUE_NUDGE, carriedNote } from './history.ts';

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

export interface GeminiRequest {
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;
  tools: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  systemInstruction?: { parts: Array<{ text: string }> };
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response: unknown };
  [k: string]: unknown;
}

export interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  [k: string]: unknown;
}

export type GeminiTransport = (req: GeminiRequest) => Promise<GeminiResponse>;

export interface GeminiAdapterConfig {
  transport: GeminiTransport;
  modelId?: string;
  version?: string;
  system?: string;
}

const SUPPORTED = new Set(['type', 'description', 'enum', 'properties', 'required', 'items', 'format', 'nullable', 'minimum', 'maximum']);

/** Recursively reduce a JSON Schema to Gemini's OpenAPI subset. */
export function cleanSchemaForGemini(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Union type like ["string","null"] -> type:"string" + nullable:true.
  const t = schema.type;
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null');
    if (t.includes('null')) out['nullable'] = true;
    if (nonNull[0] !== undefined) out['type'] = nonNull[0];
  } else if (typeof t === 'string') {
    out['type'] = t;
  }

  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type') continue; // handled above
    if (!SUPPORTED.has(key)) continue; // drop additionalProperties, $ref, $schema, etc.
    if (key === 'properties' && value && typeof value === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, JsonSchema>)) {
        props[name] = cleanSchemaForGemini(child);
      }
      out['properties'] = props;
    } else if (key === 'items' && value && typeof value === 'object') {
      out['items'] = cleanSchemaForGemini(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function makeGeminiAdapter(config: GeminiAdapterConfig): ModelConsumerAdapter {
  const modelId = config.modelId ?? 'gemini-2.5-flash';
  return {
    id: 'google-gemini',
    version: config.version ?? '1.0.0',
    modelId,
    async plan(input: PlanInput): Promise<ConsumerDecision> {
      // 1. Format + normalize the surface into Gemini's functionDeclarations.
      const functionDeclarations = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: cleanSchemaForGemini(t.inputSchema),
      }));

      const req: GeminiRequest = {
        contents: geminiContents(input),
        tools: [{ functionDeclarations }],
        ...(input.system ?? config.system ? { systemInstruction: { parts: [{ text: (input.system ?? config.system) as string }] } } : {}),
      };

      // 2. Invoke. Transport failures are the adapter's environment — never provider fault.
      let res: GeminiResponse;
      try {
        res = await config.transport(req);
      } catch (err) {
        return { type: 'error', error: { code: 'transport_error', message: err instanceof Error ? err.message : String(err) } };
      }

      // 3. Parse. Gemini's functionCall args are already an object. Raw preserved as evidence.
      const parts = res.candidates?.[0]?.content?.parts ?? [];
      const fc = parts.find((p): p is GeminiPart & { functionCall: { name: string; args?: unknown } } => p.functionCall !== undefined);
      if (fc) {
        return { type: 'tool_call', toolName: fc.functionCall.name, arguments: fc.functionCall.args ?? {}, raw: res };
      }
      const text = parts.find((p) => typeof p.text === 'string');
      // Text without a tool call → no tool selected. Not upgraded to "clarification" (§07).
      return { type: 'no_action', reason: text?.text ?? 'model returned no tool call', raw: res };
    },
  };
}

/**
 * Build the Gemini contents, threading trajectory history + carried state in Gemini's native
 * functionCall / functionResponse format (responses matched by tool NAME, not id). With no history
 * and no carried state (a Phase II single decision), this is exactly one user turn with the task.
 */
function geminiContents(input: PlanInput): GeminiRequest['contents'] {
  const history = input.history ?? [];
  const contents: GeminiRequest['contents'] = [
    { role: 'user', parts: [{ text: input.task.text + carriedNote(input.carried) }] },
  ];
  history.forEach((h) => {
    if (h.decision.type === 'tool_call') {
      contents.push({ role: 'model', parts: [{ functionCall: { name: h.decision.toolName, args: h.decision.arguments ?? {} } }] });
      contents.push({ role: 'user', parts: [{ functionResponse: { name: h.decision.toolName, response: { result: h.result ?? { executed: h.executed } } } }] });
    } else if (h.decision.type === 'clarification') {
      contents.push({ role: 'model', parts: [{ text: h.decision.message ?? '(asked for clarification)' }] });
    } else if (h.decision.type === 'no_action') {
      contents.push({ role: 'model', parts: [{ text: h.decision.reason ?? '(no tool call)' }] });
    }
  });
  if (contents[contents.length - 1]?.role === 'model') contents.push({ role: 'user', parts: [{ text: CONTINUE_NUDGE }] });
  return contents;
}

/**
 * A real fetch transport to the Gemini generateContent API. Node/browser-safe. NOT used in CI.
 * Reads GEMINI_API_KEY (or GOOGLE_API_KEY). A live run needs a key.
 */
export function geminiFetchTransport(opts: { apiKey?: string; model?: string; baseUrl?: string }): GeminiTransport {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  const apiKey = opts.apiKey ?? g.process?.env?.['GEMINI_API_KEY'] ?? g.process?.env?.['GOOGLE_API_KEY'];
  const model = opts.model ?? 'gemini-2.5-flash';
  const baseUrl = opts.baseUrl ?? 'https://generativelanguage.googleapis.com';
  return async (req: GeminiRequest): Promise<GeminiResponse> => {
    if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set');
    const res = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
    return (await res.json()) as GeminiResponse;
  };
}

/** Convenience for tests/demos: a transport that always returns a canned response. */
export function staticGeminiTransport(response: GeminiResponse): GeminiTransport {
  return async () => response;
}
