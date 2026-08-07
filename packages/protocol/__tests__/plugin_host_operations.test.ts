/**
 * host_operations (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md §3.4):
 * the per-capability extension-operation allowlist. Bounded + shaped
 * at validation, deduped + sorted at normalization, and consent-
 * relevant in the scope hash — widening forces re-consent, while
 * absent/empty lists keep every pre-commerce hash unchanged.
 */

import { createHash } from 'node:crypto';

import { computePluginDigests } from '../src/plugins/digests';
import { normalizePluginManifest } from '../src/plugins/normalize';
import { validatePluginManifest } from '../src/plugins/validate';

import type { PluginManifest } from '../src/plugins/types';

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

function manifest(hostOperations?: string[]): PluginManifest {
  return {
    $type: 'com.dinakernel.plugin.release',
    plugin_id: 'com.example.commerce.supplier',
    version: '0.1.0',
    display_name: 'Supplier',
    execution: { mode: 'runner' },
    capabilities: [
      {
        id: 'com.example.commerce.request_quote',
        display_name: 'Request quote',
        interaction: 'query',
        action_class: 'quote',
        privacy_class: 'personal',
        kinds: ['provider'],
        ...(hostOperations !== undefined ? { host_operations: hostOperations } : {}),
      },
    ],
  } as unknown as PluginManifest;
}

function errorsOf(result: ReturnType<typeof validatePluginManifest>) {
  return result.ok ? [] : [...result.errors];
}

describe('host_operations validation', () => {
  it('accepts a bounded, shaped list', () => {
    const result = validatePluginManifest(
      manifest(['commerce.appview_search', 'commerce.d2d_send']),
    );
    expect(errorsOf(result).filter((e) => e.path.includes('host_operations'))).toEqual([]);
  });

  it('rejects more than the cap', () => {
    const ops = Array.from({ length: 17 }, (_, i) => `op.${i}`);
    const result = validatePluginManifest(manifest(ops));
    expect(errorsOf(result).some((e) => e.code === 'too_many_host_operations')).toBe(true);
  });

  it('rejects malformed operation names', () => {
    for (const bad of ['', 'UPPER.case', 'has space', 'x'.repeat(129)]) {
      const result = validatePluginManifest(manifest([bad]));
      expect(errorsOf(result).some((e) => e.code === 'bad_host_operation')).toBe(true);
    }
  });
});

describe('host_operations normalization', () => {
  it('dedupes and sorts (stored form is canonical)', () => {
    const normalized = normalizePluginManifest(manifest(['b.op', 'a.op', 'b.op']));
    expect(normalized.capabilities[0]?.host_operations).toEqual(['a.op', 'b.op']);
  });

  it('an unsorted or duplicate-bearing list fails validation as not_normalized', () => {
    const result = validatePluginManifest(manifest(['b.op', 'a.op']));
    expect(errorsOf(result).some((e) => e.code === 'not_normalized')).toBe(true);
    const dupes = validatePluginManifest(manifest(['a.op', 'a.op']));
    expect(errorsOf(dupes).some((e) => e.code === 'not_normalized')).toBe(true);
  });

  it('interpreted-mode capabilities may not declare host_operations', () => {
    const interpreted = {
      ...manifest(['a.op']),
      execution: { mode: 'interpreted' },
    } as unknown as PluginManifest;
    const result = validatePluginManifest(interpreted);
    expect(errorsOf(result).some((e) => e.code === 'runner_fields_on_interpreted')).toBe(true);
  });
});

describe('host_operations scope hash (§3.4 re-consent)', () => {
  it('absent and empty lists produce the SAME hash (no brokered authority either way)', () => {
    const absent = computePluginDigests(normalizePluginManifest(manifest()), sha256);
    const empty = computePluginDigests(normalizePluginManifest(manifest([])), sha256);
    expect(empty.installScopeHash).toBe(absent.installScopeHash);
  });

  it('declaring an operation changes the scope hash — widening forces re-consent', () => {
    const absent = computePluginDigests(normalizePluginManifest(manifest()), sha256);
    const one = computePluginDigests(
      normalizePluginManifest(manifest(['commerce.appview_search'])),
      sha256,
    );
    const two = computePluginDigests(
      normalizePluginManifest(manifest(['commerce.appview_search', 'commerce.d2d_send'])),
      sha256,
    );
    expect(one.installScopeHash).not.toBe(absent.installScopeHash);
    expect(two.installScopeHash).not.toBe(one.installScopeHash);
  });
});
