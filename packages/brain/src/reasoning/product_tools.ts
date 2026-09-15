/**
 * `search_products` + `recommend_offer` — the consumer research tools
 * (RESEARCHER_KERNEL_ARCHITECTURE.md §5.A1/A2/A3/A5/A6).
 *
 * Finds and compares offers for a PRODUCT across suppliers on the Dina network,
 * ranked by price / lead time / seller trust — MONEY-FREE. This is the
 * Brain-local orchestration the base vision needs: it reaches AppView directly
 * for catalog offers and seller trust (the `search_peerlens` precedent — no
 * `CoreClient` method, and Core makes no external call), and runs the pure
 * `@dina/core` engines: the catalog→Offer bridge, `rankOffers`, and
 * `buildComparisonCard` in HAND-OFF mode. It never completes a purchase — the
 * card's action is `where_to_buy`, the Cart Handover.
 *
 * NOT TERMINAL. Unlike a service query, this returns the ranked offers to the
 * loop so the reasoning step can weigh them against the user's stated
 * preferences (§5.A6) before answering. Two things make that weighing
 * possible, both learned from the real-model run (implementation-notes Iter
 * 30): prices reach the model in MAJOR units ("INR 4499.00" — the wire's
 * minor units read as a hundredfold price), and every offer names the seller
 * AS THE OWNER KNOWS THEM when the supplier DID is one of their contacts
 * (`contactLookup`): display name, the owner's trust level, and the
 * categories they prefer that contact for. Offers are DID-keyed; the owner's
 * preferences ("never buy from ChairMaker again", a go-to seller for office
 * furniture) are name-keyed — this is the bridge.
 *
 * `recommend_offer` CLOSES THE LOOP ON THE CARD (§5.A6 "the ordering of
 * alternatives"). The ranking's #1 is money-free arithmetic; the model's pick,
 * weighed against the owner's preferences, may differ — and the phone posts
 * the card beside the prose. Two answers on one screen is the failure. So the
 * model commits its decision through this tool: which offer (or none), why in
 * the owner's terms, and what it set aside; the card is rebuilt from the SAME
 * ranking with that choice on top (`buildComparisonCard({choice})`) and the
 * chat bridge posts the later card. The tool re-scores nothing and accepts no
 * prices from the model: it names an offer the research already holds, or it
 * refuses. The research it refers to lives in a small bounded cache keyed by
 * the `research_id` `search_products` handed back — ONE cache per pipeline
 * (`buildAgenticAskPipeline` creates it and hands it to every per-ask tool
 * registry, so a Pattern A pause and resume, which rebuilds the registry,
 * still finds the id), a few minutes, so a stale or forged id is a typed
 * refusal, never a card.
 *
 * ONE LISTING PER SUPPLIER. The comparison is across sellers; a supplier who
 * lists the same product twice is one seller with their best price, not two
 * competitors — and the model names a pick by supplier DID, which must be
 * unambiguous. Extra listings are collapsed after the bridge (the cheapest
 * valid price wins; a priced listing beats an unpriced one) and counted.
 */

import {
  buildComparisonCard,
  catalogCandidatesToOffers,
  catalogOfferId,
  formatMoney,
  oneListingPerSupplier,
  rankOffers,
  type BuyerRequirements,
  type CatalogOfferInput,
  type ComparisonCard,
  type ComparisonChoice,
  type Contact,
  type CoreClient,
  type HandoffLink,
  type Offer,
  type Quantity,
  type UnpricedCatalogRow,
} from '@dina/core';

import { type AppViewClient, type CommerceCatalogCandidate } from '../appview_client/http';

import { type AgentTool } from './tool_registry';
import { fetchSellerTrustBp } from './trust_producer';

/** Minimum AppView surface the tool needs — lets tests swap a stub in. */
export type ProductToolAppViewClient = Pick<AppViewClient, 'searchCatalog' | 'getProfile'>;

/** The one Core read the tool makes: who is this seller to the owner? */
export type ProductToolCoreClient = Pick<CoreClient, 'contactLookup'>;

export interface SearchProductsToolOptions {
  appViewClient: ProductToolAppViewClient;
  /** Resolves a supplier DID to the owner's contact, when they have one. */
  core: ProductToolCoreClient;
  /**
   * The research cache shared by every tool registry of one pipeline. Omit to
   * give this pair its own (a host with one registry, or a test).
   */
  cache?: ResearchCache;
  /** Max candidates to pull from discovery before ranking. */
  resultLimit?: number;
  logger?: (event: Record<string, unknown>) => void;
  /** Injected clock — defaults to the real one. Tests pin it. */
  now?: () => Date;
}

