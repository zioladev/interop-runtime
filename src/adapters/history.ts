// Shared helpers for threading AUTHORITATIVE trajectory history + carried state into each
// production-derived adapter's prompt, in that vendor's tool-call/tool-result format. Used only
// for multi-step (Phase III) plans; a single-decision (Phase II) plan has empty history + carried
// and these produce nothing, so the request is byte-identical to before.
//
// The carried state is presented as CONTEXT the model may reason over; it is never authoritative
// by virtue of the model reading it (D36). Prior tool results are the OBSERVED evidence (D38).

import type { CarriedValue, PriorStep } from '../types.ts';

/** A short line the model is nudged with when the conversation would otherwise end on its turn. */
export const CONTINUE_NUDGE =
  'Continue the errand: perform the next required step now, using the carried state above where needed.';

/** Render the carried state as an authoritative note appended to the opening user message. */
export function carriedNote(carried: CarriedValue[] | undefined): string {
  if (!carried || carried.length === 0) return '';
  const items = carried
    .map((c) => `${c.key} = ${JSON.stringify(c.value)} (produced by ${c.producedBy.providerId}/${c.producedBy.toolName})`)
    .join('; ');
  return `\n\nCarried state (authoritative, from prior executions — use these exact values): ${items}.`;
}

/** The observed result text for a prior step's tool_result / functionResponse turn. */
export function stepResultText(h: PriorStep): string {
  return JSON.stringify(h.result ?? { executed: h.executed });
}
