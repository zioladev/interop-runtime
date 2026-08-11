// The FROZEN 3C acceptance fixture — shipped as a canonical, first-class artifact so every gate
// (reference, cross-model live, and the Chrome/WebMCP acceptance) drives byte-identically the same
// trajectory. Frozen a priori; never edited after observing behavior. This is the exact spec used
// by the 2026-08-10 live cross-model run (evidence bundle `order-then-pastry/3c-live`).
//
// `CROSSMODEL_PROVIDER_DEFS` are the DECLARED tool definitions each provider is expected to expose
// (names, schemas, effects) — used by any lane for static validation + effect classification. On
// the Chrome lane they describe what the real WebMCP pages must expose; the browser supplies the
// live discovery + execution.

import type { ProviderRef, ToolDef } from './types.ts';
import type { MultiProviderTrajectorySpec } from './trajectory-multi.ts';

export const CAFE_PROVIDER: ProviderRef = { id: 'cafe', origin: 'cafe.example', toolEndpoint: 'https://cafe.example/order' };
export const BAKERY_PROVIDER: ProviderRef = { id: 'bakery', origin: 'bakery.example', toolEndpoint: 'https://bakery.example/counter' };

export const CROSSMODEL_JOURNEY_SPEC: MultiProviderTrajectorySpec = {
  trajectoryId: 'order-then-pastry/3c-live',
  text:
    'You are running an errand across two shops. First, at the cafe, place an order for a medium (M) latte using place_order. ' +
    'Then, at the bakery, add a croissant to THAT SAME order using add_pastry — you must pass the exact orderId the cafe returned. ' +
    'Perform one step at a time with the tools available on the current shop.',
  providers: [CAFE_PROVIDER, BAKERY_PROVIDER],
  steps: [
    { stepId: 's1', seq: 1, provider: CAFE_PROVIDER, intent: 'place_order', allowedTools: ['lookup_drink', 'place_order'], publishes: [{ key: 'orderId', fromField: 'orderId' }], commitRequired: true },
    { stepId: 's2', seq: 2, provider: BAKERY_PROVIDER, intent: 'add_pastry', allowedTools: ['list_pastries', 'add_pastry'], requiredInputs: [{ argKey: 'orderId', fromKey: 'orderId' }], dependsOn: ['s1'], commitRequired: true },
  ],
};

export const CROSSMODEL_PROVIDER_DEFS: Record<string, ToolDef[]> = {
  cafe: [
    { name: 'lookup_drink', description: 'Resolve a drink to its item and size.', effect: 'read', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
    { name: 'place_order', description: 'Place a drink order and return its order id.', effect: 'state-changing', inputSchema: { type: 'object', properties: { item: { type: 'string' }, size: { type: 'string', enum: ['S', 'M', 'L'] } }, required: ['item', 'size'], additionalProperties: false } },
  ],
  bakery: [
    { name: 'list_pastries', description: 'List available pastries.', effect: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'add_pastry', description: 'Add a pastry to an existing cafe order (requires that order id).', effect: 'state-changing', inputSchema: { type: 'object', properties: { orderId: { type: 'string' }, pastry: { type: 'string' } }, required: ['orderId', 'pastry'], additionalProperties: false } },
  ],
};
