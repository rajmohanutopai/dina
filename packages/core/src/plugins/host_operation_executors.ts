import type { HostOperationExecutor } from './host_operations';
import type { CredentialBroker } from '../commerce/credential_broker';

/**
 * The remaining three typed host operations (§3.4, FR-P9 — WS-3.5).
 *
 * §3.4 names four: a bounded AppView search, a D2D send, a publication
 * candidate, and a connector broker. Only the first was written; the WBS row
 * recorded the other three as open, and this file closes it.
 *
 * THE SHAPE THEY SHARE, AND WHY IT IS THE POINT. A host operation is what a
 * runner asks CORE to do because the runner may not do it itself. So every
 * executor here follows one rule: the AUTHORITY comes from the install and the
 * node, never from the params. A runner that could name the sender of a D2D
 * message, the supplier a catalog publishes under, or the install a credential
 * belongs to would be choosing its own authority through a payload — which is
 * exactly what §3.4's typed operations exist to prevent.
 *
 * `failed` VERSUS `outcome_unknown` IS A REAL DISTINCTION HERE. The dispatcher
 * settles a THROW as `outcome_unknown`, because a socket can die after the
 * bytes left. An executor that can tell the difference must say so itself:
 * these return `failed` for characterised refusals decided before anything
 * left the node, and let the throw path handle the rest.
 */

/**
 * §3.4 — D2D send.
 *
 * WHAT A RUNNER MAY AND MAY NOT CHOOSE. It may choose the recipient and the
 * body. It may NOT choose the sender: `from` is this node, always, read from
 * identity rather than from params. A runner that could set it would be
 * sending mail signed by somebody else.
 *
 * THE RECIPIENT IS CHECKED AGAINST THE INSTALL'S PERMITTED SET. §6.5 makes a
 * connector declare the domains it needs; the D2D equivalent is the set of
 * counterparties this install may reach. Without that check, one permitted
 * send would be a channel to every DID the node can resolve.
 *
 * A SEND IS NEVER `failed` ONCE IT STARTS. The dispatcher's throw path owns
 * that: bytes may have left. This returns `failed` only for the refusals it
 * settles BEFORE calling the sender.
 */
export function makeD2DSendOperation(deps: {
  /** Sends under the NODE's identity. Never takes a `from`. */
  send: (args: { toDid: string; body: unknown }) => Promise<void>;
  /** Which counterparties this install may reach. */
  permittedRecipients: (installId: string) => readonly string[];
}): HostOperationExecutor {
  return async (ctx) => {
    const params = ctx.params;
    if (params === null || typeof params !== 'object') {
      return { kind: 'failed', error: 'd2d_send: params must be an object' };
    }
    const p = params as Record<string, unknown>;
    if (typeof p.to_did !== 'string' || p.to_did === '') {
      return { kind: 'failed', error: 'd2d_send: params.to_did must be a non-empty DID' };
    }
    if (p.from_did !== undefined) {
      // REFUSED rather than ignored. A runner that supplied it believes it
      // chose the sender, and silently overriding would leave that belief
      // intact until something depended on it.
      return {
        kind: 'failed',
        error: 'd2d_send: the sender is this node and cannot be named in params (§3.4)',
      };
    }
    if (p.body === undefined) {
      return { kind: 'failed', error: 'd2d_send: params.body is required' };
    }

    const permitted = deps.permittedRecipients(ctx.installId);
    if (!permitted.includes(p.to_did)) {
      return {
        kind: 'failed',
        error: `d2d_send: install ${ctx.installId} may not send to ${p.to_did}`,
      };
    }

    // Everything above is decided BEFORE the send. From here a throw means the
    // bytes may have left, and the dispatcher settles it `outcome_unknown`.
    await deps.send({ toDid: p.to_did, body: p.body });
    return { kind: 'completed', result: { sent_to: p.to_did } };
  };
}