/**
 * The seller as the owner knows them — present only when the supplier DID
 * is one of the owner's contacts. Everything here is the owner's own record
 * (their name for the seller, their trust level, the categories they prefer
 * the seller for), never the seller's claim about itself.
 */
export interface OfferContact {
  name: string;
  trustLevel: Contact['trustLevel'];
  preferredFor: string[];
}

/** One ranked offer, flattened for the loop to reason over (A6). */
export interface RankedProductOffer {
  supplierDid: string;
  contact?: OfferContact;
  /** The listing's indicative price in MAJOR units, e.g. "INR 4499.00". */
  price: string;
  /** The money-free rank score, 0..10000 (price / lead time / trust). */
  scoreBp: number;
  leadTimeDays?: number;
  /** PeerLens seller trust, 0..100. Absent means no history — not zero. */
  trustPercent?: number;
  serviceUri?: string;
}

export interface UnpricedListing extends UnpricedCatalogRow {
  contact?: OfferContact;
}

export interface SearchProductsResult {
  /**
   * Handle for `recommend_offer` — names this research for the rest of the
   * turn. Absent when there is nothing to recommend (outage, no listings).
   */
  researchId?: string;
  /** The comparison card (money-free hand-off). Absent only on a discovery outage. */
  card?: ComparisonCard;
  /** The ranked offers, for the loop to weigh against the user's preferences. */
  ranked: RankedProductOffer[];
  /** Suppliers listing the product but stating no price. */
  unpriced: UnpricedListing[];
  /** Where-to-buy links for every candidate (money-free). */
  handoff: HandoffLink[];
  note?: string;
  /** True when a discovery call THREW — an outage, not "no offers". */
  failed?: boolean;
}

const DEFAULT_RESULT_LIMIT = 20;
/** Placeholder currency when nothing priced anchors a comparison — no offer
 *  quotes in it, so it forces the honest "no valid candidates" answer. */
const NO_CURRENCY = 'XXX';

/** What `recommend_offer` needs back from a `search_products` run. */
interface ResearchRecord {
  request: Parameters<typeof buildComparisonCard>[0]['request'];
  ranking: ReturnType<typeof rankOffers>;
  handoff: HandoffLink[];
  sellerNames: Record<string, string>;
  /** Every supplier the research holds — ranked or unpriced — for set-aside checks. */
  supplierDids: Set<string>;
  storedAtMs: number;
}

/** Bounded, short-lived: a turn's research, not a store. */
export const RESEARCH_CACHE_MAX = 16;
export const RESEARCH_TTL_MS = 15 * 60_000;

/** The research `search_products` holds for `recommend_offer`, by id. */
export interface ResearchCache {
  remember(record: ResearchRecord): string;
  recall(id: string): ResearchRecord | null;
}

/**
 * One cache per pipeline. Bounded (the oldest research is forgotten past
 * `RESEARCH_CACHE_MAX`) and short-lived (`RESEARCH_TTL_MS`), evicting expired
 * entries on every write. Ids are unguessable enough for their purpose — a
 * handle the model echoes back within one process — and never a secret.
 */
