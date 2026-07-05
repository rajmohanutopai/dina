/**
 * Handle an inbound `service.grant_request` — a contact's requester-initiated
 * preflight for a relationship service (docs/CONTACT_SERVICES_ARCHITECTURE.md
 * §5.2). The requester named a CAPABILITY (never an rkey — it cannot know the
 * private rkey); the provider resolves it to a local `surface:'talk'` listing,
 * applies the closeness/default-offerable policy, and (on allow) mints a grant
 * and delivers it as a `service.offer`.
 *
 * Decisions (from the reviewed pure pieces — reused, not re-implemented):
 *   - `auto_grant`    → issueServiceOffer(...) delivers service.offer{grant_id,
 *     service_uri,request_id} and records `granted` in the owner-private log.
 *   - `ask_to_enable` → emit a pending-decision event for the mobile "allow this
 *     contact?" Talk prompt; the owner-private `prompt_shown` row is written on
 *     the phone when that card actually posts (not here — the prompt may never
 *     reach the owner).
 *   - `soft_reject`   → audit + an owner-private `auto_declined` row, but NO
 *     reply on the wire (the requester never learns it was refused — avoids the
 *     "denied is a bad look" leak; the row is the GRANTOR's private truth).
 *
 * Called fire-and-forget from the (sync) receive pipeline. Every outcome is
 * audit-logged; nothing is thrown back onto the wire.
 */

import {
  effectiveDefaultOfferable,
  effectiveDiscoverability,
  effectiveListingStatus,
  effectiveSurface,
  type ServiceGrantRequestBody,
} from '@dina/protocol';

import { appendAudit } from '../audit/service';
import { closeness } from '../contacts/closeness';
import { getContact, type Contact, type Relationship } from '../contacts/directory';
import {
  getServiceDecisionRepository,
  type ServiceDecisionOutcome,
} from '../contacts/service_decisions_repository';
import { VALID_RELATIONSHIPS } from '../contacts/validation';
import { getNodeDID } from '../pairing/ceremony';
import { getPeopleRepository } from '../people/repository';
import { getD2DSender } from '../server/routes/d2d_msg';
import { decideContactServiceGrant } from '../service/contact_grant_policy';
import { issueServiceOffer } from '../service/issue_offer';
import { configuredCapabilityKey, listServiceConfigs } from '../service/service_config';
import { getServiceGrantRepository } from '../service/service_grant_repository';

import { emitGrantRequestPending } from './grant_request_events';

/**
 * Find the active `surface:'talk'`, `known_only` listing that offers
 * `capability`. If several match (one capability under two talk listings, e.g.
 * personal + salon scheduling), prefer a DEFAULT-OFFERABLE listing — the one the
 * owner marked auto-grantable — and only then fall back to first-by-rkey
 * (`listServiceConfigs` is rkey-sorted). This is a deterministic tiebreak so a
 * close contact's auto-grant binds to the listing the owner actually intends,
 * not an arbitrary first match; a richer "ask which one" picker is still a
 * future refinement. Returns `null` when none qualifies.
 *
 * The `known_only` filter is a SECURITY constraint, not cosmetic: a talk
 * service must be `known_only` so that ingress authorizes it via the
 * grant-gated `isKnownOnlyCapabilityConfigured` path. A `talk + public` listing
 * would instead authorize via the ungated public `isCapabilityConfigured` path,
 * letting a `soft_reject`'d contact reach it with a bare `service.query` —
 * silently bypassing the closeness policy. So we refuse to mint a grant for a
 * non-`known_only` talk listing (spec §5.3 / §10: talk services are
 * `known_only` by construction).
 */
/**
 * The relationship `closeness` should use for a contact. The contact
 * directory's own stored `relationship` wins when explicitly set; otherwise
 * we fall back to the OWNER-asserted people-graph relationship — the value
 * `remember <name> is my brother` writes as the person's `relationshipHint`.
 *
 * Why this bridge exists: relationships are asserted in chat (people graph),
 * but `closeness` reads the contact directory. The two stores were never
 * synced, so an owner who tagged a contact only via `/remember` saw the grant
 * policy treat them as `unknown` → silent soft-reject. The contact directory
 * already keys each `Contact` to its people-graph `personId`, so the owner's
 * assertion is the right policy signal here.
 *
 * Why it is safe as authorization input: `relationshipHint` is written ONLY by
 * the owner's own first-person `/remember` ("<name> is *my* brother"), never by
 * the requester, so a contact cannot self-elevate. The hint is still validated
 * against the closed `Relationship` vocabulary before use — a free-form hint
 * ("doctor", "boss") falls through to `unknown`, which `closeness` already
 * treats as soft-reject. `closeness` itself never lets trust elevate and floors
 * a `blocked` contact to `unknown`, so this only ever supplies the relationship
 * dimension the owner deliberately stated.
 */
function effectiveRelationship(contact: Contact, requesterDID: string): Relationship {
  if (contact.relationship !== 'unknown') return contact.relationship;
  const repo = getPeopleRepository();
  const hint = repo?.resolveByIdentity('did', requesterDID)?.relationshipHint ?? '';
  return VALID_RELATIONSHIPS.has(hint) ? (hint as Relationship) : 'unknown';
}

