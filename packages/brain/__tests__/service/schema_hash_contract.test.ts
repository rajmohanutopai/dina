/**
 * CONTRACT — the hash a provider STORES locally must equal the hash the
 * publisher PUBLISHES, because `checkSchemaHash` compares the requester's
 * echo of the published hash against the local config's hash.
 *
 * The bug class this pins (found live in the Tier 1 salon demo): the
 * mobile listing editor stored a hash of the params schema alone while
 * the publisher emitted the canonical hash of `{params, result,
 * description}` — so every hash-carrying query against a form-created
 * listing died with `schema_version_mismatch`. All local writers now go
 * through Core's `capabilitySchemaHash`; this test fails if either
 * side drifts.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { capabilitySchemaHash, getCapability } from '@dina/core';

import { toPublisherConfig } from '../../src/service/config_sync';
import { buildRecord } from '../../src/service/service_publisher';

import type { ServiceConfig } from '@dina/protocol';

function publishedHashFor(config: ServiceConfig, capability: string): string {
  const record = buildRecord(toPublisherConfig(config), 1_750_000_000_000);
  const schemas = record.capabilitySchemas as Record<string, { schema_hash: string }>;
  return schemas[capability].schema_hash;
}

describe('local schemaHash ⇔ published schema_hash contract', () => {
  it('capabilitySchemaHash matches what buildRecord publishes', () => {
    const def = getCapability('appointment_availability');
    expect(def).toBeDefined();
    const entry = {
      params: def!.paramsSchema,
      result: def!.resultSchema,
      schemaHash: '',
      description: def!.description,
    };
    const local = capabilitySchemaHash(entry);
    const config: ServiceConfig = {
      isDiscoverable: true,
      discoverability: 'public',
      status: 'active',
      name: "Alonso's Salon",
      capabilities: {
        appointment_availability: {
          responsePolicy: 'auto',
          category: 'appointments',
          instruction: 'Answer from my notes.',
        },
      },
      capabilitySchemas: {
        appointment_availability: { ...entry, schemaHash: local },
      },
    };
    expect(publishedHashFor(config, 'appointment_availability')).toBe(local);
  });

  it('a params-only hash (the old form recipe) does NOT match the published hash', () => {
    const def = getCapability('appointment_availability');
    const paramsOnly = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(def!.paramsSchema))));
    const canonical = capabilitySchemaHash({
      params: def!.paramsSchema,
      result: def!.resultSchema,
      description: def!.description,
    });
    expect(paramsOnly).not.toBe(canonical);
  });

  it('description is part of the canonical input (a copy edit rotates the hash)', () => {
    const def = getCapability('appointment_book');
    const a = capabilitySchemaHash({
      params: def!.paramsSchema,
      result: def!.resultSchema,
      description: 'v1',
    });
    const b = capabilitySchemaHash({
      params: def!.paramsSchema,
      result: def!.resultSchema,
      description: 'v2',
    });
    expect(a).not.toBe(b);
  });

  it('missing description hashes like empty-string description (publisher parity)', () => {
    const def = getCapability('appointment_book');
    const noDesc = capabilitySchemaHash({
      params: def!.paramsSchema,
      result: def!.resultSchema,
    });
    const emptyDesc = capabilitySchemaHash({
      params: def!.paramsSchema,
      result: def!.resultSchema,
      description: '',
    });
    expect(noDesc).toBe(emptyDesc);
  });
});
