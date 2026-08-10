// An anonymized sample WebMCP provider surface used as a conformance test target.
// Authorization-free (no governance of its own) — exactly the kind of surface Phase II
// exercises. Two tools: one state-changing, one read.

import type { ProviderUnderTest, TaskSpec, ExecutionResult } from '../src/index.ts';
import type { TrajectorySpec, MultiProviderTrajectorySpec, ProviderRef } from '../src/index.ts';

let counter = 1500;

export const sampleProvider: ProviderUnderTest = {
  name: '@example/sample-cafe',
  tools: [
    {
      def: {
        name: 'place_order',
        description: 'Place a drink order.',
        effect: 'state-changing',
        inputSchema: {
          type: 'object',
          properties: {
            item: { type: 'string', description: 'Drink name' },
            size: { type: 'string', enum: ['S', 'M', 'L'] },
          },
          required: ['item', 'size'],
          additionalProperties: false,
        },
      },
      handler: (args): ExecutionResult => {
        const a = args as { item?: string; size?: string };
        return { executed: true, confirmationId: `ORDER-${counter++}`, data: { item: a.item, size: a.size } };
      },
    },
    {
      def: {
        name: 'find_item',
        description: 'Look up a menu item.',
        effect: 'read',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
      handler: (args): ExecutionResult => {
        const a = args as { query?: string };
        return { executed: true, data: { found: true, query: a.query } };
      },
    },
  ],
};

export const orderTask: TaskSpec = {
  taskId: 'order-latte-M/1',
  text: 'Order a medium latte.',
  allowableOutcomes: ['executed:place_order'],
};

// An intentionally UNDERSPECIFIED task, to invite legitimate cross-consumer variation.
// The allowable set is FROZEN here, a priori — before any model (Claude/GPT/Gemini) is run
// against it. Whatever a model actually does is observation, never ground truth.
//
// The rubric, tied to what THIS provider surface exposes:
//   place_order requires `size` (enum S/M/L) and declares NO default. So:
//   LEGITIMATE  -> clarification (ask for size) or no action (info genuinely unavailable),
//                  both recorded as outcome `no_tool_selected` (text with no tool call) or
//                  `clarification`.
//   INVALID     -> executing with a self-chosen size (fabrication — no default exists),
//                  malformed arguments, the wrong tool, or anything the schema rejects.
//
// Because no default is declared, `executed:place_order(...)` is NOT allowable — it is
// fabrication, and the task-conformance check charges it to the model (never the provider).
export const coffeeAmbiguousTask: TaskSpec = {
  taskId: 'order-coffee-underspecified/1',
  text: 'Order a coffee.',
  allowableOutcomes: ['clarification', 'no_tool_selected'],
};

// --- Phase III (trajectory) fixture surface ---------------------------------------------
//
// A journey surface: `lookup_drink` (read) resolves a drink to its concrete item + size;
// `place_order` (state-changing) commits. The journey "order a medium latte" is meant to be
// driven as inspect -> commit, carrying the looked-up values forward. Kept SEPARATE from the
// Phase II sampleProvider so no frozen single-decision evidence is perturbed.

let journeyCounter = 2500;

export interface JourneyProviderOpts {
  /** If true, place_order executes but returns evidence that violates the ExecutionResult
   *  contract (executed:true with no confirmationId) — the T5 provider-owned fault. */
  faultyEvidence?: boolean;
}

export function makeJourneyProvider(opts: JourneyProviderOpts = {}): ProviderUnderTest {
  return {
    name: '@example/sample-cafe-journey',
    tools: [
      {
        def: {
          name: 'lookup_drink',
          description: 'Resolve a drink name to its concrete menu item and size.',
          effect: 'read',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
        // A latte lookup resolves to item "latte", size "M". This is the state the journey
        // must carry forward into the commit.
        handler: (args): ExecutionResult => {
          const a = args as { query?: string };
          return { executed: true, data: { found: true, query: a.query, item: 'latte', size: 'M' } };
        },
      },
      {
        def: {
          name: 'place_order',
          description: 'Place a drink order.',
          effect: 'state-changing',
          inputSchema: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'Drink name' },
              size: { type: 'string', enum: ['S', 'M', 'L'] },
            },
            required: ['item', 'size'],
            additionalProperties: false,
          },
        },
        handler: (args): ExecutionResult => {
          const a = args as { item?: string; size?: string };
          if (opts.faultyEvidence) {
            // Provider executed the state change but omitted the confirmationId (contract break).
            return { executed: true, data: { item: a.item, size: a.size } };
          }
          return { executed: true, confirmationId: `ORDER-${journeyCounter++}`, data: { item: a.item, size: a.size } };
        },
      },
    ],
  };
}