function findTalkListingForCapability(
  capability: string,
): { rkey: string; defaultOfferable: boolean } | null {
  const matches: { rkey: string; defaultOfferable: boolean }[] = [];
  for (const { rkey, config } of listServiceConfigs()) {
    if (effectiveSurface(config) !== 'talk') continue;
    if (effectiveDiscoverability(config) !== 'known_only') continue;
    if (effectiveListingStatus(config) !== 'active') continue;
    if (configuredCapabilityKey(config, capability) === null) continue;
    matches.push({ rkey, defaultOfferable: effectiveDefaultOfferable(config) });
  }
  if (matches.length === 0) return null;
  // Deterministic tiebreak: prefer the default-offerable listing (the owner's
  // intended auto-grant target), else the first by rkey (matches are already
  // rkey-sorted by listServiceConfigs).
  return matches.find((m) => m.defaultOfferable) ?? matches[0];
}

export async function handleServiceGrantRequest(
  requesterDID: string,
  request: ServiceGrantRequestBody,
): Promise<void> {
  // CONFUSED-DEPUTY GUARD (spec §10): the provider identity is THIS node's own
  // DID — the transport authority — NEVER the sender-chosen inner `message.to`.
  // The grant + the offer's `service_uri` minted below must point at us, so we
  // derive it from `getNodeDID()` and never accept a provider DID off the wire.
  const selfDID = getNodeDID() ?? '';
  const audit = (action: string, detail: string): void => {
    appendAudit(requesterDID, action, selfDID, detail);
  };
  const nowSec = Math.floor(Date.now() / 1000);
  // OWNER-PRIVATE decision log (CONTACT_SERVICES_ARCHITECTURE.md §2/§10). The
  // requester-visible outcome is collapsed; THIS is where the owner sees the
  // truth ("Alonso asked for X — auto-declined by policy") so they can spot a
  // mis-tiered contact. Best-effort: never block or alter the decision path,
  // and it is NEVER sent back to the requester.
  const logDecision = (decision: ServiceDecisionOutcome, reason: string): void => {
    try {
      getServiceDecisionRepository()?.record({
        requesterDid: requesterDID,
        capability: request.capability,
        decision,
        reason,
        createdAt: nowSec,
      });
    } catch {
      /* owner-private log is advisory — swallow */
    }
  };

  // The receive pipeline gates on isContact before calling us; re-resolve
  // defensively (and to read relationship/trust for closeness).
  const contact = getContact(requesterDID);
  if (contact === null) {
    audit('d2d_grant_request_denied', `reason=not_a_contact capability=${request.capability}`);
    return;
  }

  const listing = findTalkListingForCapability(request.capability);
  if (listing === null) {
    // No talk listing offers this capability — silent soft-reject (no signal
    // about whether the service exists).
    audit('d2d_grant_request_denied', `reason=no_talk_listing capability=${request.capability}`);
    logDecision('auto_declined', 'no_talk_listing');
    return;
  }

  const tier = closeness({
    relationship: effectiveRelationship(contact, requesterDID),
    trustLevel: contact.trustLevel,
  });
  const decision = decideContactServiceGrant({
    closeness: tier,
    defaultOfferable: listing.defaultOfferable,
  });

  if (decision === 'soft_reject') {
    audit(
      'd2d_grant_request_denied',
      `reason=policy_soft_reject closeness=${tier} capability=${request.capability}`,
    );
    logDecision('auto_declined', `closeness=${tier}`);
    return;
  }

  if (decision === 'ask_to_enable') {
    // The deterministic decision is made HERE (Core decides reach); the
    // one-time "allow <contact>?" prompt is an OWNER decision that belongs on
    // the phone, so we EMIT a pending-decision event the mobile boot consumes
    // (it posts the Talk prompt; on the owner's yes it issues the grant via the
    // SAME path auto_grant takes — POST /v1/service/offer). Core must NOT mint
    // a grant unilaterally for a friend. Audit first so the decision is
    // observable even if no subscriber is listening (early boot / server-only).
    audit(
      'd2d_grant_request_pending',
      `reason=ask_to_enable closeness=${tier} capability=${request.capability} rkey=${listing.rkey}`,
    );
    // NB: the owner-private `prompt_shown` row is NOT written here. Core only
    // DECIDES to ask; the prompt may never actually post (the mobile boot
    // subscriber fans it out best-effort). Logging it now would make the
    // owner-private log claim a prompt was shown when none was. The mobile
    // surface owns the prompt lifecycle and records `prompt_shown` when the card
    // is durably posted, then `granted`/`prompt_timed_out` on the owner's tap.
    emitGrantRequestPending({
      requesterDID,
      capability: request.capability,
      rkey: listing.rkey,
      closeness: tier,
    });
    return;
  }

  // decision === 'auto_grant' — mint the grant + deliver the offer. `selfDID`
  // was derived from getNodeDID() at the top (never the wire).
  const grantRepo = getServiceGrantRepository();
  const sender = getD2DSender();
  if (grantRepo === null || sender === null || selfDID === '') {
    audit(
      'd2d_grant_request_error',
      `reason=not_wired grantRepo=${grantRepo !== null} sender=${sender !== null} selfDID=${selfDID !== ''}`,
    );
    logDecision('error', 'not_wired');
    return;
  }

  const result = await issueServiceOffer({
    toDID: requesterDID,
    rkey: listing.rkey,
    capability: request.capability,
    selfDID,
    nowSec,
    grantRepo,
    sender,
    // Echo the request_id so the requester can correlate this offer to the exact
    // grant_request it sent and auto-replay only that one (review #1).
    requestId: request.request_id,
  });
  if (result.ok) {
    audit(
      'd2d_grant_request_accepted',
      `grant_id=${result.grantId} capability=${request.capability} rkey=${listing.rkey}`,
    );
    logDecision('granted', `closeness=${tier}`);
  } else {
    audit(
      'd2d_grant_request_error',
      `reason=${result.errorCode} detail=${result.error} capability=${request.capability}`,
    );
    logDecision('error', result.errorCode ?? 'send_failed');
  }
}
