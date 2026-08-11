// Drift guard for the SHIPPED 3C acceptance fixture (`src/acceptance-fixture.ts`, re-exported from
// the package root). The whole point of shipping the fixture is that every gate — the deterministic
// reference tests, the cross-model *live* runner (`scripts/crossmodel-live.ts`, which drives
// `tests/sample-provider.ts :: crossModelJourneySpec`), and the Chrome/WebMCP acceptance host —
// drives BYTE-IDENTICALLY the same trajectory. This test fails the build if the shipped copy ever
// drifts from the live-gate source of truth, so the two can never silently diverge.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAFE_PROVIDER,
  BAKERY_PROVIDER,
  CROSSMODEL_JOURNEY_SPEC,
  CROSSMODEL_PROVIDER_DEFS,
} from '../src/index.ts';
import type { ToolDef } from '../src/index.ts';
import {
  CAFE_PROVIDER as CAFE_SRC,
  BAKERY_PROVIDER as BAKERY_SRC,
  crossModelJourneySpec,
  cafeProvider,
  bakeryProvider,
} from './sample-provider.ts';

test('shipped provider refs match the live-gate source of truth', () => {
  assert.deepEqual(CAFE_PROVIDER, CAFE_SRC);
  assert.deepEqual(BAKERY_PROVIDER, BAKERY_SRC);
});

test('shipped 3C journey spec is byte-identical to the live-gate spec', () => {
  // The exact trajectory the 2026-08-10 live cross-model run measured.
  assert.equal(CROSSMODEL_JOURNEY_SPEC.trajectoryId, 'order-then-pastry/3c-live');
  assert.deepEqual(CROSSMODEL_JOURNEY_SPEC, crossModelJourneySpec);
});

test('shipped provider defs match the live-gate provider surfaces', () => {
  // The shipped DEFS must describe exactly the tools the live providers expose (name, effect,
  // schema) — that is what the Chrome lane statically validates against real WebMCP pages.
  const defsOf = (p: { tools: { def: ToolDef }[] }): ToolDef[] => p.tools.map((t) => t.def);
  assert.deepEqual(CROSSMODEL_PROVIDER_DEFS.cafe, defsOf(cafeProvider));
  assert.deepEqual(CROSSMODEL_PROVIDER_DEFS.bakery, defsOf(bakeryProvider));
});
