// The OPTIONAL execution-control seam (Phase V, 5B).
//
// interop-runtime can consult an external, OPAQUE execution-control authority before a CONSEQUENTIAL
// (state-changing) execution reaches a provider. The port is STRUCTURALLY COMPATIBLE with
// @zioladev/execution-control but is re-declared here so this package takes NO dependency on it — the
// same independence kept elsewhere. interop-runtime builds the candidate from what it already holds and
// forwards it UNCHANGED; it never derives or interprets the disposition, and it never reads the args.
//
// Modes:
//   off      — existing Phase III behavior; no evaluation, no execution-control claim is made.
//   required — every state-changing execution must receive `allow` before the common bridge may call
//              the provider tool. `allow` proceeds; `block` / `indeterminate` / missing-provider /
//              throw / timeout all mean the provider is NOT called (fail closed). Non-state-changing
//              tools bypass the seam entirely.
//
// A block is NOT a provider failure (the provider was never called) — the engine records it as a
// distinct boundary observation and never relabels a provider/model/orchestration fault. Whether the
// trajectory ultimately attains its objective is left to the existing terminal semantics.

export type ExecutionControlDisposition = 'allow' | 'block' | 'indeterminate';

/** A neutral description of a state-changing execution, forwarded UNCHANGED to the authority. */
export interface ExecutionCandidate {
  provider: string;
  tool: string;
  arguments: unknown;
  effect: 'state-changing';
}

/** Structurally compatible with @zioladev/execution-control's ExecutionControlProvider (not imported). */
export interface ExecutionControlProvider {
  evaluate(candidate: ExecutionCandidate): Promise<ExecutionControlDisposition>;
}

export type ExecutionControlMode = 'off' | 'required';

export interface ExecutionControlConfig {
  mode: ExecutionControlMode;
  provider?: ExecutionControlProvider;
  /** Optional evaluation timeout (ms). A timeout fails closed — the provider is not called. */
  timeoutMs?: number;
}

/** The execution-control observation recorded on a step — kept distinct from the provider ExecutionResult. */
export interface ExecutionControlObservation {
  /** Did an evaluation actually run (required mode + state-changing + a provider present)? */
  evaluated: boolean;
  /** The disposition returned, when one was. Absent on missing-provider / throw / timeout. */
  disposition?: ExecutionControlDisposition;
  /** True when the seam stopped the step before the provider (any non-`allow` / unavailable outcome). */
  stopped: boolean;
  /** Whether the provider was actually reached (false whenever the seam stopped the step). */
  providerReached: boolean;
  /** The authority was missing, threw, or timed out — an availability signal, never a disposition. */
  unavailable?: boolean;
}

const timeoutAfter = (ms: number): Promise<never> =>
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error('execution-control evaluation timed out')), ms));

/**
 * Run the execution-control gate for a state-changing candidate in `required` mode. Returns the gate
 * result (whether it stopped the step + what to record). NEVER throws — a missing / throwing / timed-out
 * authority fails closed. Callers invoke this ONLY for state-changing decisions in required mode; reads
 * and `off` mode bypass it entirely (so the authority's evaluate is never called for them).
 */
export async function gateStateChanging(
  config: ExecutionControlConfig,
  candidate: ExecutionCandidate,
): Promise<{ evaluated: boolean; disposition?: ExecutionControlDisposition; stopped: boolean; unavailable?: boolean }> {
  if (!config.provider) {
    // required, but no authority configured → fail closed. Distinct from `off` (which never gets here).
    return { evaluated: false, stopped: true, unavailable: true };
  }
  let disposition: ExecutionControlDisposition;
  try {
    const pending = config.provider.evaluate(candidate);
    disposition = config.timeoutMs && config.timeoutMs > 0 ? await Promise.race([pending, timeoutAfter(config.timeoutMs)]) : await pending;
  } catch {
    // Threw or timed out → fail closed; record availability, not a disposition.
    return { evaluated: true, stopped: true, unavailable: true };
  }
  if (disposition === 'allow') return { evaluated: true, disposition, stopped: false };
  return { evaluated: true, disposition, stopped: true }; // block | indeterminate
}
