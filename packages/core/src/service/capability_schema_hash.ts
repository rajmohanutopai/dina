/**
 * The published `schema_hash` of a capability: lowercase sha256 hex over the
 * canonical JSON of `{params, result, description}`.
 *
 * The ONE recipe (A2A plan §4.2a): every publisher (Brain's, the server's,
 * the phone's listing editor) computes the published hash with it, Core's
 * service-query ingress checks a D2D requester's `schema_hash` against it,
 * and the A2A card advertises it (design §7.2 step 9). The hash pinned with
 * the Python and Go stacks (`canonical_hash_parity.test.ts`) holds on it.
 *
 * A schema with no RFC 8785 form (nested past 32 levels, a lone surrogate,
 * an `undefined` member, a non-finite number) throws `JcsError`: it is
 * refused at save (`schema_not_canonical`) and never published or hashed.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalize } from '@dina/a2a';

export interface CapabilitySchemaPair {
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  description?: string;
}

export function capabilitySchemaHash(s: CapabilitySchemaPair): string {
  const text = canonicalize({
    params: s.params,
    result: s.result,
    description: s.description ?? '',
  });
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}
