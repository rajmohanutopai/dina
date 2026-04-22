/**
 * Task 4.57 — Home Node DID Document builder.
 *
 * Given the identity derivations from task 4.54 + the Home Node's
 * DID, produce a W3C-compliant DID Document with Dina's canonical
 * two verification methods:
 *
 *   - `#dina_signing`  — root signing key (task 4.54's `root`).
 *                        Used for request signatures, DID-doc
 *                        self-attestation, Trust Network entry
 *                        signing.
 *   - `#dina_messaging`— messaging key. Today mapped to the same
 *                        root pubkey for brand-new installs; the
 *                        messaging fragment is a **semantic label**
 *                        rather than a second key (legitimate per
 *                        W3C DID Core — the same VM can be
 *                        referenced under multiple assertion slots).
 *                        If future requirements split them, the
 *                        builder adds a second VM without breaking
 *                        external consumers who key off fragment id.
 *
 * **Underscore form** matches AT Protocol's convention (and the
 * "recent fix" noted in task 4.57) — fragment ids are `#dina_signing`
 * and `#dina_messaging` (underscore, not dash).
 *
 * **MsgBox service** optional: when the Home Node has a MsgBox
 * relay URL (from config.msgbox.url), it's added as a `DinaMsgBox`
 * service entry at id `#dina_messaging_endpoint`. Clients resolving
 * the DID see where to send D2D messages.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 4g task 4.57.
 */

import {
  publicKeyToMultibase,
  type DIDDocument,
  type VerificationMethod,
  type ServiceEndpoint,
  type DerivedKey,
} from '@dina/core';

/** W3C DID Core v1 + Multikey (matches Go Core's context list). */
const DID_V1_CONTEXT = 'https://www.w3.org/ns/did/v1';
const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1';

/** Fragment ids — underscore form per AT Protocol convention + task 4.57. */
export const SIGNING_VM_FRAGMENT = '#dina_signing';
export const MESSAGING_VM_FRAGMENT = '#dina_messaging';
export const MSGBOX_SERVICE_FRAGMENT = '#dina_messaging_endpoint';

export interface BuildHomeNodeDIDDocumentInput {
  /** The Home Node's DID (e.g. `did:plc:abcd1234`). */
  did: string;
  /** Derived keys from task 4.54 — provides root + (optional) distinct messaging pub. */
  signingKey: DerivedKey;
  /**
   * Optional distinct messaging keypair. When omitted, `#dina_messaging`
   * aliases to the signing key's pubkey — a valid W3C DID shape where
   * two fragment ids reference the same underlying key material.
   */
  messagingKey?: DerivedKey;
  /** Optional MsgBox relay endpoint — when set, a service entry is added. */
  msgboxEndpoint?: string;
}

/**
 * Build the Home Node DID document. Pure — no I/O, no clock calls (the
 * `created` timestamp is the ONE side effect; caller can stub via the
 * `now` param if reproducibility matters for tests).
 */
export function buildHomeNodeDIDDocument(
  input: BuildHomeNodeDIDDocumentInput,
  now: () => Date = () => new Date(),
): DIDDocument {
  if (!input.did || input.did.length === 0) {
    throw new Error('buildHomeNodeDIDDocument: did is required');
  }
  if (!input.signingKey || input.signingKey.publicKey.length !== 32) {
    throw new Error(
      'buildHomeNodeDIDDocument: signingKey must be a 32-byte Ed25519 keypair',
    );
  }

  const signingMultibase = publicKeyToMultibase(input.signingKey.publicKey);

  // By default messaging aliases the signing key's pub. Override when
  // an explicit messaging keypair is supplied.
  const messagingMultibase = input.messagingKey
    ? publicKeyToMultibase(input.messagingKey.publicKey)
    : signingMultibase;

  const signingVmId = `${input.did}${SIGNING_VM_FRAGMENT}`;
  const messagingVmId = `${input.did}${MESSAGING_VM_FRAGMENT}`;

  const verificationMethod: VerificationMethod[] = [
    {
      id: signingVmId,
      type: 'Multikey',
      controller: input.did,
      publicKeyMultibase: signingMultibase,
    },
  ];

  // Only add a second VM when the messaging pub is actually different
  // from signing. Otherwise one VM is enough and both fragment ids in
  // `authentication[]` point at it.
  const messagingIsDistinct = messagingMultibase !== signingMultibase;
  if (messagingIsDistinct) {
    verificationMethod.push({
      id: messagingVmId,
      type: 'Multikey',
      controller: input.did,
      publicKeyMultibase: messagingMultibase,
    });
  }

  // Both fragment ids appear in authentication so DID resolvers see
  // `#dina_signing` AND `#dina_messaging` as valid reference points,
  // regardless of whether the underlying VM is shared or split.
  const authentication: string[] = [
    signingVmId,
    messagingIsDistinct ? messagingVmId : signingVmId,
  ];

  const service: ServiceEndpoint[] = [];
  if (input.msgboxEndpoint && input.msgboxEndpoint.length > 0) {
    service.push({
      id: MSGBOX_SERVICE_FRAGMENT,
      type: 'DinaMsgBox',
      serviceEndpoint: input.msgboxEndpoint,
    });
  }

  return {
    '@context': [DID_V1_CONTEXT, MULTIKEY_CONTEXT],
    id: input.did,
    verificationMethod,
    authentication,
    service,
    created: now().toISOString(),
  };
}
