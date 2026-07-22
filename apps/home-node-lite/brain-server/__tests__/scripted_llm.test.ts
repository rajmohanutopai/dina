/**
 * Brain-server scripted-LLM glue: the rules-fixture loader (file + shape
 * validation) and the deterministic embedder (stable, normalised vectors).
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDeterministicEmbedder, loadScriptedRules } from '../src/scripted_llm';

function writeFixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scripted-'));
  const path = join(dir, 'rules.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('loadScriptedRules', () => {
  it('returns an empty-match fallback when no file is given', () => {
    expect(loadScriptedRules(undefined)).toEqual([{ match: '', content: '{}' }]);
  });

  it('loads a { rules: [...] } fixture', () => {
    const path = writeFixture(
      JSON.stringify({ rules: [{ match: 'route 42', content: '{"eta_minutes":7}' }] }),
    );
    try {
      expect(loadScriptedRules(path)).toEqual([{ match: 'route 42', content: '{"eta_minutes":7}' }]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('loads a bare [...] array fixture', () => {
    const path = writeFixture(JSON.stringify([{ match: '', content: 'ok' }]));
    try {
      expect(loadScriptedRules(path)).toEqual([{ match: '', content: 'ok' }]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('throws on a missing file, bad JSON, or a malformed rule', () => {
    expect(() => loadScriptedRules('/no/such/file.json')).toThrow(/cannot read/);
    const badJson = writeFixture('{not json');
    const badRule = writeFixture(JSON.stringify([{ match: 1, content: 'x' }]));
    try {
      expect(() => loadScriptedRules(badJson)).toThrow(/not valid JSON/);
      expect(() => loadScriptedRules(badRule)).toThrow(/string "match" and "content"/);
    } finally {
      rmSync(badJson, { force: true });
      rmSync(badRule, { force: true });
    }
  });
});

describe('buildDeterministicEmbedder', () => {
  it('produces a stable, unit-length vector; different texts differ', async () => {
    const embed = buildDeterministicEmbedder(768);
    const a1 = await embed('Route 42 ETA');
    const a2 = await embed('Route 42 ETA');
    const b = await embed('something else');
    expect(a1.dimensions).toBe(768);
    expect(Array.from(a1.vector)).toEqual(Array.from(a2.vector)); // deterministic
    const norm = Math.sqrt(Array.from(a1.vector).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5); // L2-normalised
    expect(Array.from(b.vector)).not.toEqual(Array.from(a1.vector));
  });
});
