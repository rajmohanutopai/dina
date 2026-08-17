/**
 * Line resolution (PHOTO_COMMERCE_LANES_DESIGN §5.2): "the 4ft teak ones"
 * is not a `ProductRef`. Each line resolves against catalogs the buyer can
 * see — known suppliers first, then discovery — producing candidates the
 * buyer picks from.
 *
 * THE EGRESS CONTRACT, stated here because resolution runs BEFORE confirm,
 * on unvouched photo-derived text (the same page that can carry a name or
 * a phone number the model copied into a line):
 *
 *   - KNOWN-SUPPLIER resolution matches LOCALLY, against fetched,
 *     digest-verified catalog pages. Nothing leaves the node — the
 *     matcher below is a pure function over bytes already here.
 *   - DISCOVERY queries carry CLOSED FIELDS ONLY by default (§9.6's v1
 *     default). `discoveryRequirementsFor` takes NO text parameter — the
 *     structural property, not a filter: raw extracted line text cannot
 *     reach a discovery query through this module because no signature
 *     accepts it. §9.6's owner-opt-in `query_text` path (Core projection,
 *     structured scrub, owner-visible outbound view) is the buyer
 *     surface's work and never runs before the owner has seen the line.
 *
 * EVIDENCE IS HYDRATED AUTHORITY-FIRST. A fabricated pointer→snapshot→
 * page→item chain recomputes perfectly for any supplier_did an attacker
 * writes into it, so the injected verifier confirms the retained pointer
 * really is the record the named supplier's repo published BEFORE any
 * digest is checked — and false and thrown are the same answer.
 */

import {
  verifyCatalogEvidenceRecord,
  type CatalogEvidenceRecord,
  type CatalogItem,
  type CatalogPointerAuthorityVerifier,
  type ProductSearchRequirements,
  type Quantity,
  type Sha256Fn,
} from '@dina/commerce-protocol';

// ---------------------------------------------------------------------------
// Local matching (known suppliers — nothing leaves the node)
// ---------------------------------------------------------------------------

export interface VerifiedCatalogPageSet {
  /** The supplier whose repo the evidence context names. */
  supplierDid: string;
  /** Already known to the buyer (a contact)? Unknown suppliers surface
   *  FLAGGED and are never auto-selected — the owner's decision. */
  knownSupplier: boolean;
  /** The §2.1 evidence context, one record per item's page — built by the
   *  fetch path that verified the chain. */
  evidenceByItemIndex: (index: number) => CatalogEvidenceRecord | null;
  items: readonly CatalogItem[];
}

export interface ResolutionCandidate {
  item: CatalogItem;
  supplierDid: string;
  flaggedNewSupplier: boolean;
  evidence: CatalogEvidenceRecord | null;
  /** Token-overlap score in [0, 1] — deterministic, no LLM in this path. */
  score: number;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * Deterministic token-overlap matching of a line's PARSED HINTS against a
 * verified item set. The hints are the model's structured reading, not the
 * raw text — and either way this function transmits nothing.
 */
export function matchLineAgainstCatalog(
  hint: string,
  pages: VerifiedCatalogPageSet,
  options: { threshold?: number } = {},
): ResolutionCandidate[] {
  const threshold = options.threshold ?? 0.5;
  const hintTokens = new Set(tokens(hint));
  if (hintTokens.size === 0) return [];
  const candidates: ResolutionCandidate[] = [];
  pages.items.forEach((item, index) => {
    const haystack = tokens(`${item.name} ${String((item as { description?: string }).description ?? '')}`);
    if (haystack.length === 0) return;
    let matched = 0;
    for (const token of hintTokens) {
      if (haystack.includes(token)) matched += 1;
    }
    const score = matched / hintTokens.size;
    if (score >= threshold) {
      candidates.push({
        item,
        supplierDid: pages.supplierDid,
        flaggedNewSupplier: !pages.knownSupplier,
        evidence: pages.evidenceByItemIndex(index),
        score,
      });
    }
  });
  return candidates.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Discovery projection (closed fields ONLY — the structural guarantee)
// ---------------------------------------------------------------------------

/**
 * Build §9.6 requirements from CLOSED FIELDS. There is deliberately no
 * text parameter: the fail-closed property is the signature, and the test
 * that raw extracted line text cannot reach a discovery query outside the
 * §9.6 opt-in path pins it.
 */
export function discoveryRequirementsFor(args: {
  categoryIds?: readonly string[];
  quantity?: Quantity;
  requiredBy?: string;
}): ProductSearchRequirements {
  const requirements: ProductSearchRequirements = {};
  if (args.categoryIds !== undefined && args.categoryIds.length > 0) {
    requirements.category_ids = [...args.categoryIds];
  }
  if (args.quantity !== undefined) requirements.quantity = args.quantity;
  if (args.requiredBy !== undefined) requirements.required_by = args.requiredBy;
  return requirements;
}

// ---------------------------------------------------------------------------
// Evidence hydration — authority FIRST, then the chain
// ---------------------------------------------------------------------------

export type EvidenceHydration =
  | { ok: true; record: CatalogEvidenceRecord }
  | { ok: false; refusal: string };

export async function hydrateOrderLineEvidence(
  record: CatalogEvidenceRecord,
  verifyAuthority: CatalogPointerAuthorityVerifier,
  sha256: Sha256Fn,
): Promise<EvidenceHydration> {
  // AUTHORITY BEFORE ANY DIGEST: internal consistency proves nothing
  // about who published the chain.
  let authentic = false;
  try {
    authentic = await verifyAuthority({
      repo_did: record.repo_did,
      collection: record.collection,
      rkey: record.rkey,
      pointer_cid: record.pointer_cid,
      pointer: record.pointer,
    });
  } catch {
    // A verifier that throws has verified nothing — the same fail-closed
    // reading the presence verifier gives a broken backend.
    return { ok: false, refusal: 'authority_unverifiable' };
  }
  if (!authentic) {
    return { ok: false, refusal: 'supplier_authority_failed' };
  }
  const chain = verifyCatalogEvidenceRecord(record, sha256);
  if (chain !== null) return { ok: false, refusal: chain };
  return { ok: true, record };
}
