import { checkRelationshipClaim } from '@/shared/commerce/wire_shape.js';
import { and, eq, sql } from 'drizzle-orm';

import {
  commerceCatalogProducts,
  commerceProductRelationships,
  commerceRelationshipClaims,
} from '@/db/schema/index.js';
import { productKey } from '@/shared/commerce/catalog-projection.js';
import {
  claimConfidenceBp,
  projectRelationships,
  type EdgeSource,
  type RelationshipClaimShape,
} from '@/shared/commerce/relationship-projection.js';

import type { HandlerContext, RecordHandler, RecordOp } from './index.js';

/**
 * Jetstream handler for `com.dinakernel.commerce.relationshipClaim` (§10.7).
 *
 * STORE THE CLAIM, THEN DERIVE THE EDGES FOR ITS SUBJECT. Not "update the edge
 * in place": a dispute has to be able to DISAPPEAR when the claim that caused
 * it is withdrawn, and an edge mutated in place cannot un-dispute itself
 * without re-reading the claims anyway. Deriving from the claim table is the
 * only version of this that survives a deletion.
 *
 * WHO IS A FIRST PARTY. A publisher speaking about an identity THEY ISSUED.
 * A supplier saying "my CHAIR-2 is a variant of my CHAIR-1" is first-party; the
 * same claim in a rival's repo is third-party, and the rival cannot promote it
 * by saying so. `source` is derived from `op.did` — the authenticated repo —
 * against the SUBJECT's issuer, never read from the record, because a
 * self-declared trust level is not evidence. See `readSource` for why matching
 * the repo against the claim's own `issuer_did` was not enough.
 */

function objectKeyOf(object: RelationshipClaimShape['object']): string {
  return 'did' in object ? `did:${object.did}` : productKey(object);
}

/**
 * An inference must SAY it is one, and name its model version (§10.7).
 *
 * FIRST PARTY MEANS AUTHORITY OVER THE SUBJECT, not authorship of the claim.
 *
 * The rule this replaces was `repoDid === issuerDid`, which every publisher
 * satisfies for free: set `issuer_did` to yourself, publish a claim about ANY
 * product, and the edge is `first_party_claim` at 9500 basis points — enough
 * to pass the standing predicate and pull another manufacturer's reputation
 * onto your own product. The comment above this function always said the right
 * thing ("a supplier saying MY CHAIR-2 is a variant of MY CHAIR-1"); the word
 * doing the work was "my", and nothing checked it.
 *
 * What CAN be established from the record itself: a scoped ProductRef
 * (`manufacturer_sku`, `custom`) carries `issuer_did` — the party that issued
 * that identity, and §9.3 requires it precisely so an identifier is attributable.
 * When the publishing repo IS that party, they are speaking about an identity
 * they own, and that is first party.
 *
 * A `gtin` or `dina_subject` names no issuer — GS1 issued it, not the
 * publisher — so the record alone says nothing about who may speak for it.
 *
 * STANDING IS RELATIONSHIP-SPECIFIC, and the previous version of this function
 * got that wrong in a way the spec names outright. It granted first party to
 * any repo holding a verified catalog row for the subject, which is the
 * explicit §24 non-goal: "Making public catalog presence equivalent to supplier
 * verification." A reseller who lists a product would have spoken with the
 * manufacturer's authority about its FORMULATION or what it REPLACES — claims
 * they have no standing to make — at 9500 basis points, clearing the
 * substitution threshold.
 *
 * What a verified catalog row DOES prove is that this repo sells the thing. So
 * it supports exactly one relationship, `sold_by`, and nothing else. Authority
 * over a product LINE — manufacturer, brand, formulation, packaging lineage,
 * replacement — comes only from having issued the identity itself, which a
 * scoped `ProductRef` carries and a GTIN does not.
 *
 * Everything else is THIRD party. It is still indexed and still shown; it
 * simply does not carry the weight of the owner's own word. Failing closed
 * matters here because the cost of guessing wrong is inherited standing —
 * another manufacturer's reputation landing on your product page.
 */
function readSource(args: {
  record: Record<string, unknown>;
  repoDid: string;
  claim: RelationshipClaimShape;
  /** The repo has a verified, indexed catalog row for the subject product. */
  publisherSuppliesSubject: boolean;
}): EdgeSource {
  if (args.record.inference_version !== undefined) return 'inferred';
  // The claim must at least be published by the party it names as issuer.
  if (args.repoDid !== args.claim.issuer_did) return 'third_party_claim';

  // ISSUED THE IDENTITY: authority over the product itself, so first party for
  // any relationship it cares to assert about it.
  const subjectIssuer = args.claim.subject.issuer_did;
  if (typeof subjectIssuer === 'string' && subjectIssuer !== '') {
    return subjectIssuer === args.repoDid ? 'first_party_claim' : 'third_party_claim';
  }

  // SELLS IT: authority over the selling relationship, and only that one.
  if (args.publisherSuppliesSubject && args.claim.relationship === 'sold_by') {
    return 'first_party_claim';
  }
  return 'third_party_claim';
}

