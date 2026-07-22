/**
 * Brain-server glue for the deterministic `scripted` LLM provider (E2E/dev).
 *
 * Loads a rules fixture from `DINA_BRAIN_SCRIPTED_LLM_FILE` (a JSON file that is
 * either `{ "rules": [...] }` or a bare `[...]`) and pairs the scripted chat
 * provider with a DETERMINISTIC embedder, so semantic search over the vault is
 * stable and offline. Everything here is gated behind
 * `DINA_BRAIN_LLM_PROVIDER=scripted` — never reached in production.
 */

import { readFileSync } from 'node:fs';

import type { EmbeddingProvider, EmbeddingResult, ScriptedRule } from '@dina/brain';

/** Parse + validate a rules fixture. Returns a single empty-match fallback when
 *  no file is given (every request answers `{}` — enough to boot). */
export function loadScriptedRules(scriptFile: string | undefined): ScriptedRule[] {
  if (scriptFile === undefined || scriptFile === '') {
    return [{ match: '', content: '{}' }];
  }
  let raw: string;
  try {
    raw = readFileSync(scriptFile, 'utf8');
  } catch (err) {
    throw new Error(
      `scripted LLM: cannot read DINA_BRAIN_SCRIPTED_LLM_FILE "${scriptFile}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `scripted LLM: "${scriptFile}" is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { rules?: unknown }).rules)
      ? (parsed as { rules: unknown[] }).rules
      : null;
  if (list === null) {
    throw new Error(`scripted LLM: "${scriptFile}" must be an array of rules or { "rules": [...] }`);
  }
  return list.map((r, i) => {
    if (r === null || typeof r !== 'object') {
      throw new Error(`scripted LLM: rule ${i} is not an object`);
    }
    const rec = r as Record<string, unknown>;
    if (typeof rec.match !== 'string' || typeof rec.content !== 'string') {
      throw new Error(`scripted LLM: rule ${i} needs string "match" and "content"`);
    }
    const rule: ScriptedRule = { match: rec.match, content: rec.content };
    if (Array.isArray(rec.toolCalls)) rule.toolCalls = rec.toolCalls as ScriptedRule['toolCalls'];
    return rule;
  });
}

/** A stable 32-bit FNV-1a hash — deterministic across runs (no Math.random). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic embedder: each dimension is seeded from a hash of the text +
 * the dimension index, then L2-normalised. Same text → same vector, so semantic
 * search is reproducible; different texts get different (stable) vectors.
 */
export function buildDeterministicEmbedder(dimensions = 768): EmbeddingProvider {
  return async (text: string): Promise<EmbeddingResult> => {
    const vector = new Float32Array(dimensions);
    let sumSq = 0;
    for (let i = 0; i < dimensions; i++) {
      // Map the hash into [-1, 1).
      const v = (fnv1a(`${text}#${i}`) / 0xffffffff) * 2 - 1;
      vector[i] = v;
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < dimensions; i++) vector[i] /= norm;
    return { vector, dimensions, model: 'scripted-deterministic', source: 'local' };
  };
}
