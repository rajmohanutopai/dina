/**
 * THE THREE STORES A FILING ACTUALLY READS (PLUGIN_ARCHITECTURE.md §11,
 * RESEARCHER_KERNEL_ARCHITECTURE §5.D).
 *
 * The projector decides what may travel; a source decides what there is. They
 * are separate on purpose: the plugin substrate must not import the commerce
 * domain, and the commerce domain must not own a rule about what a runner may
 * see. The seam between them is `setContextSource(category, fn)`, registered
 * from `installCommerceRuntime` — the same place the probing ledger and the
 * presence verifier are composed, because a registration each boot must
 * remember to repeat is one a boot eventually forgets.
 *
 * WHY THESE THREE CATEGORIES AND NOT THE OTHERS THE PACKS DECLARE. A category
 * belongs here once Dina owns a store it can read and a template that says
 * what the store may say. `business_registry`, `address` and `contact` have
 * both: the owner's own business settings (§5.D) and the counterparty's paper
 * identity and channels, which the owner states on two screens. `payment`,
 * `delivery`, `tax` and `invoice` name facts that ride the PARAMS of the rail
 * that needs them, where the egress gate reads every one of them; adding a
 * source that re-sent them as context would put the same fact through two
 * gates with two sets of rules.
 *
 * NOTHING IS SHAPED HERE. A source hands over what the store holds under the
 * template's field names and stops. Formatting, bounding, classing and the
 * regulated scan all happen once, in the projector — a source that pre-shaped
 * would be a second place where the rules live, and the second place is
 * always the one that drifts.
 */

import {
  getContact,
  getContactChannels,
  getPaperIdentity,
} from '../contacts/directory';
import { setContextSource, type ContextCandidate, type ContextSourceRequest } from '../plugins/context_sources';

import type { CommerceSettingsRepository } from './settings_store';
import type { PostalAddress, TaxRegistration } from './trade_identity';

/** The categories this module serves. Registered and cleared as one set. */
const TRADE_CONTEXT_CATEGORIES = ['business_registry', 'address', 'contact'] as const;

/**
 * Register the trade sources against a settings store, or clear them with
 * null. Clearing matters as much as registering: when the runtime goes (lock,
 * shutdown) the sources must go with it, or a projection would read a store
 * whose vault is no longer open.
 */
export function installTradeContextSources(settings: CommerceSettingsRepository | null): void {
  if (settings === null) {
    for (const category of TRADE_CONTEXT_CATEGORIES) setContextSource(category, null);
    return;
  }
  setContextSource('business_registry', (request) => businessRegistryCandidates(settings, request));
  setContextSource('address', (request) => addressCandidates(settings, request));
  setContextSource('contact', (request) => contactCandidates(request));
}

/**
 * Both parties' paper identity, self first.
 *
 * ONE CANDIDATE PER REGISTRATION, not one per party holding a list. A context
 * item is flat by construction (every value is a string), so a party with a
 * GSTIN and a PAN is two items — which is also what `max_context_items`
 * should be counting: registrations that travel, not parties that have some.
 */
function businessRegistryCandidates(
  settings: CommerceSettingsRepository,
  request: ContextSourceRequest,
): ContextCandidate[] {
  const out: ContextCandidate[] = [];
  const own = settings.readBusiness();
  if (own.ok) {
    for (const registration of own.settings.registrations) {
      out.push(registrationCandidate('self', own.settings.legalName, registration));
    }
  }
  const did = request.subject.contactDid;
  if (did !== undefined) {
    const paper = getPaperIdentity(did);
    for (const registration of paper.registrations) {
      out.push(registrationCandidate('counterparty', paper.legalName, registration));
    }
  }
  return out;
}

function registrationCandidate(
  role: 'self' | 'counterparty',
  legalName: string,
  registration: TaxRegistration,
): ContextCandidate {
  return {
    category: 'business_registry',
    fields: {
      role,
      legal_name: legalName,
      registration_scheme: registration.scheme,
      registration_value: registration.value,
    },
  };
}

/** Both parties' registered address — the owner's place of business, the counterparty's billing address. */
function addressCandidates(settings: CommerceSettingsRepository, request: ContextSourceRequest): ContextCandidate[] {
  const out: ContextCandidate[] = [];
  const own = settings.readBusiness();
  if (own.ok && own.settings.address !== undefined) {
    out.push(addressCandidate('self', own.settings.address));
  }
  const did = request.subject.contactDid;
  if (did !== undefined) {
    const billing = getPaperIdentity(did).billingAddress;
    if (billing !== null) out.push(addressCandidate('counterparty', billing));
  }
  return out;
}

function addressCandidate(role: 'self' | 'counterparty', address: PostalAddress): ContextCandidate {
  return {
    category: 'address',
    fields: {
      role,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      region: address.region,
      postal_code: address.postalCode,
      country: address.country,
    },
  };
}

/**
 * Who the task is about. Only the counterparty: "the owner's own contact row"
 * is not a thing, and a source that invented one would be projecting the
 * owner's identity under a category the consent card labels as contacts.
 *
 * The CHANNEL VALUE never appears — only which channels exist. A reminder
 * capability takes the number it dials in its params, where the owner reads it
 * on the card before it goes; context saying "this contact answers on a
 * phone" is what a runner needs to decide whether to offer, and a second copy
 * of the number is a second thing to leak.
 */
function contactCandidates(request: ContextSourceRequest): ContextCandidate[] {
  const did = request.subject.contactDid;
  if (did === undefined) return [];
  const contact = getContact(did);
  if (contact === null) return [];
  const channels = getContactChannels(did);
  const hasPhone = channels.phone !== null;
  const hasEmail = channels.email !== null;
  return [
    {
      category: 'contact',
      fields: {
        role: 'counterparty',
        display_name: contact.displayName,
        channel_kind: hasPhone && hasEmail ? 'both' : hasPhone ? 'phone' : hasEmail ? 'email' : 'none',
        trust_level: contact.trustLevel,
        known_since_class: contact.createdAt,
      },
    },
  ];
}