/**
 * Rebuild every edge whose subject this claim touches.
 *
 * Scoped to ONE subject rather than the whole graph: relationships are keyed
 * by subject, so no other subject's edges can change because of this claim,
 * and rebuilding the world on every record would make ingest quadratic.
 */
async function rebuildSubject(ctx: HandlerContext, subjectKey: string): Promise<void> {
  // RE-CHECKED ON THE WAY BACK OUT. The create path gates every claim, but this
  // re-derives edges from `claim_json` READ FROM THE DATABASE, and it runs on
  // every later claim or deletion touching the subject. So the invariant the
  // projection relies on — "this passed the gate" — is established at one
  // boundary and consumed at two, and would hold only for rows written after
  // the gate existed. Re-checking here makes the guarantee local to the caller
  // that needs it rather than a fact about history.
  await ctx.db.transaction(async (tx) => {
    // SERIALISED PER SUBJECT, and the read happens INSIDE the transaction.
    //
    // The claim rows used to be read OUTSIDE the transaction that replaces the
    // edges. Production ingests concurrently up to the database pool size, so
    // two workers touching one subject could read `[A]` and `[A, B]`, and if
    // the older rebuild committed last it deleted B's edge while B's CLAIM
    // stayed durably in the table. The result is a claim whose edge simply is
    // not there — invisible until some later event on the same subject happens
    // to rebuild it, and indistinguishable from a supplier who never asserted
    // the relationship.
    //
    // `pg_advisory_xact_lock` is released when the transaction ends, so there
    // is nothing to leak on an error path, and the lock is keyed on the SUBJECT
    // so rebuilds of different subjects still run in parallel.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${subjectKey}))`);

    const rows = await tx
      .select()
      .from(commerceRelationshipClaims)
      .where(eq(commerceRelationshipClaims.subjectKey, subjectKey));

    const { edges } = projectRelationships(
      rows
        // Rows written before this gate existed, or by any future caller, are
        // skipped rather than trusted. The projection's type guarantee is now
        // local to the code that relies on it.
        .filter((row) => checkRelationshipClaim(row.claimJson) === null)
        .map((row) => ({
          claim: row.claimJson as RelationshipClaimShape,
          source: row.source as EdgeSource,
          confidenceBp: row.confidenceBp,
          assertedAt: row.assertedAt,
          ...(row.inferenceVersion === null ? {} : { inferenceVersion: row.inferenceVersion }),
        })),
    );

    // Replace, never merge: an edge that no surviving claim supports must go,
    // and a partial update would leave it behind looking believed.
    await tx
      .delete(commerceProductRelationships)
      .where(eq(commerceProductRelationships.subjectKey, subjectKey));
    if (edges.length > 0) {
      await tx.insert(commerceProductRelationships).values(
        edges.map((edge) => ({
          edgeKey: edge.edgeKey,
          subjectKey: edge.subjectKey,
          relationship: edge.relationship,
          objectKey: edge.objectKey,
          confidenceBp: edge.confidenceBp,
          disputed: edge.disputed,
          evidenceJson: edge.evidence,
        })),
      );
    }
  });
}