export function createResearchCache(now: () => Date = () => new Date()): ResearchCache {
  const cache = new Map<string, ResearchRecord>();
  let sequence = 0;
  return {
    remember(record) {
      // Evict by age first, then the oldest — a Map iterates in insertion order.
      for (const [id, entry] of cache) {
        if (now().getTime() - entry.storedAtMs > RESEARCH_TTL_MS) cache.delete(id);
      }
      while (cache.size >= RESEARCH_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      sequence += 1;
      const id = `research_${String(sequence)}_${Math.random().toString(36).slice(2, 8)}`;
      cache.set(id, record);
      return id;
    },
    recall(id) {
      const entry = cache.get(id);
      if (entry === undefined) return null;
      if (now().getTime() - entry.storedAtMs > RESEARCH_TTL_MS) {
        cache.delete(id);
        return null;
      }
      return entry;
    },
  };
}

export interface ProductResearchTools {
  searchProducts: AgentTool;
  recommendOffer: AgentTool;
}

/**
 * Build both research tools over one cache, so `recommend_offer` can only name
 * offers `search_products` found recently in this pipeline.
 */
export function createProductResearchTools(options: SearchProductsToolOptions): ProductResearchTools {
  const now = options.now ?? ((): Date => new Date());
  const cache = options.cache ?? createResearchCache(now);
  return {
    searchProducts: buildSearchProductsTool(options, now, (record) => cache.remember(record)),
    recommendOffer: buildRecommendOfferTool((id) => cache.recall(id)),
  };
}

function buildSearchProductsTool(
  options: SearchProductsToolOptions,
  now: () => Date,
  remember: (record: ResearchRecord) => string,
): AgentTool {
  const { appViewClient, core, logger } = options;
  const resultLimit = options.resultLimit ?? DEFAULT_RESULT_LIMIT;

  return {
    name: 'search_products',
    description:
      "Find and compare offers for a PRODUCT across suppliers on the Dina network, ranked by price, lead time and seller trust — money-free. Use for 'best X for me', 'compare prices for X', 'where can I buy X'. Pass `query` (free text) and/or `identifiers` (product ids like a GTIN, `gtin:08901234567890`). Returns the ranked offers (price in major units, seller trust as a percentage, and — when the seller is one of the user's contacts — the user's own name, trust level and preferred_for categories for them), a comparison card (recommended supplier + alternatives + what can't be compared), where-to-buy links, and a research_id. The ranked order is a money-free baseline; once you have weighed the offers against the user's stated preferences, call recommend_offer with the research_id so the card the user sees matches your answer. It never completes a purchase.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text product query, e.g. "oak dining chair".' },
        identifiers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Product identifiers, each `scheme:value[:issuer_did]` (e.g. `gtin:08901234567890`).',
        },
        category: { type: 'string', description: 'A category id to narrow discovery.' },
        region: {
          type: 'string',
          description: 'Restrict to suppliers who fulfil into this region (e.g. "iso-3166-2:IN-KA").',
        },
        quantity: {
          type: 'object',
          description: 'How many, e.g. {"value":"100","unit_code":"each"}. Defaults to one unit.',
          properties: { value: { type: 'string' }, unit_code: { type: 'string' } },
        },
        currency: {
          type: 'string',
          description: 'The currency to compare in (ISO-4217). Defaults to what the suppliers quote.',
        },
      },
      // "query or identifiers" is enforced in execute (JSON Schema can't say it).
      required: [],
    },
    async execute(args): Promise<SearchProductsResult> {
      const query = typeof args.query === 'string' && args.query !== '' ? args.query : undefined;
      const identifiers = Array.isArray(args.identifiers)
        ? args.identifiers.filter((x): x is string => typeof x === 'string' && x !== '')
        : undefined;
      if (query === undefined && (identifiers === undefined || identifiers.length === 0)) {
        throw new Error('search_products: pass at least one of `query` or `identifiers`');
      }
      const category =
        typeof args.category === 'string' && args.category !== '' ? args.category : undefined;
      const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined;
      const requestedQuantity = parseQuantity(args.quantity);

      let candidates: CommerceCatalogCandidate[];
      try {
        candidates = await appViewClient.searchCatalog({
          ...(query !== undefined ? { q: query } : {}),
          ...(identifiers !== undefined && identifiers.length > 0 ? { identifiers } : {}),
          ...(category !== undefined ? { categories: [category] } : {}),
          ...(region !== undefined ? { region } : {}),
          limit: resultLimit,
        });
      } catch (err) {
        logger?.({ event: 'search_products.discovery_failed', error: (err as Error).message });
        return {
          ranked: [],
          unpriced: [],
          handoff: [],
          note: 'Product discovery is unavailable right now.',
          failed: true,
        };
      }

      // Nobody lists it — an honest empty result, NOT an empty card. Building a
      // card here would render a "no offer met the requirements" bubble that
      // reads as "your filters rejected everything" when the truth is "no
      // supplier stocks it" (§5.A2). Omit the card, as the outage path does.
      if (candidates.length === 0) {
        return {
          ranked: [],
          unpriced: [],
          handoff: [],
          note: 'No supplier lists this product on the Dina network yet.',
        };
      }

      // Free-text discovery returns DIFFERENT products — "best oak chair" also
      // matches stools. Ranking heterogeneous products as if they competed would
      // let a cheaper DIFFERENT item win, the opposite of diligent research. So
      // anchor on the best-matching product (the top retrieval score) and
      // compare only offers FOR THAT PRODUCT across suppliers (§5.A: "offers for
      // a PRODUCT"). Cross-seller comparability REQUIRES a shared product
      // identity; candidates for other products are set aside and reported, not
      // ranked in.
      const { kept, otherProductCount } = focusOnBestProduct(candidates);

      // A product's suppliers normally quote in ONE currency; any offer in
      // another is honestly reported as incomparable rather than converted
      // (§9.1). Region has already narrowed discovery, so it is NOT re-applied
      // as a ranking filter — the wire region string and the offer's
      // `scheme:value` form differ, and the AppView already enforced it.
      const firstPriced = kept.find((c) => c.indicativePrice !== undefined);
      const currency =
        (typeof args.currency === 'string' && args.currency !== '' ? args.currency : undefined) ??
        firstPriced?.indicativePrice?.currency ??
        NO_CURRENCY;

      const bridged = catalogCandidatesToOffers(kept.map(toBridgeInput), requestedQuantity);
      const { offers, unpriced, collapsedListings } = oneListingPerSupplier(bridged.offers, bridged.unpriced);

      // The owner's own knowledge of each seller (A6): a DID that is one of
      // their contacts carries the name they use, their trust level and the
      // categories they prefer that contact for. Looked up a few at a time so a
      // wide research does not burst the per-DID limiter on the server split.
      // A client that THROWS is logged by DID and the seller stays unnamed;
      // both production transports answer null on a transport fault (their
      // `contactLookup` contract), which this tool cannot tell from a stranger.
      const supplierDids = [...new Set([...offers.map((o) => o.supplierDid), ...unpriced.map((u) => u.supplierDid)])];
      const contacts = await lookupContacts(core, supplierDids, logger);
      const sellerNames: Record<string, string> = {};
      for (const [did, contact] of contacts) sellerNames[did] = contact.name;
      const withContact = <T extends { supplierDid: string }>(row: T): T & { contact?: OfferContact } => {
        const contact = contacts.get(row.supplierDid);
        return contact === undefined ? row : { ...row, contact };
      };

      // One where-to-buy link per supplier — the listing that survived.
      const serviceUriBySupplier = new Map<string, string>();
      for (const o of offers) {
        const c = kept.find((k) => catalogOfferIdMatches(k, o.quoteId));
        if (c !== undefined) serviceUriBySupplier.set(o.supplierDid, c.serviceUri);
      }
      for (const u of unpriced) serviceUriBySupplier.set(u.supplierDid, u.serviceUri);
      const handoff: HandoffLink[] = supplierDids.map((did) => ({
        supplierDid: did,
        serviceUri: serviceUriBySupplier.get(did) ?? '',
        ...(sellerNames[did] !== undefined ? { sellerName: sellerNames[did] } : {}),
      }));

      const trust = await fetchSellerTrustBp(
        appViewClient,
        offers.map((o) => o.supplierDid),
        logger,
      );
      const withTrust: Offer[] = offers.map((o) => {
        const bp = trust.get(o.supplierDid);
        return bp === undefined ? o : { ...o, trustBp: bp };
      });

      const requirements: BuyerRequirements = { quantity: requestedQuantity, currency };
      const ranking = rankOffers(withTrust, requirements, now().toISOString());

      const request = {
        label: query ?? (identifiers !== undefined ? identifiers.join(', ') : 'product'),
        quantity: requestedQuantity,
      };
      const card = buildComparisonCard({ request, ranking, mode: 'handoff', handoff, sellerNames });
      const researchId = remember({
        request,
        ranking,
        handoff,
        sellerNames,
        supplierDids: new Set(supplierDids),
        storedAtMs: now().getTime(),
      });

      const ranked: RankedProductOffer[] = ranking.ranked.map((r) => {
        const serviceUri = serviceUriBySupplier.get(r.offer.supplierDid);
        return withContact({
          supplierDid: r.offer.supplierDid,
          price: formatMoney({ currency: r.offer.currency, minor_units: r.offer.totalMinorUnits }),
          scoreBp: r.scoreBp,
          ...(r.offer.leadTimeDays !== undefined ? { leadTimeDays: r.offer.leadTimeDays } : {}),
          ...(r.offer.trustBp !== undefined ? { trustPercent: Math.round(r.offer.trustBp / 100) } : {}),
          ...(serviceUri !== undefined ? { serviceUri } : {}),
        });
      });

      return {
        researchId,
        card,
        ranked,
        unpriced: unpriced.map(withContact),
        handoff,
        ...(otherProductCount > 0 || collapsedListings > 0
          ? {
              note: [
                otherProductCount > 0
                  ? `Set ${String(otherProductCount)} listing(s) for other products aside — compared only the closest match across suppliers.`
                  : '',
                collapsedListings > 0
                  ? `Kept one listing per supplier — ${String(collapsedListings)} duplicate listing(s) folded into their supplier's best price.`
                  : '',
              ]
                .filter((line) => line !== '')
                .join(' '),
            }
          : {}),
      };
    },
  };
}

