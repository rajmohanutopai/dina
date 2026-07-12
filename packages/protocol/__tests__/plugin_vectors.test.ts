/**
 * Frozen plugin conformance vectors — PLG-1.
 *
 * Re-derives both plugin vectors from the live implementation and
 * asserts byte-for-byte equality with the frozen JSON. If these fail,
 * the wire format changed: that is a protocol-major event, not a test
 * to update casually (packages/protocol/docs/conformance.md §14).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
  computePluginDigests,
  isValidReleaseRkey,
  normalizePluginManifest,
  releaseRkeyFromCid,
  sha256DigestFromCid,
  type PluginManifest,
} from '../src';

const VECTORS_DIR = path.join(__dirname, '..', 'conformance', 'vectors');

const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

function loadVector<T>(slot: string): T {
  return JSON.parse(readFileSync(path.join(VECTORS_DIR, slot), 'utf8')) as T;
}

describe('plugin_digests vector', () => {
  interface DigestVector {
    cases: Array<{
      name: string;
      manifest: PluginManifest;
      expected: {
        per_capability: Record<string, string>;
        install_scope_hash: string;
        behavior_hash: string;
        presentation_hash: string;
      };
    }>;
  }

  const vector = loadVector<DigestVector>('plugin_digests.json');

  it.each(vector.cases.map((c) => [c.name, c] as const))(
    '%s — live implementation matches frozen digests',
    (_name, c) => {
      const digests = computePluginDigests(normalizePluginManifest(c.manifest), sha256);
      expect(digests.perCapability).toEqual(c.expected.per_capability);
      expect(digests.installScopeHash).toBe(c.expected.install_scope_hash);
      expect(digests.behaviorHash).toBe(c.expected.behavior_hash);
      expect(digests.presentationHash).toBe(c.expected.presentation_hash);
    },
  );
});

describe('plugin_release_rkey vector', () => {
  interface RkeyVector {
    cases: Array<{
      name: string;
      inputs: { digest_source_utf8: string; cid: string };
      expected_rkey: string;
    }>;
  }

  const vector = loadVector<RkeyVector>('plugin_release_rkey.json');

  it.each(vector.cases.map((c) => [c.name, c] as const))(
    '%s — rkey == f(cid), and the CID wraps the declared digest',
    (_name, c) => {
      // The CID's digest is SHA-256 of the declared source bytes —
      // pins the whole construction, not just the encode step.
      const declaredDigest = sha256(new TextEncoder().encode(c.inputs.digest_source_utf8));
      expect(sha256DigestFromCid(c.inputs.cid)).toEqual(declaredDigest);

      expect(releaseRkeyFromCid(c.inputs.cid)).toBe(c.expected_rkey);
      expect(isValidReleaseRkey(c.expected_rkey, c.inputs.cid)).toBe(true);

      // Tamper: any single-char change fails.
      const tampered = c.expected_rkey.slice(0, -1) + (c.expected_rkey.endsWith('a') ? 'b' : 'a');
      expect(isValidReleaseRkey(tampered, c.inputs.cid)).toBe(false);
    },
  );
});