export const commerceRelationshipClaimHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record ?? {};

    // The catalog lane got a `malformed_item` refusal two rounds ago and this
    // lane never got its equivalent — the same asymmetry that left the pointer
    // unchecked. `objectKeyOf` does `'did' in object` on an unchecked value and
    // raises on a primitive; `productKey(claim.subject)` raises when `scheme`
    // is absent. A throw here is not a refusal: the record is neither indexed
    // nor counted, so it vanishes from the metric an operator would watch.
    const malformed = checkRelationshipClaim(record);
    if (malformed !== null) {
      ctx.metrics.incr('ingester.commerce_relationship.refused');
      return;
    }

    const claim = record as unknown as RelationshipClaimShape;

    /**
     * EXTRACTED COLUMNS ARE A PROJECTION, even on the verbatim table.
     *
     * `claim_json` is kept as the publisher sent it, deliberately — the schema
     * says so and a withdrawn claim needs the original to un-dispute an edge.
     * The columns BESIDE it are not that: they are lookup keys this index
     * writes, and a publisher sending an object for `claim_id` had it
     * serialized straight into a queryable `text` column.
     *
     * Found because the no-secrets scan looks at every column rather than the
     * ones anyone nominated — the first fix hardened the derived edge and this
     * column was two feet away.
     *
     * NO `String()` COERCION any more. The gate above now applies the
     * protocol's own rules, so `claim_id`, `issuer_did` and `relationship` are
     * already strings by the time control reaches here. Coercing them a second
     * time said the opposite — that they might not be — and a coercion is how
     * an object becomes the literal "[object Object]" in a queryable column
     * instead of a refusal.
     */
    const subjectKey = productKey(claim.subject);

    /**
     * DOES THIS REPO ACTUALLY SUPPLY THE SUBJECT?
     *
     * Read from `commerce_catalog_products`, which only holds rows whose
     * publication chain verified — so this is evidence AppView established
     * itself, not a field the claim asserts about itself.
     */
    const ownedRows = await ctx.db
      .select({ rowKey: commerceCatalogProducts.rowKey })
      .from(commerceCatalogProducts)
      .where(
        and(
          eq(commerceCatalogProducts.supplierDid, op.did),
          eq(commerceCatalogProducts.productKey, subjectKey),
        ),
      )
      .limit(1);
    const source = readSource({
      record,
      repoDid: op.did,
      claim,
      publisherSuppliesSubject: ownedRows.length > 0,
    });
    const declared = record.confidence_bp;

    /**
     * THE SUBJECT THIS RECORD USED TO NAME.
     *
     * AT create and update arrive through this same handler, so a record can
     * MOVE between subjects. Rebuilding only the incoming subject left the old
     * one holding an edge derived from a claim that no longer says it — the
     * edge outlives the assertion behind it, which is the one thing deriving
     * rather than mutating exists to prevent.
     */
    const priorRows = await ctx.db
      .select({ subjectKey: commerceRelationshipClaims.subjectKey })
      .from(commerceRelationshipClaims)
      .where(eq(commerceRelationshipClaims.uri, op.uri))
      .limit(1);
    const priorSubjectKey = priorRows[0]?.subjectKey ?? null;

    await ctx.db
      .insert(commerceRelationshipClaims)
      .values({
        uri: op.uri,
        claimId: claim.claim_id,
        issuerDid: claim.issuer_did,
        subjectKey,
        relationship: claim.relationship,
        objectKey: objectKeyOf(claim.object),
        source,
        confidenceBp: claimConfidenceBp(
          source,
          typeof declared === 'number' ? declared : undefined,
        ),
        inferenceVersion:
          typeof record.inference_version === 'string' ? record.inference_version : null,
        claimJson: claim,
        assertedAt:
          typeof record.asserted_at === 'string'
            ? record.asserted_at
            : typeof claim.effective_from === 'string'
              ? claim.effective_from
              : '',
      })
      .onConflictDoUpdate({
        target: commerceRelationshipClaims.uri,
        set: {
          // EVERY extracted column, not a subset. The previous set omitted
          // `subjectKey`, `issuerDid`, `inferenceVersion` and `assertedAt`, so
          // an updated record left four lookup columns describing the claim it
          // USED to be while `claim_json` beside them described the new one.
          claimId: claim.claim_id,
          issuerDid: claim.issuer_did,
          subjectKey,
          relationship: claim.relationship,
          objectKey: objectKeyOf(claim.object),
          source,
          confidenceBp: claimConfidenceBp(
            source,
            typeof declared === 'number' ? declared : undefined,
          ),
          inferenceVersion:
            typeof record.inference_version === 'string' ? record.inference_version : null,
          assertedAt:
            typeof record.asserted_at === 'string'
              ? record.asserted_at
              : typeof claim.effective_from === 'string'
                ? claim.effective_from
                : '',
          claimJson: claim,
        },
      });

    // BOTH subjects. The old one is rebuilt first so a move never leaves a
    // window where the claim counts for two subjects at once.
    if (priorSubjectKey !== null && priorSubjectKey !== subjectKey) {
      await rebuildSubject(ctx, priorSubjectKey);
    }
    await rebuildSubject(ctx, subjectKey);
    ctx.metrics.incr('ingester.commerce_relationship.claimed');
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // Withdrawing a claim must be able to un-dispute an edge, which is the
    // whole reason edges are derived rather than mutated.
    const rows = await ctx.db
      .select()
      .from(commerceRelationshipClaims)
      .where(eq(commerceRelationshipClaims.uri, op.uri))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return;
    await ctx.db
      .delete(commerceRelationshipClaims)
      .where(eq(commerceRelationshipClaims.uri, op.uri));
    await rebuildSubject(ctx, row.subjectKey);
    ctx.metrics.incr('ingester.commerce_relationship.withdrawn');
  },
};