/** What `recommend_offer` hands back — the card the bridge posts, and the pick. */
export interface RecommendOfferResult {
  card: ComparisonCard;
  recommended: string | null;
  note: string;
}

const MAX_REASON_CHARS = 240;

function buildRecommendOfferTool(recall: (id: string) => ResearchRecord | null): AgentTool {
  return {
    name: 'recommend_offer',
    description:
      "Commit your recommendation from a search_products result so the card the user sees matches your answer. Pass the research_id, the supplier_did you recommend (omit it when the user's preferences rule every offer out), a one-line reason in the user's own terms (their budget, their rule about sellers, a seller they swore off), and set_aside for offers their preferences excluded. Names only offers the research holds; it never changes a price or a score.",
    parameters: {
      type: 'object',
      properties: {
        research_id: { type: 'string', description: 'research_id from search_products.' },
        supplier_did: {
          type: 'string',
          description: 'The recommended offer, by supplier DID. Omit when no offer fits the user’s preferences.',
        },
        reason: {
          type: 'string',
          description: "Why, in the user's terms — one line, e.g. 'your rule: a proven seller over the cheapest'.",
        },
        set_aside: {
          type: 'array',
          description: "Offers the user's preferences excluded, each with its reason.",
          items: {
            type: 'object',
            properties: { supplier_did: { type: 'string' }, reason: { type: 'string' } },
            required: ['supplier_did', 'reason'],
          },
        },
      },
      required: ['research_id', 'reason'],
    },
    async execute(args): Promise<RecommendOfferResult> {
      const researchId = typeof args.research_id === 'string' ? args.research_id : '';
      const research = researchId === '' ? null : recall(researchId);
      if (research === null) {
        throw new Error('recommend_offer: unknown or expired research_id — call search_products again');
      }
      const reason = oneLine(args.reason);
      if (reason === '') throw new Error('recommend_offer: reason is required');
      const supplierDid =
        typeof args.supplier_did === 'string' && args.supplier_did.trim() !== '' ? args.supplier_did.trim() : undefined;
      if (supplierDid !== undefined && !research.ranking.ranked.some((r) => r.offer.supplierDid === supplierDid)) {
        throw new Error(`recommend_offer: ${supplierDid} is not among the ranked offers of this research`);
      }
      // Bounded by construction: one entry per supplier the research holds, no
      // repeats — the card renders one "Set aside" line per entry, and an
      // unbounded list would push the price and the where-to-buy links past the
      // CardSpec block cap.
      const setAside: NonNullable<ComparisonChoice['setAside']> = [];
      if (args.set_aside !== undefined) {
        if (!Array.isArray(args.set_aside)) throw new Error('recommend_offer: set_aside must be an array');
        if (args.set_aside.length > research.supplierDids.size) {
          throw new Error(
            `recommend_offer: set_aside lists ${String(args.set_aside.length)} entries for ${String(research.supplierDids.size)} suppliers`,
          );
        }
        const seen = new Set<string>();
        for (const entry of args.set_aside) {
          const row = (entry ?? {}) as Record<string, unknown>;
          const did = typeof row.supplier_did === 'string' ? row.supplier_did.trim() : '';
          const why = oneLine(row.reason);
          if (did === '' || why === '') throw new Error('recommend_offer: each set_aside entry needs supplier_did and reason');
          if (!research.supplierDids.has(did)) {
            throw new Error(`recommend_offer: set_aside names ${did}, which this research does not hold`);
          }
          if (did === supplierDid) throw new Error('recommend_offer: the recommended offer cannot also be set aside');
          if (seen.has(did)) throw new Error(`recommend_offer: set_aside names ${did} twice`);
          seen.add(did);
          setAside.push({ supplierDid: did, reason: why });
        }
      }
      const choice: ComparisonChoice = {
        ...(supplierDid !== undefined ? { supplierDid } : {}),
        reason,
        ...(setAside.length > 0 ? { setAside } : {}),
      };
      const card = buildComparisonCard({
        request: research.request,
        ranking: research.ranking,
        mode: 'handoff',
        handoff: research.handoff,
        sellerNames: research.sellerNames,
        choice,
      });
      // The card is for the chat bridge (it posts the LAST research card); the
      // note steers the model back to the substance — a first run had it
      // narrate "the card now shows…" instead of answering.
      return {
        card,
        recommended: supplierDid ?? null,
        note: 'Recorded. Now answer the user in full — the offers, your pick and its price (or that nothing fits), and the reasons in their own terms. Do not describe this card or this tool; the user sees the card beside your words.',
      };
    },
  };
}

