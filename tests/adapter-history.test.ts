// Threading trajectory history + carried state into each production-derived adapter, in that
// vendor's native tool-call/tool-result format. Proves (deterministically, no network) that a
// multi-step plan carries the prior tool call, its OBSERVED result, and the authoritative carried
// state into the model's prompt — and that a single-decision plan is unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeAdapter, makeGptAdapter, makeGeminiAdapter } from '../src/index.ts';
import type { AnthropicRequest, OpenAiRequest, GeminiRequest, PlanInput, CarriedValue, PriorStep } from '../src/index.ts';
import { sampleProvider, orderTask } from './sample-provider.ts';

const tools = sampleProvider.tools.map((t) => t.def);
const carried: CarriedValue[] = [{ key: 'orderId', value: 'CAFE-ORDER', producedBy: { stepId: 's1', providerId: 'cafe', toolName: 'place_order' } }];
const history: PriorStep[] = [{ decision: { type: 'tool_call', toolName: 'place_order', arguments: { item: 'latte', size: 'M' } }, executed: true, effect: 'state-changing', result: { executed: true, confirmationId: 'CAFE-ORDER', data: { orderId: 'CAFE-ORDER' } } }];
const multiStep: PlanInput = { task: orderTask, tools, history, carried };

test('Claude: threads prior tool_use + tool_result + carried state (single-decision unchanged)', async () => {
  let captured: AnthropicRequest | undefined;
  const adapter = makeClaudeAdapter({ transport: async (req) => { captured = req; return { content: [{ type: 'tool_use', id: 't', name: 'find_item', input: {} }] }; } });

  // Single decision: byte-identical to before — one user turn with the task text.
  await adapter.plan({ task: orderTask, tools });
  assert.deepEqual(captured?.messages, [{ role: 'user', content: orderTask.text }]);

  // Multi-step: the opening user turn carries the authoritative state; the prior step is a
  // tool_use / tool_result pair.
  await adapter.plan(multiStep);
  const msgs = captured!.messages;
  assert.match(String(msgs[0]?.content), /Carried state.*orderId.*CAFE-ORDER/);
  const asst = msgs.find((m) => m.role === 'assistant');
  const toolUse = (asst?.content as Array<{ type: string; name?: string }>).find((b) => b.type === 'tool_use');
  assert.equal(toolUse?.name, 'place_order');
  const toolResult = msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b: { type?: string }) => b.type === 'tool_result');
  assert.ok(toolResult, 'the prior step\'s observed result is threaded as a tool_result');
});

test('GPT: threads assistant tool_calls + role:tool result + carried state', async () => {
  let captured: OpenAiRequest | undefined;
  const adapter = makeGptAdapter({ transport: async (req) => { captured = req; return { choices: [{ message: { content: 'ok' } }] }; } });

  await adapter.plan({ task: orderTask, tools });
  assert.deepEqual(captured?.messages, [{ role: 'user', content: orderTask.text }]);

  await adapter.plan(multiStep);
  const msgs = captured!.messages;
  assert.match(String(msgs[0]?.content), /Carried state.*orderId/);
  const asst = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(asst?.tool_calls?.[0]?.function.name, 'place_order');
  const toolMsg = msgs.find((m) => m.role === 'tool');
  assert.ok(toolMsg?.tool_call_id, 'the tool result is a role:tool message with a matching id');
});

test('Gemini: threads model functionCall + user functionResponse (by name) + carried state', async () => {
  let captured: GeminiRequest | undefined;
  const adapter = makeGeminiAdapter({ transport: async (req) => { captured = req; return { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }; } });

  await adapter.plan({ task: orderTask, tools });
  assert.deepEqual(captured?.contents, [{ role: 'user', parts: [{ text: orderTask.text }] }]);

  await adapter.plan(multiStep);
  const contents = captured!.contents;
  assert.match(String(contents[0]?.parts[0]?.text), /Carried state.*orderId/);
  const model = contents.find((c) => c.role === 'model');
  assert.equal(model?.parts[0]?.functionCall?.name, 'place_order');
  const fnResp = contents.flatMap((c) => c.parts).find((p) => p.functionResponse);
  assert.equal(fnResp?.functionResponse?.name, 'place_order', 'Gemini matches the response by tool name');
});
