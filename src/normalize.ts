// Provider-definition validation + surface normalization.
//
// validateDefinition enforces a small supported JSON-Schema subset (the same spirit as
// @zioladev/provider-tools) and a declared effect. A violation here is provider_definition.

import type { JsonSchema, NormalizedTool, ToolDef } from './types.ts';
import type { RuntimeTool } from './reference-runtime.ts';

const SUPPORTED_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
const SUPPORTED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'description',
  'minimum', 'maximum', 'minLength', 'maxLength', 'additionalProperties',
]);

export interface DefinitionReport {
  valid: boolean;
  violations: string[];
}

/** Static validation of one tool definition against the supported subset. */
export function validateDefinition(def: ToolDef): DefinitionReport {
  const violations: string[] = [];

  if (def.effect !== 'read' && def.effect !== 'state-changing') {
    violations.push(`tool "${def.name}" has an invalid or missing effect`);
  }
  if (!def.inputSchema || typeof def.inputSchema !== 'object') {
    violations.push(`tool "${def.name}" is missing an inputSchema`);
    return { valid: false, violations };
  }

  const walk = (schema: JsonSchema, path: string): void => {
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED_KEYWORDS.has(key)) {
        violations.push(`unsupported schema keyword "${key}" at ${path}`);
      }
    }
    const t = schema.type;
    const types = Array.isArray(t) ? t : t === undefined ? [] : [t];
    for (const tt of types) {
      if (typeof tt === 'string' && !SUPPORTED_TYPES.has(tt)) {
        violations.push(`unsupported type "${tt}" at ${path}`);
      }
    }
    if (schema.properties) {
      for (const [name, child] of Object.entries(schema.properties)) {
        walk(child, `${path}.${name}`);
      }
    }
    if (schema.items) walk(schema.items, `${path}[]`);
  };

  walk(def.inputSchema, def.name);
  return { valid: violations.length === 0, violations };
}

/** Validate a whole provider's tools; the definition step is the AND of all tools. */
export function validateProvider(tools: ToolDef[]): DefinitionReport {
  const violations: string[] = [];
  for (const def of tools) {
    const r = validateDefinition(def);
    violations.push(...r.violations);
  }
  return { valid: violations.length === 0, violations };
}

/** Turn discovered runtime tool handles into the normalized surface given to adapters. */
export function normalizeDiscovered(handles: RuntimeTool[], defs: ToolDef[]): NormalizedTool[] {
  const byName = new Map(defs.map((d) => [d.name, d]));
  return handles.map((h) => {
    const def = byName.get(h.name);
    let schema: JsonSchema;
    if (def) schema = def.inputSchema;
    else if (typeof h.inputSchema === 'string') schema = JSON.parse(h.inputSchema) as JsonSchema;
    else if (h.inputSchema && typeof h.inputSchema === 'object') schema = h.inputSchema as JsonSchema;
    else schema = { type: 'object' };
    return {
      name: h.name,
      description: h.description ?? '',
      inputSchema: schema,
      effect: def ? def.effect : 'state-changing',
    };
  });
}

/** Provider-side input validation on arguments the bridge is about to execute. */
export function validateInput(schema: JsonSchema, args: unknown): { ok: boolean; missingOrInvalidFields: string[] } {
  const missing: string[] = [];
  const obj = (args && typeof args === 'object' ? (args as Record<string, unknown>) : {});
  for (const req of schema.required ?? []) {
    if (obj[req] === undefined || obj[req] === null) missing.push(req);
  }
  // Shallow type + enum checks on declared properties.
  for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
    const val = obj[name];
    if (val === undefined) continue;
    const t = propSchema.type;
    if (typeof t === 'string' && !typeMatches(t, val)) missing.push(name);
    else if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) missing.push(name);
  }
  return { ok: missing.length === 0, missingOrInvalidFields: [...new Set(missing)] };
}

function typeMatches(type: string, val: unknown): boolean {
  switch (type) {
    case 'string': return typeof val === 'string';
    case 'number': return typeof val === 'number';
    case 'integer': return typeof val === 'number' && Number.isInteger(val);
    case 'boolean': return typeof val === 'boolean';
    case 'array': return Array.isArray(val);
    case 'object': return typeof val === 'object' && val !== null && !Array.isArray(val);
    default: return true;
  }
}
