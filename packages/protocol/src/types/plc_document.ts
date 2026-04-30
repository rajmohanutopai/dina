/**
 * W3C DID Document shape + Dina's service-endpoint extensions.
 *
 * Aligned with the Go identity adapter's wire format:
 * - `@context`: ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"]
 * - `verificationMethod[0].type`: "Multikey" with `publicKeyMultibase`
 * - `service[]`: Dina-specific endpoints via `#dina_messaging` (underscore per AT Protocol convention)
 *
 * Source: extracted from `@dina/core/src/identity/did_document.ts` per
 * docs/HOME_NODE_LITE_TASKS.md task 1.17 (category 1.16b).
 *
 * Zero runtime deps — pure type declarations.
 */

/** Multikey verification method (matching Go's Multikey type). */
export interface VerificationMethod {
  id: string;
  type: 'Multikey';
  controller: string;
  publicKeyMultibase: string;
}

/** Dina service endpoint — routes D2D traffic via MsgBox relay or direct HTTPS. */
export interface ServiceEndpoint {
  id: string;
  type: 'DinaMsgBox' | 'DinaDirectHTTPS';
  serviceEndpoint: string;
}

/** W3C-compliant DID Document with Dina's service extensions. */
export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  service: ServiceEndpoint[];
  /**
   * Verification relationships available for assertion (record-signing).
   *
   * Per W3C DID Core §5.3.2, entries are either string references into
   * `verificationMethod` (fragment-only or fully-qualified DID URLs) or
   * inline `VerificationMethod` objects. Trust Network V1 namespace keys
   * register here (plan §3.5.2) — `did:plc:xxxx#namespace_<N>`.
   */
  assertionMethod?: (string | VerificationMethod)[];
  /** ISO 8601 creation timestamp. */
  created?: string;
}