/**
 * One bounded line of the model's text — no control characters, no bidi
 * overrides (a reversed "Chosen for" line would misread on the card), no essay.
 */
function oneLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_REASON_CHARS)
  );
}

/**
 * Resolve each supplier DID to the owner's contact, when they have one.
 * `contactLookup` matches a DID exactly (then display name, then alias) and
 * answers `null` for a stranger. A thrown lookup is logged by DID and
 * skipped: the seller stays unnamed, the offer stays in the list.
 */
/** How many contact lookups run at once — a wide research must not burst the limiter. */
const CONTACT_LOOKUP_CONCURRENCY = 4;

async function lookupContacts(
  core: ProductToolCoreClient,
  dids: readonly string[],
  logger?: (event: Record<string, unknown>) => void,
): Promise<Map<string, OfferContact>> {
  const out = new Map<string, OfferContact>();
  const queue = [...new Set(dids)];
  const worker = async (): Promise<void> => {
    for (let did = queue.shift(); did !== undefined; did = queue.shift()) {
      try {
        const contact = await core.contactLookup(did);
        if (contact === null || contact.did !== did) continue;
        out.set(did, {
          name: contact.displayName,
          trustLevel: contact.trustLevel,
          preferredFor: [...(contact.preferredFor ?? [])],
        });
      } catch (err) {
        logger?.({ event: 'search_products.contact_lookup_failed', did, error: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONTACT_LOOKUP_CONCURRENCY, queue.length) }, worker));
  return out;
}

/** Does this candidate's synthetic offer id match the offer the bridge built from it? */
function catalogOfferIdMatches(candidate: CommerceCatalogCandidate, quoteId: string): boolean {
  return quoteId === catalogOfferId(toBridgeInput(candidate));
}

/** Read the quantity from tool args, defaulting to one unit — the consumer
 *  default for "compare prices for X". */
function parseQuantity(raw: unknown): Quantity {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (
      typeof r.value === 'string' &&
      r.value !== '' &&
      typeof r.unit_code === 'string' &&
      r.unit_code !== ''
    ) {
      return { value: r.value, unit_code: r.unit_code };
    }
  }
  return { value: '1', unit_code: 'each' };
}

