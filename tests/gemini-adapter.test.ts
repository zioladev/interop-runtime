// The real Gemini adapter, tested deterministically via an injected transport (no network,
// no key). Proves schema normalization (the OpenAPI-subset clean), functionCall parsing
// (args as an OBJECT), and that plan() NEVER executes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGeminiAdapter, staticGeminiTransport, cleanSchemaForGemini } from '../src/index.ts';
import type { GeminiRequest } from '../src/index.ts';
import { orderTask, sampleProvider } from './sample-provider.ts';

const tools = sampleProvider.tools.map((t) => t.def);

test('cleanSchemaForGemini drops unsupported keywords, keeps the subset', () => {
  const cleaned = cleanSchemaForGemini(tools[0]!.inputSchema); // place_order
  assert.equal(cleaned['type'], 'object');
  assert.ok(!('additionalProperties' in cleaned), 'additionalProperties is dropped for Gemini');
  assert.deepEqual(cleaned['required'], ['item', 'size']);
  const props = cleaned['properties'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(props['size']?.['enum'], ['S', 'M', 'L']);
});

test('cleanSchemaForGemini rewrites a ["T","null"] union into type + nullable', () => {
  const cleaned = cleanSchemaForGemini({ type: ['string', 'null'], description: 'x' });
  assert.equal(cleaned['type'], 'string');
  assert.equal(cleaned['nullable'], true);
});

test('formats the surface into functionDeclarations with cleaned parameters', async () => {
  let captured: GeminiRequest | undefined;
  const adapter = makeGeminiAdapter({
    transport: async (req) => {
      captured = req;
      return { candidates: [{ content: { parts: [{ functionCall: { name: 'place_order', args: { item: 'latte', size: 'M' } } }] } }] };
    },
  });
  await adapter.plan({ task: orderTask, tools });

  assert.ok(captured);
  const decls = captured.tools[0]?.functionDeclarations;
  assert.equal(decls?.length, 2);
  assert.equal(decls?.[0]?.name, 'place_order');
  assert.ok(!('additionalProperties' in (decls?.[0]?.parameters as object)), 'declaration params are Gemini-cleaned');
  assert.equal(captured.contents[0]?.parts[0]?.text, orderTask.text);
});

test('parses a functionCall (OBJECT args) into a tool_call decision and preserves raw', async () => {
  const response = { candidates: [{ content: { parts: [{ functionCall: { name: 'place_order', args: { item: 'latte', size: 'M' } } }] } }] };
  const adapter = makeGeminiAdapter({ transport: staticGeminiTransport(response) });
  const d = await adapter.plan({ task: orderTask, tools });

  assert.equal(d.type, 'tool_call');
  if (d.type === 'tool_call') {
    assert.equal(d.toolName, 'place_order');
    assert.deepEqual(d.arguments, { item: 'latte', size: 'M' });
    assert.deepEqual(d.raw, response, 'the raw model response is preserved as evidence');
  }
});

test('a text-only turn becomes no_action, with the raw text preserved', async () => {
  const adapter = makeGeminiAdapter({ transport: staticGeminiTransport({ candidates: [{ content: { parts: [{ text: 'What size would you like?' }] } }] }) });
  const d = await adapter.plan({ task: orderTask, tools });
  assert.equal(d.type, 'no_action');
  if (d.type === 'no_action') assert.match(String(d.reason), /What size/);
});

test('a transport failure becomes a transport_error decision (never provider fault)', async () => {
  const adapter = makeGeminiAdapter({ transport: async () => { throw new Error('503 unavailable'); } });
  const d = await adapter.plan({ task: orderTask, tools });
  assert.equal(d.type, 'error');
  if (d.type === 'error') {
    assert.equal(d.error.code, 'transport_error');
    assert.match(d.error.message, /unavailable/);
  }
});
