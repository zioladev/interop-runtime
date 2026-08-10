// Clean-room guard (§10, D16): the package must import NOTHING from @selvage/* or the
// Refraktor extension, and must stand alone. If this fails, the boundary has eroded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('no source file imports from @selvage or the Refraktor extension', () => {
  // Flag @selvage / refraktor only when it appears in an import/require/export SPECIFIER
  // (an actual dependency), never a mention in a comment explaining the boundary itself.
  const importSpecifier = /(?:\b(?:import|export)\b[^'"\n]*?\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(importSpecifier)) {
      const spec = m[1] ?? '';
      if (spec.includes('@selvage') || /refraktor/i.test(spec)) {
        offenders.push(`${file} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `clean-room violation (forbidden import specifier): ${offenders.join(', ')}`);
});

test('package.json declares no @selvage dependency', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  for (const name of Object.keys(all)) {
    assert.ok(!name.startsWith('@selvage'), `found forbidden dependency: ${name}`);
  }
});