/**
 * §3.4 / §12.1 step 10 — the publication candidate.
 *
 * A supplier runner returns a canonical publication candidate and Core
 * INDEPENDENTLY validates it: schema, digest, public-field policy, install
 * authority, and current owner consent. §12.1 is explicit that the primary
 * leakage control is structural, and this operation is where "the runner said
 * so" stops being a reason.
 *
 * IT VALIDATES; IT DOES NOT PUBLISH. Publication advances a chain buyers
 * follow and is the owner's commercial act (the `/catalog/publish` route). An
 * operation that both validated and published would let a runner move that
 * chain, which is precisely the authority §12.1 keeps on the owner's side.
 *
 * THE SUPPLIER IS THE NODE, never a params field. A candidate naming another
 * supplier would publish under somebody else's scope, and a
 * `manufacturer_sku` is only unambiguous scoped to whoever issued it.
 */
export function makePublicationCandidateOperation(deps: {
  /** This node's Business DID, or null before identity is established. */
  supplierDid: () => string | null;
  /** Is this install authorised to offer a catalog candidate? */
  mayPublish: (installId: string) => boolean;
  /** §12.1 — the leakage + schema gate. Returns findings, empty when clean. */
  validateCandidate: (args: {
    supplierDid: string;
    candidate: unknown;
  }) => readonly { refusal: string; detail: string }[];
}): HostOperationExecutor {
  return async (ctx) => {
    if (!deps.mayPublish(ctx.installId)) {
      return {
        kind: 'failed',
        error: `publication_candidate: install ${ctx.installId} is not the supplier install`,
      };
    }
    const supplierDid = deps.supplierDid();
    if (supplierDid === null || supplierDid === '') {
      // Fail closed: a candidate validated against no identity has not been
      // scoped to anyone, and the scope is what makes an identifier mean
      // something.
      return { kind: 'failed', error: 'publication_candidate: this node has no business identity' };
    }
    const params = ctx.params;
    if (params === null || typeof params !== 'object') {
      return { kind: 'failed', error: 'publication_candidate: params must be an object' };
    }
    const candidate = (params as { candidate?: unknown }).candidate;
    if (candidate === undefined) {
      return { kind: 'failed', error: 'publication_candidate: params.candidate is required' };
    }
    if ((params as { supplier_did?: unknown }).supplier_did !== undefined) {
      return {
        kind: 'failed',
        error: 'publication_candidate: the supplier is this node and cannot be named in params',
      };
    }

    const findings = deps.validateCandidate({ supplierDid, candidate });
    if (findings.length > 0) {
      // EVERY finding, not the first: an operator fixing a catalog one
      // refusal at a time gives up on the third round trip.
      return {
        kind: 'failed',
        error: `publication_candidate: ${findings.map((f) => `${f.refusal} (${f.detail})`).join('; ')}`,
      };
    }
    // VALIDATED, not published. The owner's route does that.
    return { kind: 'completed', result: { validated: true, supplier_did: supplierDid } };
  };
}

/**
 * §3.4 / §8.3 — the connector broker as a host operation.
 *
 * The credential broker already refuses everything §8.3 requires; this is the
 * seam that lets a RUNNER reach it. A runner asks for a named operation on a
 * named resource, and the broker — not this executor — decides whether the
 * install may, whether the operation was granted, and whether the params carry
 * credential-shaped material.
 *
 * WHAT THIS ADDS ON TOP. The install id comes from the PROPOSAL, which the
 * plugin lane authenticated, rather than from params. A runner that could name
 * its own install would spend another install's credential — the one thing the
 * broker's grant check cannot catch on its own, because it trusts whatever
 * install id it is handed.
 *
 * `failed` FOR THE BROKER'S PRE-NETWORK REFUSALS, `outcome_unknown` for the
 * rest. The broker already distinguishes them; this maps that distinction onto
 * §3.4's outcomes rather than flattening it, because "you may not" and "it may
 * have happened" lead an operator to opposite next steps.
 */
