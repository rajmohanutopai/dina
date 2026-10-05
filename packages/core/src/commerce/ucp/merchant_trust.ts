/**
 * A UCP shop's PeerLens trust, and the order products are shown in (UCP plan
 * §3.7, §4.2 U1). One reading for every surface: the owner's card reads it
 * through Core (`GET /v1/owner/ucp/searches/:id/trust`), never from Brain;
 * Brain's tool reads its own lookups the same way.
 *
 * A shop is looked up by its origin as an organization. The answer is one of
 * three states: rated (people reviewed it, or PeerLens advises against it),
 * unrated (PeerLens knows no reviews), or unavailable (the lookup failed,
 * took too long, or no PeerLens was asked). The last two read differently to
 * the owner and rank the same.
 *
 * Products go best-trusted shop first, then cheapest first within a currency
 * (prices in different currencies are never compared), then in the order the
 * shop gave. Nothing a shop wrote about itself moves a product (Verified Truth).
 *
 * The host installs the lookup (a trusted AppView client), as it does A2A's
 * directory evidence; with none installed every shop reads `unavailable`.
 */

export type MerchantTrust =
  | { state: 'rated'; recommendation: string; level: string; reviews: number }
  | { state: 'unrated' }
  | { state: 'unavailable' };

/** The fields of AppView's `com.dinakernel.peerlens.resolve` answer the reading uses. */
export interface ResolveAnswer {
  trustLevel: unknown;
  recommendation: unknown;
  attestationSummary?: { total?: unknown } | null;
}

/** How long one shop's lookup may take before it reads "unavailable". */
export const UCP_TRUST_TIMEOUT_MS = 3_000;

/** The PeerLens subject a shop is looked up as. */
export function merchantTrustSubject(origin: string): string {
  return JSON.stringify({ type: 'organization', uri: origin });
}

/** A resolve answer read as a trust state; null (no answer) is unavailable. */
export function readMerchantTrust(answer: ResolveAnswer | null): MerchantTrust {
  // No answer, an error, or a stand-in AppView with no data (`no_data`): PeerLens was not asked.
  if (answer === null || answer.recommendation === 'error' || answer.recommendation === 'no_data')
    return { state: 'unavailable' };
  if (typeof answer.recommendation !== 'string') return { state: 'unavailable' };
  const total = answer.attestationSummary?.total;
  const reviews = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 0;
  // Advised against with no reviews (a shop moderators removed, or one flagged): never "unrated".
  if (reviews === 0 && answer.recommendation !== 'avoid') return { state: 'unrated' };
  return {
    state: 'rated',
    recommendation: answer.recommendation,
    level: String(answer.trustLevel),
    reviews,
  };
}

/** Ask `lookup` for one shop, bounded by `timeoutMs`; never throws. */
export async function lookupMerchantTrust(
  lookup: (subject: string) => Promise<ResolveAnswer>,
  origin: string,
  timeoutMs: number = UCP_TRUST_TIMEOUT_MS,
): Promise<MerchantTrust> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      lookup(merchantTrustSubject(origin)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return readMerchantTrust(answer);
  } catch {
    return { state: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The host's PeerLens resolve: the answer for a subject; throws when AppView cannot answer. */
export type MerchantTrustSource = (subject: string) => Promise<ResolveAnswer>;

let source: MerchantTrustSource | null = null;

export function installUcpMerchantTrust(next: MerchantTrustSource | null): void {
  source = next;
}

/** Each shop's trust, looked up at once through the installed source. */
export async function merchantTrust(
  origins: readonly string[],
  timeoutMs: number = UCP_TRUST_TIMEOUT_MS,
): Promise<Map<string, MerchantTrust>> {
  const unique = [...new Set(origins)];
  const lookup = source;
  const trust = await Promise.all(
    unique.map(
      (o): Promise<MerchantTrust> =>
        lookup === null
          ? Promise.resolve({ state: 'unavailable' })
          : lookupMerchantTrust(lookup, o, timeoutMs),
    ),
  );
  return new Map(unique.map((o, i) => [o, trust[i] as MerchantTrust]));
}

const RECOMMENDATION_RANK: Record<string, number> = { proceed: 0, caution: 1, verify: 2, avoid: 4 };
/** Below the rated shops PeerLens vouches for, above those it advises against. */
const NO_RATING_RANK = 3;

/** A trust state's place in the order: lower is shown first. */
export function trustRank(trust: MerchantTrust | undefined): number {
  return trust?.state === 'rated'
    ? (RECOMMENDATION_RANK[trust.recommendation] ?? NO_RATING_RANK)
    : NO_RATING_RANK;
}

/** A price in minor units as a bigint; null when it is not a whole number. */
function minorOf(amount: string): bigint | null {
  return /^-?\d{1,30}$/.test(amount) ? BigInt(amount) : null;
}

/**
 * Items best-trusted shop first, then cheapest first within a currency, then
 * as given. `priceOf` is the item's lowest price in minor units.
 */
export function bestFirst<T>(
  items: readonly T[],
  shopOf: (item: T) => string,
  priceOf: (item: T) => { amount: string; currency: string },
  trustOf: (shop: string) => MerchantTrust | undefined,
): T[] {
  return items
    .map((item, i) => ({ item, i, rank: trustRank(trustOf(shopOf(item))), price: priceOf(item) }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.price.currency !== b.price.currency)
        return a.price.currency < b.price.currency ? -1 : 1;
      const pa = minorOf(a.price.amount);
      const pb = minorOf(b.price.amount);
      if (pa !== null && pb !== null && pa !== pb) return pa < pb ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ item }) => item);
}
