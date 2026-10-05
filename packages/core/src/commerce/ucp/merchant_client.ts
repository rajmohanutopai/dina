/**
 * The merchant client (UCP plan §3.6): discovery, the negotiated schemas, and
 * one validated call at a time.
 *
 *  - Opening a merchant discovers it and resolves its schemas; the result is
 *    reused for a minute (the profile's own cache decides whether the next
 *    opening fetches it again), and its status (what was dropped, and
 *    why) is the owner's merchant status.
 *  - A call whose operation cannot be validated for this merchant is never
 *    sent; a payload that fails its request schema is never sent (A18).
 *  - A 200 may be a business failure: `ucp.status == "error"` is read before
 *    any resource field (step 7); a resource answer is then validated against
 *    the composed response schema, and one that fails is not used.
 *  - Every request carries Dina's profile URL (`UCP-Agent`) and is signed
 *    with the node's UCP key; with no UCP identity installed (a sealed
 *    phone), nothing is sent. A signed answer is checked against the keys the
 *    merchant's profile lists, the profile read again (at most once a minute
 *    per merchant) for a key it does not list.
 *
 * Merchant strings in an answer are untrusted: the caller passes them through
 * the guard queue before Brain sees any (§3.11).
 */

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64urlEncode } from '@dina/a2a';
import {
  es256Thumbprint,
  profileUrlForLabel,
  usableEs256Keys,
  type KeyLookup,
  type MerchantProfile,
  UCP_PROFILE_HOST,
  readBusinessAnswer,
  type MessagesParse,
  type OperationName,
  type TransportError,
  DroppedEntry,
  requiredWebhookComponents,
  verifyMessage,
  type HttpMessage,
  type VerifyOutcome,
} from '@dina/ucp';

import {
  merchantOrigin,
  UcpDiscovery,
  type DiscoveredMerchant,
  type DiscoveryFailure,
} from './discovery';
import { getUcpIdentity, type UcpIdentity } from './identity';
import { SchemaResolver, type MerchantSchemas, type SchemaDrop } from './schemas';
import { UcpTransport, type MerchantKeys, type PreparedCall } from './transport';

import type { ValidationError } from './schema_validator';
import type { JsonObject } from '@dina/a2a';

export interface MerchantStatus {
  origin: string;
  transport: 'mcp' | 'rest';
  /** Capabilities Dina can use with this merchant. */
  active: string[];
  /** Profile entries Dina will not use (version, authority, transport). */
  droppedEntries: DroppedEntry[];
  /** Capabilities whose schemas failed a step 4a check. */
  droppedSchemas: SchemaDrop[];
}

export type CallResult =
  | { ok: true; value: JsonObject; messages: MessagesParse }
  /** The merchant answered with `ucp.status: "error"`. */
  | { ok: false; kind: 'error_response'; messages: MessagesParse; continueUrl?: string }
  /**
   * Not sent: no identity, an operation this merchant cannot serve, an
   * invalid payload, or a linked account whose token cannot be had just now
   * (its refresh failed for a passing reason): never sent without it.
   */
  | {
      ok: false;
      kind: 'not_sent';
      reason:
        | 'no_identity'
        | 'unavailable'
        | 'request_invalid'
        | 'link_unavailable'
        // Bytes bound to an approved account, and the link is another now (§3.7).
        | 'credential_changed';
      errors?: ValidationError[];
    }
  /** Sent, and the answer failed its schema: not used. */
  | { ok: false; kind: 'answer_invalid'; errors: ValidationError[] }
  | { ok: false; kind: 'transport'; error: TransportError }
  | { ok: false; kind: 'network'; error: string; sent: boolean }
  | { ok: false; kind: 'malformed'; reason: string };

export interface CallInput {
  id?: string;
  payload?: JsonObject;
  idempotencyKey?: string;
}

/**
 * The signing keys a merchant's profiles list, as a verifier looks them up:
 * its root profile's, and a version leaf's if it lists any (the first listing
 * of a `kid` wins).
 */
export function merchantKeyLookup(...profiles: readonly MerchantProfile[]): KeyLookup {
  const keys = new Map(
    profiles
      .flatMap((p) => usableEs256Keys(p.keys))
      .reverse()
      .map((k) => [
        k.kid,
        {
          verify: (base: Uint8Array, signature: Uint8Array) => {
            try {
              // ECDSA as RFC 9421 uses it: either half of s (low-S is a Bitcoin rule).
              return p256.verify(signature, base, k.publicKey, { lowS: false });
            } catch {
              return false;
            }
          },
          thumbprint: es256Thumbprint(
            base64urlEncode(k.publicKey.slice(1, 33)),
            base64urlEncode(k.publicKey.slice(33, 65)),
            sha256,
          ),
        },
      ]),
  );
  return (keyid) => keys.get(keyid) ?? null;
}

