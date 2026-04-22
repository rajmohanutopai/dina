/**
 * DID Document serialization — field aliasing and JSON roundtrip.
 *
 * Ensures JSON output uses W3C-compliant field names:
 *   publicKeyMultibase (not public_key_multibase)
 *   verificationMethod (not verification_method)
 *   @context (not context)
 *   assertionMethod (not assertion_method)
 *
 * Deserialization accepts both camelCase and snake_case for interop
 * with Python/Go servers that may use either convention.
 *
 * Source: tests/test_did_models.py
 */

import type { DIDDocument, VerificationMethod, ServiceEndpoint } from './did_document';

/**
 * Serialize a DID Document to W3C-compliant JSON.
 * Output uses camelCase field names as required by the W3C DID spec.
 */
export function serializeDIDDocument(doc: DIDDocument): string {
  return JSON.stringify(doc);
}

/**
 * Deserialize W3C-compliant JSON into a DIDDocument.
 * Accepts both camelCase (publicKeyMultibase) and snake_case (public_key_multibase).
 */
export function deserializeDIDDocument(json: string): DIDDocument {
  const raw = JSON.parse(json);

  return {
    '@context': raw['@context'] ?? [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ],
    id: raw.id,
    verificationMethod: normalizeVerificationMethods(
      raw.verificationMethod ?? raw.verification_method ?? [],
    ),
    authentication: raw.authentication ?? [],
    service: normalizeServices(raw.service ?? []),
    ...(raw.created ? { created: raw.created } : {}),
  };
}

/**
 * Verify a DIDDocument JSON roundtrips correctly:
 * serialize → deserialize → serialize → identical output.
 */
export function verifyJsonRoundtrip(doc: DIDDocument): boolean {
  const first = serializeDIDDocument(doc);
  const deserialized = deserializeDIDDocument(first);
  const second = serializeDIDDocument(deserialized);
  return first === second;
}

/** Normalize verification methods: handle snake_case field aliases. */
function normalizeVerificationMethods(vms: unknown[]): VerificationMethod[] {
  return vms.map((vm: any) => ({
    id: vm.id,
    type: vm.type ?? 'Multikey',
    controller: vm.controller,
    publicKeyMultibase: vm.publicKeyMultibase ?? vm.public_key_multibase,
  }));
}

/** Normalize service endpoints: handle snake_case field aliases. */
function normalizeServices(services: unknown[]): ServiceEndpoint[] {
  return services.map((s: any) => ({
    id: s.id,
    type: s.type,
    serviceEndpoint: s.serviceEndpoint ?? s.service_endpoint,
  }));
}