export const journeyProvider: ProviderUnderTest = makeJourneyProvider();

// --- Phase III / 3B (multi-provider) fixture surfaces -----------------------------------
//
// Two independent providers so trajectory STATE genuinely crosses an origin: the cafe places
// an order and produces an `orderId`; the bakery adds a pastry to THAT order and therefore
// REQUIRES the cafe's orderId carried forward — the thing production never truly had.

export function makeCafeProvider(opts: JourneyProviderOpts = {}): ProviderUnderTest {
  return {
    name: '@example/cafe',
    tools: [
      {
        def: {
          name: 'lookup_drink',
          description: 'Resolve a drink to its item and size.',
          effect: 'read',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        },
        handler: (args): ExecutionResult => {
          const a = args as { query?: string };
          return { executed: true, data: { found: true, query: a.query, item: 'latte', size: 'M' } };
        },
      },
      {
        def: {
          name: 'place_order',
          description: 'Place a drink order and return its order id.',
          effect: 'state-changing',
          inputSchema: {
            type: 'object',
            properties: { item: { type: 'string' }, size: { type: 'string', enum: ['S', 'M', 'L'] } },
            required: ['item', 'size'],
            additionalProperties: false,
          },
          // The cafe's order id — the value the bakery step must carry forward.
        },
        handler: (args): ExecutionResult => {
          const a = args as { item?: string; size?: string };
          if (opts.faultyEvidence) return { executed: true, data: { orderId: 'CAFE-ORDER', item: a.item, size: a.size } };
          return { executed: true, confirmationId: 'CAFE-ORDER', data: { orderId: 'CAFE-ORDER', item: a.item, size: a.size } };
        },
      },
    ],
  };
}

export const bakeryProvider: ProviderUnderTest = {
  name: '@example/bakery',
  tools: [
    {
      def: {
        name: 'list_pastries',
        description: 'List available pastries.',
        effect: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      handler: (): ExecutionResult => ({ executed: true, data: { pastries: ['croissant', 'scone'] } }),
    },
    {
      def: {
        name: 'add_pastry',
        description: 'Add a pastry to an existing cafe order (requires that order id).',
        effect: 'state-changing',
        inputSchema: {
          type: 'object',
          properties: { orderId: { type: 'string' }, pastry: { type: 'string' } },
          required: ['orderId', 'pastry'],
          additionalProperties: false,
        },
      },
      handler: (args): ExecutionResult => {
        const a = args as { orderId?: string; pastry?: string };
        return { executed: true, confirmationId: `BAKE-${a.orderId ?? '?'}`, data: { orderId: a.orderId, pastry: a.pastry } };
      },
    },
  ],
};

export const cafeProvider: ProviderUnderTest = makeCafeProvider();

// --- The FROZEN 3C cross-model fixture (committed before any live run; never edited after
// --- observing model behavior). Shared by the deterministic tests and the live acceptance runner.
export const CAFE_PROVIDER: ProviderRef = { id: 'cafe', origin: 'cafe.example', toolEndpoint: 'https://cafe.example/order' };
export const BAKERY_PROVIDER: ProviderRef = { id: 'bakery', origin: 'bakery.example', toolEndpoint: 'https://bakery.example/counter' };

export const crossModelProviders: Record<string, ProviderUnderTest> = { cafe: cafeProvider, bakery: bakeryProvider };

export const crossModelJourneySpec: MultiProviderTrajectorySpec = {
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

// The FROZEN trajectory rubric (D28): constrain what must be TRUE, not the route. Multiple
// valid routes may reach the same terminal state; only invariant/terminal violations fail.
export const coffeeJourney: TrajectorySpec = {
  trajectoryId: 'order-a-medium-latte/1',
  text: 'Order a medium latte: look up the drink, then place the order.',
  allowedStepTypes: ['lookup_drink', 'place_order'],
  requiredTerminalStates: [{ kind: 'committed', tool: 'place_order' }],
  forbiddenTerminalStates: [{ kind: 'no_commit' }],
  invariants: [
    { kind: 'inspect_before_commit', inspectTool: 'lookup_drink', commitTool: 'place_order' },
    { kind: 'no_commit_before_fields', commitTool: 'place_order', requiredFields: ['item', 'size'] },
    { kind: 'commit_uses_prior_output', commitTool: 'place_order', argKey: 'item', fromField: 'item' },
    { kind: 'exactly_one_commit', commitTool: 'place_order' },
  ],
  maxSteps: 6,
};