/** Linked accounts as merchant calls use them (§3.17); the checkout runtime installs its link service. */
export interface UcpLinkAuth {
  /**
   * The link's state at this merchant, its lifetime and its authorization
   * revision (an approved checkout binds both, §3.7); null: none.
   */
  view(
    origin: string,
  ): {
    state: 'active' | 'needs_relink' | 'revoking';
    link_id: string;
    auth_revision: number;
  } | null;
  /** The access token for this merchant, refreshed first when about to expire; null: none usable. */
  bearer(origin: string): Promise<string | null>;
  /**
   * Refresh after the merchant refused `refused`; nothing is sent when the
   * link already holds another token. Whether the link is usable after.
   */
  refresh(origin: string, refused?: string): Promise<boolean>;
  /** A merchant asked for a linked account (a Bearer challenge a link answers): offered to the owner. */
  want(origin: string, scopes: readonly string[]): void;
}

/** A Bearer challenge a link answers (identity-linking §identity_required, §insufficient_scope). */
export function linkAnswers(challenge: { error?: string } | undefined): boolean {
  return (
    challenge !== undefined &&
    (challenge.error === undefined ||
      challenge.error === 'invalid_token' ||
      challenge.error === 'insufficient_scope')
  );
}

let installedLinks: UcpLinkAuth | null = null;

export function installUcpLinkAuth(links: UcpLinkAuth | null): void {
  installedLinks = links;
}

export function getUcpLinkAuth(): UcpLinkAuth | null {
  return installedLinks;
}

export class MerchantConnection {
  private keyFor: KeyLookup;
  /** The root profile's keys alone: a webhook is signed with these (§3.13). */
  private rootKeyFor: KeyLookup;

  constructor(
    readonly merchant: DiscoveredMerchant,
    readonly schemas: MerchantSchemas,
    private readonly transport: UcpTransport,
    private readonly identity: () => UcpIdentity | null,
    private readonly profileHost: string,
    /** Read the merchant's profiles again; null when not allowed now or failed. */
    private readonly reread: () => Promise<Pick<
      DiscoveredMerchant,
      'profile' | 'rootProfile'
    > | null> = async () => null,
    private readonly links: () => UcpLinkAuth | null = getUcpLinkAuth,
  ) {
    this.keyFor = merchantKeyLookup(merchant.rootProfile, merchant.profile);
    this.rootKeyFor = merchantKeyLookup(merchant.rootProfile);
  }

  /**
   * The linked account a call would be sent under now: the link's lifetime and
   * authorization revision, or null with no live link. A checkout approval
   * binds it, and a change voids the approval (plan §3.7).
   */
  credential(): { ref: string; revision: number } | null {
    const view = this.links()?.view(this.merchant.origin) ?? null;
    return view?.state === 'active' ? { ref: view.link_id, revision: view.auth_revision } : null;
  }

  /** Whether bytes bound to an account (`prepared.credential`) may go under the link as it is now. */
  private boundHolds(prepared: PreparedCall): boolean {
    if (prepared.credential === undefined) return true;
    const now = this.credential();
    const want = prepared.credential;
    return now === null || want === null
      ? now === want
      : now.ref === want.ref && now.revision === want.revision;
  }

  /** Dina's profile URL as this node sends it now (`UCP-Agent`); empty with no identity. */
  profileUrl(): string {
    const identity = this.identity();
    return identity === null ? '' : profileUrlForLabel(identity.label, this.profileHost);
  }

  private keys(): MerchantKeys {
    return {
      keyFor: this.keyFor,
      refresh: async () => {
        const found = await this.reread();
        if (found === null) return null;
        this.keyFor = merchantKeyLookup(found.rootProfile, found.profile);
        this.rootKeyFor = merchantKeyLookup(found.rootProfile);
        return this.keyFor;
      },
    };
  }

  /**
   * Verify an order webhook this merchant's root profile signed (§3.13 step
   * 4; coverage per D7). An unknown key reads the profile again at most once
   * a minute, as for answers, so a forged delivery cannot make Dina fetch at
   * will; coverage and the digest are checked before any key is looked up.
   */
  async verifyWebhook(msg: HttpMessage): Promise<VerifyOutcome> {
    const verify = (keyFor: KeyLookup) =>
      verifyMessage({ msg, required: requiredWebhookComponents(msg), keyFor, sha256 });
    const outcome = verify(this.rootKeyFor);
    if (outcome.ok || outcome.reason !== 'key_not_found') return outcome;
    return (await this.keys().refresh()) === null ? outcome : verify(this.rootKeyFor);
  }

