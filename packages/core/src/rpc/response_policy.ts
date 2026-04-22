/**
 * RPC response policy: which envelopes + sender roles are permitted.
 *
 * Two invariants:
 *   (a) In production, responses MUST be encrypted. A plaintext success
 *       response means either a misconfigured server or a downgrade
 *       attacker — refuse.
 *   (b) Responses MUST NOT originate from `did:key` senders. `did:key`
 *       identities can INITIATE requests (they have no long-lived PDS
 *       record) but cannot host services — they are not addressable as
 *       a recipient.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md CORE-P0-005 / CORE-P0-006.
 */

export class PolicyViolationError extends Error {
  readonly status = 403;
  constructor(
    message: string,
    readonly code: 'plaintext_response' | 'did_key_responder',
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

/**
 * Reject plaintext success responses in production mode. Non-prod
 * deployments (test / dev) can opt in by passing `allowPlaintext: true`.
 * "Encrypted" here means the caller has verified the outer envelope's
 * ciphertext body — this helper just enforces the boolean flag.
 */
export function assertEncryptedResponse(isEncrypted: boolean, mode: 'production' | 'dev'): void {
  if (mode === 'production' && !isEncrypted) {
    throw new PolicyViolationError(
      'plaintext response rejected in production mode',
      'plaintext_response',
    );
  }
}

/**
 * Reject response envelopes whose sender DID uses the `did:key` method.
 * `did:key` is initiation-only; a well-formed response always comes
 * from a `did:plc:*` / `did:web:*` / similar long-lived identity.
 */
export function assertResponderDidNotKey(senderDid: string): void {
  if (senderDid.startsWith('did:key:')) {
    throw new PolicyViolationError(
      `did:key senders may not produce responses (sender=${senderDid})`,
      'did_key_responder',
    );
  }
}
