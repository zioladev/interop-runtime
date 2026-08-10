// The 2A ModelConsumerAdapter: a deterministic, scripted adapter.
//
// It implements the ModelConsumerAdapter contract exactly (plan() returns a decision and
// NEVER executes), with a canned decision instead of a live model call. This is what
// keeps the reference-runtime lane deterministic and hermetic (no network, no API keys),
// and is the same discipline the golden fixtures use. Real model-family adapters
// (Claude/GPT/Gemini) arrive in 2B/2C — see docs/provider-conformance/03 and 12.

import type { ConsumerDecision, ModelConsumerAdapter, PlanInput } from '../types.ts';

export interface ScriptedAdapterConfig {
  id?: string;
  version?: string;
  modelId?: string;
  /** The decision to return, or a function of the plan input. */
  decide: ConsumerDecision | ((input: PlanInput) => ConsumerDecision);
}

export function makeScriptedAdapter(config: ScriptedAdapterConfig): ModelConsumerAdapter {
  const decide = config.decide;
  return {
    id: config.id ?? 'scripted',
    version: config.version ?? '1.0.0',
    modelId: config.modelId ?? 'scripted/deterministic',
    async plan(input: PlanInput): Promise<ConsumerDecision> {
      // The invariant, enforced by construction: we only ever RETURN a decision.
      return typeof decide === 'function' ? decide(input) : decide;
    },
  };
}

export interface ScriptedTrajectoryConfig {
  id?: string;
  version?: string;
  modelId?: string;
  /**
   * The decisions to return, one per step, indexed by how many steps have already run
   * (`input.history.length`). A function form receives the plan input (including history) so
   * a fixture can branch on carried-forward state. Past the end, defaults to `no_action`.
   */
  steps: ConsumerDecision[] | ((input: PlanInput) => ConsumerDecision);
}

/**
 * A deterministic, scripted TRAJECTORY adapter (Phase III). It still honors the one hard
 * invariant — plan() only ever RETURNS a decision, never executes — but returns the next
 * step of a scripted journey based on how far the trajectory has progressed. This keeps the
 * reference-runtime trajectory lane deterministic and hermetic, exactly as the golden
 * single-decision fixtures are.
 */
export function makeScriptedTrajectoryAdapter(config: ScriptedTrajectoryConfig): ModelConsumerAdapter {
  const steps = config.steps;
  return {
    id: config.id ?? 'scripted-trajectory',
    version: config.version ?? '1.0.0',
    modelId: config.modelId ?? 'scripted/deterministic',
    async plan(input: PlanInput): Promise<ConsumerDecision> {
      if (typeof steps === 'function') return steps(input);
      const i = input.history?.length ?? 0;
      return steps[i] ?? { type: 'no_action', reason: 'scripted trajectory exhausted' };
    },
  };
}