/**
 * Keep only the candidates for the single best-matching product, so cross-seller
 * comparison compares like with like (§5.A). The best text/identifier match (the
 * highest `retrievalScoreBp`) names the product the owner meant; its product
 * identity (`scheme:value`) is the cluster. Candidates for other products are
 * counted out — reported honestly, never ranked against the target. Callers must
 * guard `candidates.length > 0`. (When suppliers share no product identity, only
 * the top match survives; that is correct — offers you cannot prove are the same
 * product are not comparable.)
 */
function focusOnBestProduct(candidates: CommerceCatalogCandidate[]): {
  kept: CommerceCatalogCandidate[];
  otherProductCount: number;
} {
  const key = (c: CommerceCatalogCandidate): string => `${c.product.scheme}:${c.product.value}`;
  let best = candidates[0];
  for (const c of candidates) {
    if ((c.retrievalScoreBp ?? 0) > (best.retrievalScoreBp ?? 0)) best = c;
  }
  const target = key(best);
  const kept = candidates.filter((c) => key(c) === target);
  return { kept, otherProductCount: candidates.length - kept.length };
}

function toBridgeInput(c: CommerceCatalogCandidate): CatalogOfferInput {
  return {
    supplierDid: c.supplierDid,
    serviceUri: c.serviceUri,
    productScheme: c.product.scheme,
    productValue: c.product.value,
    catalogSnapshotRef: c.catalogSnapshotRef,
    ...(c.indicativePrice !== undefined ? { indicativePrice: c.indicativePrice } : {}),
    fulfilmentRegions: c.fulfilmentRegions,
    ...(c.validUntil !== undefined ? { validUntil: c.validUntil } : {}),
  };
}
