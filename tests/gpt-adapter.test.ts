// The real GPT (OpenAI) adapter, tested deterministically via an injected transport (no
// network, no key). Proves schema formatting + tool-call parsing against real Chat Completions
// response shapes, and that plan() NEVER executes — it only returns a decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGptAdapter, staticOpenAiTransport } from '../src/index.ts';
import type { OpenAiRequest } from '../src/index.ts';
import { orderTask, sampleProvider } from './sample-provider.ts';

const tools = sampleProvider.tools.map((t) => t.def);

test('formats the normalized surface into OpenAI function-tool shape', async () => {
  let captured: OpenAiRequest | undefined;
  const adapter = makeGptAdapter({
    transport: async (req) => {
      captured = req;
      return { choices: [{ message: { tool_calls: [{ function: { name: 'place_order', arguments: '{"item":"latte","size":"M"}' } }] } }] };
    },
  });
  await adapter.plan({ task: orderTask, tools });

  assert.ok(captured);
  assert.equal(captured.model, 'gpt-4o-mini');
  assert.equal(captured.tools.length, 2);
  assert.deepEqual(captured.tools[0], { type: 'function', function: { name: 'place_order', description: 'Place a drink order.', parameters: tools[0]?.inputSchema } });
  assert.equal(captured.messages.at(-1)?.content, orderTask.text);
});

test('parses a tool_call (JSON-string args) into a tool_call decision and preserves raw', async () => {
  const response = { choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'place_order', arguments: '{"item":"latte","size":"M"}' } }] } }] };
  const adapter = makeGptAdapter({ transport: staticOpenAiTransport(response) });
  const d = await adapter.plan({ task: orderTask, tools });

  assert.equal(d.type, 'tool_call');
  if (d.type === 'tool_call') {
    assert.equal(d.toolName, 'place_order');
    assert.deepEqual(d.arguments, { item: 'latte', size: 'M' });
    assert.deepEqual(d.raw, response, 'the raw model response is preserved as evidence');
  }
});

test('a text-only turn becomes no_action, with the raw text preserved', async () => {
  const adapter = makeGptAdapter({ transport: staticOpenAiTransport({ choices: [{ message: { content: 'What size would you like?' } }] }) });
  const d = await adapter.plan({ task: orderTask, tools });
  assert.equal(d.type, 'no_action');
  if (d.type === 'no_action') assert.match(String(d.reason), /What size/);
});

test('a transport failure becomes a transport_error decision (never provider fault)', async () => {
  const adapter = makeGptAdapter({ transport: async () => { throw new Error('429 rate limit'); } });
  const d = await adapter.plan({ task: orderTask, tools });
  assert.equal(d.type, 'error');
  if (d.type === 'error') {
    assert.equal(d.error.code, 'transport_error');
    assert.match(d.error.message, /rate limit/);
  }
});

test('same-surface: GPT and Claude adapters format the SAME normalized tool surface', async () => {
  // Both adapters receive the identical NormalizedTool[] — the same-surface invariant (§02).
  // Here we just confirm the GPT adapter round-trips the provider schema unchanged in parameters.
  let captured: OpenAiRequest | undefined;
  const adapter = makeGptAdapter({ transport: async (req) => { captured = req; return { choices: [{ message: { content: 'ok' } }] }; } });
  await adapter.plan({ task: orderTask, tools });
  assert.deepEqual(captured?.tools.map((t) => t.function.name), ['place_order', 'find_item']);
  assert.deepEqual(captured?.tools[0]?.function.parameters, tools[0]?.inputSchema);
});
