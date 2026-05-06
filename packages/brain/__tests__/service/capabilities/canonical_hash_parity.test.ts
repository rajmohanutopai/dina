/**
 * Cross-stack schema_hash parity lock-in (MT-24-I2).
 *
 * Asserts that the TypeScript `EtaQueryParamsSchema` + `EtaQueryResultSchema`
 * + canonical description, hashed with `computeSchemaHash`, produces the
 * same SHA-256 hex digest that:
 *
 *   - Python's `compute_schema_hash` returns
 *     (`brain/src/service/capabilities/registry.py::compute_schema_hash`)
 *   - Go's canonicaliser returns
 *     (`core/test/canonical_hash_test.go::TestCanonicalHash_MatchesPythonReferenceForEtaQuery`)
 *   - Seeded test fixtures pin
 *     (`tests/release/test_rel_029_service_query.py`,
 *      `tests/sanity/test_transit_e2e.py`,
 *      `tests/system/user_stories/test_15_provider_service_query.py`,
 *      `tests/e2e/conftest.py::ETA_QUERY_SCHEMA_HASH`)
 *
 * The pinned hash was originally produced by Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"))` followed by
 * SHA-256 over the resulting bytes. If this test ever fails, ONE of the
 * stacks drifted — debug by comparing `canonicalJSON({description, params,
 * result})` to the Python reference's `json.dumps(...)` output. Do NOT
 * rotate the pinned hash unless you've updated every other stack in the
 * same commit.
 *
 * Originally regressed when the TS rewrite tightened the JSON Schemas with
 * `additionalProperties: false`, `$schema`, `title`, range constraints,
 * and a different `required` set — none of which were in the Python
 * reference. The fix restored byte-parity by relaxing the TS schemas back
 * to the canonical minimal form. This test prevents that regression class
 * from recurring.
 */

import { describe, expect, it } from '@jest/globals';

import {
  EtaQueryParamsSchema,
  EtaQueryResultSchema,
} from '../../../src/service/capabilities/eta_query';
import { computeSchemaHash } from '../../../src/service/capabilities/registry';

const ETA_QUERY_DESCRIPTION = 'Query estimated time of arrival for a transit service.';
const PINNED_HASH =
  '2886d1f82453b418f4e620219681b897cdfa536c2d9ee9b0f524605107117a71';

describe('canonical schema_hash parity (MT-24-I2)', () => {
  it('eta_query {description, params, result} hashes to the canonical Python reference', () => {
    const hash = computeSchemaHash({
      description: ETA_QUERY_DESCRIPTION,
      params: EtaQueryParamsSchema,
      result: EtaQueryResultSchema,
    });
    expect(hash).toBe(PINNED_HASH);
  });

  it('hash is stable across two evaluations of the same inputs', () => {
    const a = computeSchemaHash({
      description: ETA_QUERY_DESCRIPTION,
      params: EtaQueryParamsSchema,
      result: EtaQueryResultSchema,
    });
    const b = computeSchemaHash({
      description: ETA_QUERY_DESCRIPTION,
      params: EtaQueryParamsSchema,
      result: EtaQueryResultSchema,
    });
    expect(a).toBe(b);
  });

  it('changing the description rotates the canonical hash', () => {
    const baseline = computeSchemaHash({
      description: ETA_QUERY_DESCRIPTION,
      params: EtaQueryParamsSchema,
      result: EtaQueryResultSchema,
    });
    const drifted = computeSchemaHash({
      description: 'Drifted description.',
      params: EtaQueryParamsSchema,
      result: EtaQueryResultSchema,
    });
    expect(drifted).not.toBe(baseline);
  });

  it('rejects schema bloat — extra `additionalProperties: false` would change the hash', () => {
    // This test documents the regression that originally broke parity.
    // Adding `additionalProperties: false` to the params schema is the
    // single most common drift — it's a sensible local hardening but
    // changes the canonical hash. The test asserts that re-introducing
    // it produces a different hash, so a future "let me just tighten
    // this" commit fails fast instead of silently breaking interop.
    const bloated = {
      ...EtaQueryParamsSchema,
      additionalProperties: false,
    };
    const driftedHash = computeSchemaHash({
      description: ETA_QUERY_DESCRIPTION,
      params: bloated,
      result: EtaQueryResultSchema,
    });
    expect(driftedHash).not.toBe(PINNED_HASH);
  });
});