  status(): MerchantStatus {
    return {
      origin: this.merchant.origin,
      transport: this.merchant.transport,
      active: [...this.schemas.active.keys()].sort(),
      droppedEntries: [...this.merchant.dropped],
      droppedSchemas: [...this.schemas.dropped],
    };
  }

  async call(operation: OperationName, input: CallInput = {}): Promise<CallResult> {
    const prepared = this.prepare(operation, input);
    return prepared.ok ? this.send(prepared.call) : prepared;
  }

  /**
   * Check a call and build its exact bytes, sending nothing (§3.10): a state
   * change is journaled with them before its first send. Refused, as `call`
   * would refuse it: no identity, an operation this merchant cannot serve, a
   * payload that fails its request schema.
   */
  prepare(
    operation: OperationName,
    input: CallInput = {},
  ): { ok: true; call: PreparedCall } | (CallResult & { ok: false; kind: 'not_sent' }) {
    const identity = this.identity();
    if (identity === null) return { ok: false, kind: 'not_sent', reason: 'no_identity' };
    if (!this.schemas.available(operation))
      return { ok: false, kind: 'not_sent', reason: 'unavailable' };
    if (input.payload !== undefined) {
      const checked = this.schemas.validate(operation, 'request', input.payload);
      if (!checked.valid) {
        if ('unavailable' in checked) return { ok: false, kind: 'not_sent', reason: 'unavailable' };
        return { ok: false, kind: 'not_sent', reason: 'request_invalid', errors: checked.errors };
      }
    }
    return {
      ok: true,
      call: this.transport.prepare({
        transport: this.merchant.transport,
        endpoint: this.merchant.endpoint,
        profileUrl: profileUrlForLabel(identity.label, this.profileHost),
        operation,
        ...input,
      }),
    };
  }

  /**
   * Send prepared bytes (a first send, or a resend of journaled bytes to
   * their stored endpoint) and read the answer: a business failure first,
   * then the resource against its response schema.
   */
  async send(prepared: PreparedCall): Promise<CallResult> {
    if (this.identity() === null) return { ok: false, kind: 'not_sent', reason: 'no_identity' };
    // A linked account at this merchant rides along as `Authorization: Bearer` (§3.17).
    const auth = this.links();
    const origin = this.merchant.origin;
    const linked = auth?.view(origin)?.state === 'active';
    const bearer = auth === null || !linked ? null : await auth.bearer(origin);
    // A live link whose token cannot be had now is never stood in for by no token at all.
    const unavailable = { ok: false, kind: 'not_sent', reason: 'link_unavailable' } as const;
    if (linked && bearer === null) return unavailable;
    // Bytes bound to an approved account go only under that account, checked now that the token
    // is in hand (a refresh may have waited while the link was replaced or authorized again).
    const changed = { ok: false, kind: 'not_sent', reason: 'credential_changed' } as const;
    if (!this.boundHolds(prepared)) return changed;
    let sent = await this.transport.send(prepared, this.keys(), bearer ?? undefined);
    // The merchant called the token invalid: refresh once (unless one landed meanwhile), then
    // the same bytes once more. A refresh failing while the link stays live is a passing fault.
    if (
      !sent.ok &&
      sent.kind === 'transport' &&
      auth !== null &&
      bearer !== null &&
      sent.error.challenge?.error === 'invalid_token'
    ) {
      const usable = await auth.refresh(origin, bearer);
      const again = usable ? await auth.bearer(origin) : null;
      if (again !== null && !this.boundHolds(prepared)) return changed;
      if (again !== null) sent = await this.transport.send(prepared, this.keys(), again);
      else if (auth.view(origin)?.state === 'active') return unavailable;
    }
    // A merchant asking for a linked account: the owner is offered one (checkout, cart and
    // search alike; orders also pause for it).
    if (!sent.ok && sent.kind === 'transport' && auth !== null && linkAnswers(sent.error.challenge))
      auth.want(origin, sent.error.challenge?.scopes ?? []);
    if (!sent.ok) return sent;
    const answer = readBusinessAnswer(sent.value);
    if (answer.kind === 'malformed') return { ok: false, kind: 'malformed', reason: answer.reason };
    if (answer.kind === 'error_response') {
      return {
        ok: false,
        kind: 'error_response',
        messages: answer.messages,
        ...(answer.continueUrl !== undefined ? { continueUrl: answer.continueUrl } : {}),
      };
    }
    const checked = this.schemas.validate(prepared.operation, 'response', answer.value);
    if (!checked.valid)
      return {
        ok: false,
        kind: 'answer_invalid',
        errors: 'unavailable' in checked ? [] : checked.errors,
      };
    return { ok: true, value: answer.value, messages: answer.messages };
  }
}