const BROKER_REFUSALS_BEFORE_SENDING: ReadonlySet<string> = new Set([
  'no_such_resource',
  'install_not_permitted',
  'operation_not_declared',
  'params_carry_credential',
  'no_executor',
]);

export function makeConnectorBrokerOperation(deps: {
  broker: () => CredentialBroker | null;
}): HostOperationExecutor {
  return async (ctx) => {
    const broker = deps.broker();
    if (broker === null) {
      return { kind: 'failed', error: 'connector_broker: this node has no credential broker' };
    }
    const params = ctx.params;
    if (params === null || typeof params !== 'object') {
      return { kind: 'failed', error: 'connector_broker: params must be an object' };
    }
    const p = params as Record<string, unknown>;
    if (typeof p.resource !== 'string' || p.resource === '') {
      return { kind: 'failed', error: 'connector_broker: params.resource is required' };
    }
    if (typeof p.operation !== 'string' || p.operation === '') {
      return { kind: 'failed', error: 'connector_broker: params.operation is required' };
    }
    if (p.install_id !== undefined) {
      // The install is the PROPOSAL's, which the plugin lane authenticated.
      // A runner naming its own would spend another install's credential.
      return {
        kind: 'failed',
        error: "connector_broker: the install is the proposal's and cannot be named in params",
      };
    }

    const performed = await broker.perform({
      installId: ctx.installId,
      resource: p.resource,
      operation: p.operation,
      params: p.operation_params ?? {},
    });
    if (performed.ok) return { kind: 'completed', result: performed.result };

    return BROKER_REFUSALS_BEFORE_SENDING.has(performed.refusal)
      ? { kind: 'failed', error: `${performed.refusal}: ${performed.error}` }
      : // `operation_failed` may have crossed the wire. §3.4's unknown is the
        // honest outcome, and it is what stops an automatic retry.
        { kind: 'outcome_unknown', detail: `${performed.refusal}: ${performed.error}` };
  };
}

/**
 * The recipients a D2D-send grant names, from the grants the owner approved.
 *
 * NO NEW POLICY. §8's grant constraints already carry a bounded `resources`
 * allowlist — "matched against the dispatch's resource tag", capped at 64
 * tokens — and a D2D recipient is exactly that: a resource the grant names.
 * Inventing a second allowlist beside it would put a channel policy in the
 * codebase that nobody consented to, and would drift from the one the owner
 * actually sees on the consent screen.
 *
 * AN UNCONSTRAINED GRANT NAMES NOBODY. A `standing` grant with no `resources`
 * list is unbounded for whatever it authorizes, and reading that as "every
 * DID" would turn one approval into a channel to the whole network. §8 already
 * refuses an unconstrained standing grant for a HIGH-class capability; this is
 * the same posture one layer up, applied to the recipient set rather than the
 * capability.
 *
 * A CORRUPT CONSTRAINT NAMES NOBODY EITHER. `constraintsCorrupt` marks a row
 * whose stored blob no longer parses, and the projection surfaces it rather
 * than dropping it — so treating such a grant as unconstrained would be the
 * fail-open that flag exists to prevent.
 */
export function permittedD2DRecipients(deps: {
  listGrants: (installId: string) => readonly {
    capability: string;
    revokedAt?: number;
    expiresAt?: number;
    constraints?: { resources?: readonly string[] };
    constraintsCorrupt?: boolean;
  }[];
  capability: string;
  nowSec: () => number;
}): (installId: string) => readonly string[] {
  return (installId) => {
    const now = deps.nowSec();
    const recipients = new Set<string>();
    for (const grant of deps.listGrants(installId)) {
      if (grant.capability !== deps.capability) continue;
      if (grant.revokedAt !== undefined) continue;
      if (grant.expiresAt !== undefined && grant.expiresAt <= now) continue;
      if (grant.constraintsCorrupt === true) continue;
      for (const resource of grant.constraints?.resources ?? []) recipients.add(resource);
    }
    return [...recipients];
  };
}
