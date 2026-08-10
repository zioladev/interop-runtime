// The 3C LIVE acceptance gate — real Claude + GPT + Gemini over ONE frozen multi-provider
// trajectory, run entirely from the cloud (GitHub Actions / workflow_dispatch), no local machine.
//
// Runs whichever model families have an API key present, each traversing the SAME frozen spec
// (tests/sample-provider.ts :: crossModelJourneySpec) with authoritative carried state and the
// one common execution bridge. It preserves EACH MODEL'S RAW RESPONSE AT EVERY STEP (not just the
// final), renders the cross-model artifact, and writes a self-contained evidence bundle for upload.
//
// The fixture/rubric is committed BEFORE this runs and is NEVER edited after observing behavior.
//   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... \
//     node --experimental-strip-types scripts/crossmodel-live.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  makeClaudeAdapter,
  makeGptAdapter,
  makeGeminiAdapter,
  anthropicFetchTransport,
  openaiFetchTransport,
  geminiFetchTransport,
  runCrossModelTrajectory,
  compareCrossModelTrajectory,
  renderCrossModelArtifact,
  REFERENCE_RUNTIME_ID,
  REPORT_GENERATOR_VERSION,
  TRAJECTORY_REPORT_VERSION,
} from '../src/index.ts';
import type { ModelConsumerAdapter } from '../src/index.ts';
import { crossModelProviders, crossModelJourneySpec } from '../tests/sample-provider.ts';

const g = globalThis as unknown as { process: { env: Record<string, string | undefined>; exit(code: number): never } };
const env = g.process.env;

const live: ModelConsumerAdapter[] = [];
if (env['ANTHROPIC_API_KEY']) {
  const model = env['ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001';
  live.push(makeClaudeAdapter({ modelId: model, transport: anthropicFetchTransport({ model }) }));
}
if (env['OPENAI_API_KEY']) {
  const model = env['OPENAI_MODEL'] ?? 'gpt-4o-mini';
  live.push(makeGptAdapter({ modelId: model, transport: openaiFetchTransport({ model }) }));
}
if (env['GEMINI_API_KEY'] || env['GOOGLE_API_KEY']) {
  const model = env['GEMINI_MODEL'] ?? 'gemini-2.5-pro';
  live.push(makeGeminiAdapter({ modelId: model, transport: geminiFetchTransport({ model }) }));
}

if (live.length === 0) {
  console.error('No model API keys set (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) — skipping the live 3C run.');
  console.error('The deterministic 3C tests still prove the comparison + adapter parsing. Add a secret and re-run.');
  g.process.exit(0);
}

console.log(`3C live cross-model trajectory: ${live.map((a) => `${a.id} (${a.modelId})`).join(', ')}`);
console.log(`Frozen spec: ${crossModelJourneySpec.trajectoryId} · runtime: ${REFERENCE_RUNTIME_ID}\n`);

const results = await runCrossModelTrajectory(crossModelProviders, crossModelJourneySpec, live);
const comparison = compareCrossModelTrajectory(crossModelJourneySpec.trajectoryId, results);
const artifact = renderCrossModelArtifact(results, comparison);
console.log(artifact);

// Per-model, PER-STEP raw responses — the preserved evidence (D38): what each model actually
// returned at every step, not just its final turn.
for (const r of results) {
  console.log(`\n--- raw ${r.adapterId} (${r.modelId}) per-step responses (verbatim) ---`);
  r.observation.records.forEach((rec, i) => {
    console.log(`  step ${i} [${rec.step.provider.id}/${rec.step.intent}] decision=${rec.decision.type}${rec.firedTool ? ` fired=${rec.firedTool}` : ''}`);
    console.log('  raw: ' + JSON.stringify((rec.decision as { raw?: unknown }).raw ?? null));
  });
}

// Machine-readable evidence: every model, every step, raw + provenance + derived judgment.
const evidence = {
  reportVersion: TRAJECTORY_REPORT_VERSION,
  reportGeneratorVersion: REPORT_GENERATOR_VERSION,
  runtimeId: REFERENCE_RUNTIME_ID,
  trajectoryId: crossModelJourneySpec.trajectoryId,
  comparison,
  models: results.map((r) => ({
    adapterId: r.adapterId,
    adapterVersion: r.adapterVersion,
    modelId: r.modelId,
    derived: {
      terminalAttained: r.derived.terminalAttained,
      trajectoryConformance: r.derived.trajectoryConformance,
      providerGrade: r.derived.providerGrade,
      routeKey: r.derived.routeKey,
      attribution: r.derived.attribution,
      invariantResults: r.derived.invariantResults,
    },
    carried: r.observation.carried,
    steps: r.observation.records.map((rec, i) => ({
      index: i,
      stepId: rec.step.stepId,
      providerId: rec.step.provider.id,
      intent: rec.step.intent,
      transition: rec.transition,
      decision: { type: rec.decision.type, ...(rec.decision.type === 'tool_call' ? { toolName: rec.decision.toolName, arguments: rec.decision.arguments } : {}) },
      executed: rec.executed,
      firedTool: rec.firedTool ?? null,
      firedEffect: rec.firedEffect ?? null,
      published: rec.published,
      outcome: rec.derived.outcome,
      firstOwner: rec.derived.attribution[0]?.category ?? 'none',
      raw: (rec.decision as { raw?: unknown }).raw ?? null, // EVERY step's raw model response
    })),
  })),
};

const bundleDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'crossmodel-bundle');
mkdirSync(bundleDir, { recursive: true });
writeFileSync(join(bundleDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
writeFileSync(join(bundleDir, 'artifact.txt'), artifact + '\n');
writeFileSync(join(bundleDir, 'fixture.json'), JSON.stringify({
  trajectorySpec: crossModelJourneySpec,
  providers: Object.fromEntries(Object.entries(crossModelProviders).map(([id, p]) => [id, { name: p.name, tools: p.tools.map((t) => t.def) }])),
}, null, 2) + '\n');
writeFileSync(join(bundleDir, 'NOTES.md'), [
  '# 3C cross-model live evidence',
  '',
  `Models: ${live.map((a) => `${a.id} (${a.modelId})`).join(', ')}`,
  `Frozen trajectory: ${crossModelJourneySpec.trajectoryId}`,
  `Runtime: ${REFERENCE_RUNTIME_ID} — the REFERENCE lane, NOT real Chrome/WebMCP.`,
  '',
  'Each model traversed the SAME frozen multi-provider spec (fixture.json — committed before this',
  'run, never edited after observing behavior), with authoritative carried state and one common',
  'execution bridge. evidence.json preserves EVERY step\'s raw model response, the carried state with',
  'provenance, and the per-layer attribution. Path differences are recorded, never treated as failure;',
  'the provider grade is computed from provider-owned layers only. No claims beyond what is recorded.',
  '',
].join('\n'));
console.log(`\nWrote 3C evidence bundle to ${bundleDir}: evidence.json, artifact.txt, fixture.json, NOTES.md`);
