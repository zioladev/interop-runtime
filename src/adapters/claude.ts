// The first real model-family ModelConsumerAdapter: Anthropic Claude (Milestone 2B).
//
// It obeys the same invariant as every adapter: plan() DECIDES, never executes. It only
// talks to the model (through an injected transport) and returns a ConsumerDecision. The
// common execution bridge is still the only thing that touches the provider surface.
//
// The transport is injected so the adapter's schema formatting + tool-call parsing are
// deterministically testable with canned Anthropic responses (no network, no key), while a
// live run is one real transport away. We ALWAYS attach the model's raw response to the
// decision as observed evidence — the weirdness is preserved, never normalized away (§04).

import type { ConsumerDecision, ModelConsumerAdapter, PlanInput } from '../types.ts';
import { CONTINUE_NUDGE, carriedNote, stepResultText } from './history.ts';

/** The minimal shapes of the Anthropic Messages request/response we depend on. */
export interface AnthropicRequest {
  model: string;
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  max_tokens: number;
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [k: string]: unknown };

export interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  [k: string]: unknown;
}

/** The pluggable transport. In tests, a fake; in production, a real fetch (below). */
export type AnthropicTransport = (req: AnthropicRequest) => Promise<AnthropicResponse>;

export interface ClaudeAdapterConfig {
  transport: AnthropicTransport;
  modelId?: string;
  version?: string;
  system?: string;
  maxTokens?: number;
}

export function makeClaudeAdapter(config: ClaudeAdapterConfig): ModelConsumerAdapter {
  const modelId = config.modelId ?? 'claude-opus-4-8';
  return {
    id: 'anthropic-claude',
    version: config.version ?? '1.0.0',
    modelId,
    async plan(input: PlanInput): Promise<ConsumerDecision> {
      // 1. Format the normalized surface into Anthropic's tool shape (near pass-through).
      const tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));

      const req: AnthropicRequest = {
        model: modelId,
        messages: anthropicMessages(input),
        tools,
        max_tokens: config.maxTokens ?? 1024,
        ...(input.system ?? config.system ? { system: input.system ?? config.system } : {}),
      };

      // 2. Invoke the model. Transport failures are the adapter's environment — never
      //    provider nonconformance.
      let res: AnthropicResponse;
      try {
        res = await config.transport(req);
      } catch (err) {
        return {
          type: 'error',
          error: { code: 'transport_error', message: err instanceof Error ? err.message : String(err) },
        };
      }

      // 3. Parse the raw response into a decision. Raw is ALWAYS preserved as evidence.
      const blocks = res.content ?? [];
      const toolUse = blocks.find((b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      if (toolUse) {
        return { type: 'tool_call', toolName: toolUse.name, arguments: toolUse.input, raw: res };
      }
      const text = blocks.find((b): b is Extract<AnthropicContentBlock, { type: 'text' }> => b.type === 'text');
      // Text without a tool call: the model selected no tool. (Distinguishing a genuine
      // clarification from a refusal would require judging narration, which Phase II never
      // does — so a text-only turn is recorded as no_action, with the raw text preserved.)
      return { type: 'no_action', reason: text ? text.text : 'model returned no tool call', raw: res };
    },
  };
}

/**
 * Build the Anthropic message list, threading trajectory history + carried state in Anthropic's
 * native tool_use / tool_result format. With no history and no carried state (a Phase II single
 * decision), this is exactly `[{ role: 'user', content: task.text }]` — unchanged.
 */
function anthropicMessages(input: PlanInput): AnthropicRequest['messages'] {
  const history = input.history ?? [];
  const messages: AnthropicRequest['messages'] = [
    { role: 'user', content: input.task.text + carriedNote(input.carried) },
  ];
  history.forEach((h, i) => {
    if (h.decision.type === 'tool_call') {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_${i}`, name: h.decision.toolName, input: h.decision.arguments }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: stepResultText(h) }] });
    } else if (h.decision.type === 'clarification') {
      messages.push({ role: 'assistant', content: h.decision.message ?? '(asked for clarification)' });
    } else if (h.decision.type === 'no_action') {
      messages.push({ role: 'assistant', content: h.decision.reason ?? '(no tool call)' });
    }
  });
  // End on a user turn so the model is prompted to act next.
  if (messages[messages.length - 1]?.role === 'assistant') messages.push({ role: 'user', content: CONTINUE_NUDGE });
  return messages;
}

/**
 * A real fetch transport to the Anthropic Messages API. Node/browser-safe (uses only
 * global fetch + optional globalThis.process). NOT used in CI — a live run needs a key:
 *   const adapter = makeClaudeAdapter({ transport: anthropicFetchTransport({ model }) })
 */
export function anthropicFetchTransport(opts: { apiKey?: string; model?: string; baseUrl?: string }): AnthropicTransport {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  const apiKey = opts.apiKey ?? g.process?.env?.['ANTHROPIC_API_KEY'];
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
  return async (req: AnthropicRequest): Promise<AnthropicResponse> => {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as AnthropicResponse;
  };
}

/** Convenience for tests/demos: a transport that always returns a canned response. */
export function staticAnthropicTransport(response: AnthropicResponse): AnthropicTransport {
  return async () => response;
}