export interface UcpMerchantClientOptions {
  discovery?: UcpDiscovery;
  resolver?: SchemaResolver;
  transport?: UcpTransport;
  identity?: () => UcpIdentity | null;
  /** The profile host Dina's profile is served from (default: production). */
  profileHost?: string;
  now?: () => number;
}

export type OpenResult =
  | { ok: true; connection: MerchantConnection }
  | { ok: false; reason: DiscoveryFailure; detail?: string };

/** How long an opened merchant is reused before its profile is read again (the profile cache decides freshness). */
const REOPEN_AFTER_MS = 60_000;
/** The least time between two refreshes of one merchant's profile for an unknown signing key. */
const REREAD_AFTER_MS = 60_000;
/** Merchants kept open at once; the oldest go first. */
const MAX_OPEN = 64;

export class UcpMerchantClient {
  private readonly discovery: UcpDiscovery;
  private readonly resolver: SchemaResolver;
  private readonly transport: UcpTransport;
  private readonly identity: () => UcpIdentity | null;
  private readonly profileHost: string;
  private readonly now: () => number;
  private readonly opened = new Map<string, { at: number; result: Promise<OpenResult> }>();
  /** When each merchant's profile was last read again for a key it did not list. */
  private readonly rereadAt = new Map<string, number>();

  constructor(options: UcpMerchantClientOptions = {}) {
    this.discovery = options.discovery ?? new UcpDiscovery();
    this.resolver = options.resolver ?? new SchemaResolver();
    this.identity = options.identity ?? getUcpIdentity;
    this.transport =
      options.transport ??
      new UcpTransport({
        signer: () => {
          const id = this.identity();
          // No key known yet (a restored node before the publisher read the host): nothing is sent.
          const key = id?.signingKey() ?? null;
          return key === null ? null : { keyid: key.jwk.kid, sign: key.sign };
        },
      });
    this.profileHost = options.profileHost ?? UCP_PROFILE_HOST;
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether this node can make UCP calls now: its UCP identity is installed
   * (an unlocked node) and knows which key signs (U7: a restored node learns
   * it from the host first).
   */
  ready(): boolean {
    return this.notReady() === null;
  }

  /**
   * Why no UCP call can be made now, or null when one can: `ucp_not_ready`,
   * the vault is sealed (no identity); `ucp_key_pending`, the node does not
   * know which key signs yet (its profile is not published, U7).
   */
  notReady(): 'ucp_not_ready' | 'ucp_key_pending' | null {
    const identity = this.identity();
    if (identity === null) return 'ucp_not_ready';
    return identity.signingKey() === null ? 'ucp_key_pending' : null;
  }

  /** Discover the merchant and resolve its schemas; reused for a minute, one opening at a time. */
  open(input: string): Promise<OpenResult> {
    // One entry per merchant, however the caller spelled its origin.
    const origin = merchantOrigin(input) ?? input;
    const held = this.opened.get(origin);
    if (held !== undefined && this.now() - held.at < REOPEN_AFTER_MS) return held.result;
    const result = this.openNow(origin);
    const entry = { at: this.now(), result };
    this.opened.delete(origin);
    this.opened.set(origin, entry);
    while (this.opened.size > MAX_OPEN)
      this.opened.delete(this.opened.keys().next().value as string);
    // A failed opening is not reused; a newer opening of the same merchant is left alone.
    void result.then((r) => {
      if (!r.ok && this.opened.get(origin) === entry) this.opened.delete(origin);
    });
    return result;
  }

  /**
   * The merchant's profile read again now, for a signing key it did not list:
   * at most once a minute per merchant (§3.2), so a forged answer cannot make
   * Dina fetch the profile at will.
   */
  private async reread(
    origin: string,
  ): Promise<Pick<DiscoveredMerchant, 'profile' | 'rootProfile'> | null> {
    const last = this.rereadAt.get(origin);
    if (last !== undefined && this.now() - last < REREAD_AFTER_MS) return null;
    this.rereadAt.set(origin, this.now());
    while (this.rereadAt.size > MAX_OPEN)
      this.rereadAt.delete(this.rereadAt.keys().next().value as string);
    const found = await this.discovery.discover(origin, { force: true });
    return found.ok ? found.merchant : null;
  }

  private async openNow(origin: string): Promise<OpenResult> {
    const found = await this.discovery.discover(origin);
    if (!found.ok) return found;
    const schemas = await this.resolver.resolve(found.merchant.negotiated);
    return {
      ok: true,
      connection: new MerchantConnection(
        found.merchant,
        schemas,
        this.transport,
        this.identity,
        this.profileHost,
        () => this.reread(origin),
      ),
    };
  }
}
