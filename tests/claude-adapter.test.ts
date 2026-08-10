// The real Claude adapter, tested deterministically via an injected transport (no network,
// no API key). Proves the adapter's schema formatting + tool-call parsing against real
// Anthropic response shapes, and that plan() NEVER executes — it only returns a decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeAdapter, staticAnthropicTransport } from '../src/index.ts';
import type { AnthropicRequest } from '../src/index.ts';
import { orderTask, sampleProvider } from './sample-provider.ts';

const tools = sampleProvider.tools.map((t) => t.def);

test('formats the normalized surface into Anthropic tool shape', async () => {
  let captured: AnthropicRequest | undefined;
  const adapter = makeClaudeAdapter({
    transport: async (req) => {
      captured = req;
      return { content: [{ type: 'tool_use', id: 'tu_1', name: 'place_order', input: { item: 'latte', size: 'M' } }] };
    },
  });
  await adapter.plan({ task: orderTask, tools });

  assert.ok(captured);
  assert.equal(captured.model, 'claude-opus-4-8');
  assert.equal(captured.tools.length, 2);
  assert.deepEqual(captured.tools[0], { name: 'place_order', description: 'Place a drink order.', input_schema: tools[0]?.inputSchema });
  assert.equal(captured.messages[0]?.content, orderTask.text);
});

test('parses a tool_use block into a tool_call decision and preserves raw', async () => {
  const response = { content: [{ type: 'text', text: 'Sure!' }, { type: 'tool_use', id: 'tu_9', name: 'place_order', input: { item: 'latte', size: 'M' } }], stop_reason: 'tool_use' } as const;
  const adapter = makeClaudeAdapter({ transport: staticAnthropicTransport(response) });
  const d = await adapter.plan({ task: orderTask, tools });

  assert.equal(d.type, 'tool_call');
  if (d.type === 'tool_call') {
    assert.equal(d.toolName, 'place_order');
    assert.deepEqual(d.arguments, { item: 'latte', size: 'M' });
    assert.deepEqual(d.raw, response, 'the raw model response is preserved as evidence');
  }
});

test('a text-only turn becomes no_action, with the raw text preserved', async () => {
  const adapter = makeClaudeAdapter({ transport: staticAnthropicTransport({ content: [{ type: 'text', text: 'Which size?' }], stop_reason: 'end_turn' }) });
  const d = await adapter.plan({ task: orderTask, tools });
  assert.equal(d.type, 'no_action');
  if (d.type === 'no_action') assert.match(String(d.reason), /Which size/);
});

test('a transport failure becomes a transport_error decision (never provider fault)', async () => {
  const adapter = makeClaudeAdapter({
    transport: async () => { throw new Error('429 overloaded'); },
  });
  const d = await adapter.plan({ task: orderTask, tools });
  assert.equal(d.type, 'error');
  if (d.type === 'error') {
    assert.equal(d.error.code, 'transport_error');
    assert.match(d.error.message, /overloaded/);
  }
});
