/**
 * Plural relationship resolution (§10.7, FR-A8 — WS-10.3).
 *
 * §10.7's last paragraph is the item:
 *
 *   "Plural AppViews may disagree about a relationship. Dina preserves the
 *    exact variant results and exposes material grouping disagreement instead
 *    of silently choosing whichever merge produces the highest score."
 *
 * THE FORBIDDEN RULE IS NAMED, SO THE REPLACEMENT MUST BE JUSTIFIED. "Take the
 * highest score" is banned outright. It is also the obvious implementation:
 * ask three AppViews, keep the best answer, move on. It is banned because the
 * best answer is the one most likely to be wrong in the direction that costs
 * money — a substitution authorised by whichever index was most enthusiastic.
 *
 * SO CONSENSUS IS THE FLOOR, NOT THE PEAK. An edge every consulted AppView
 * reports carries the LOWEST confidence any of them gave it: crossing a
 * threshold requires all of them to agree it is crossed. An edge only some
 * report is kept — §10.7 explicitly allows weaker semantic edges to improve
 * recall — but capped below the standing threshold, so it can be SHOWN and can
 * never inherit standing or authorise a substitution.
 *
 * NOTHING IS MERGED, EVER. Exact-variant results stay separate. A disagreement
 * is recorded as a disagreement, both sides kept, and the affected edge
 * authorises nothing until a human or stronger evidence settles it. Silently
 * choosing a winner is precisely what the spec sentence forbids, and it is
 * also unrecoverable: once two identities are one row, no later evidence
 * separates the reviews, the orders or the lineage again.
 *
 * WHAT COUNTS AS MATERIAL. Not every difference. Two AppViews reporting 3100
 * and 3300 basis points agree about everything a caller can do with the edge.
 * A disagreement is material when it CHANGES AN ANSWER: the views land on
 * different sides of a threshold, or they name different objects for a
 * relationship that can only have one. Reporting the rest would train an owner
 * to ignore the display.
 */

/**
 * The three thresholds, mirrored from the AppView projection.
 *
 * DUPLICATED ON PURPOSE, and the duplication is the point rather than a smell:
 * an AppView deploys standalone and cannot import from `@dina/core`, and Core
 * must not trust an AppView to tell it where the substitution bar is. Two
 * copies that disagree would let a compromised index lower the bar for
 * authorising a substitution by reporting its own number.
 *
 * The `relationship_resolver` test asserts these equal the AppView's, so the
 * copies cannot drift silently.
 */
export const SHOW_AS_RELATED_BP = 3000;
export const INHERIT_STANDING_BP = 6000;
export const AUTHORIZE_SUBSTITUTION_BP = 9000;

/** What one AppView says about one edge. */
export interface AppViewEdge {
  subjectKey: string;
  relationship: string;
  /** Product key, or `did:…` when the object is an operator. */
  objectKey: string;
  confidenceBp: number;
  /** True when that AppView already considers the edge internally disputed. */
  disputed: boolean;
}

/** One AppView's answer for one subject. */
export interface AppViewAnswer {
  /** Which index this came from. Kept so a disagreement can be attributed. */
  appViewDid: string;
  edges: AppViewEdge[];
}

export type DisagreementKind =
  /** The views land on different sides of a threshold. */
  | 'threshold_split'
  /** They name different objects for a relationship that has one. */
  | 'conflicting_object'
  /** Some views report the edge and others do not. */
  | 'partial_support'
  /** At least one view already calls the edge disputed internally. */
  | 'upstream_dispute';

export interface RelationshipDisagreement {
  kind: DisagreementKind;
  subjectKey: string;
  relationship: string;
  /** What each consulted view said, so an owner can see who disagrees. */
  positions: { appViewDid: string; objectKey: string | null; confidenceBp: number | null }[];
}

export interface ResolvedEdge {
  subjectKey: string;
  relationship: string;
  objectKey: string;
  /** The consensus floor, never the peak. See the module note. */
  confidenceBp: number;
  /** How many of the consulted views reported this edge. */
  supportingViews: number;
  consultedViews: number;
  /** True when this edge carries a material disagreement. */
  contested: boolean;
}

export interface ResolvedRelationships {
  edges: ResolvedEdge[];
  disagreements: RelationshipDisagreement[];
}

/**
 * Relationships that name at most ONE object per subject.
 *
 * Mirrors the AppView projection's set, for the same reason the thresholds are
 * mirrored: which relationships are single-object decides what counts as a
 * conflict, and an index that could redefine it could make a conflict
 * disappear.
 */
const SINGLE_OBJECT_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'variant_of',
  'packaging_variant_of',
  'manufactured_by',
]);

/** Which band a confidence falls in. Two edges in one band act the same. */
function band(confidenceBp: number): 0 | 1 | 2 | 3 {
  if (confidenceBp >= AUTHORIZE_SUBSTITUTION_BP) return 3;
  if (confidenceBp >= INHERIT_STANDING_BP) return 2;
  if (confidenceBp >= SHOW_AS_RELATED_BP) return 1;
  return 0;
}

function edgeKey(edge: { subjectKey: string; relationship: string; objectKey: string }): string {
  // Length-prefixed, because a subject key containing a space would otherwise
  // let two different edges collide on one string — the same failure the
  // catalog projection hit and fixed.
  const parts = [edge.subjectKey, edge.relationship, edge.objectKey];
  return parts.map((p) => `${String(p.length)}:${p}`).join('');
}

/**
 * Resolve what several AppViews said about one subject.
 *
 * `answers` is every view CONSULTED, including ones that returned nothing:
 * "two of three views report this edge" and "two of two report it" are
 * different facts, and passing only the views that answered would make them
 * indistinguishable.
 */
export function resolveRelationships(answers: AppViewAnswer[]): ResolvedRelationships {
  const consulted = answers.length;
  if (consulted === 0) return { edges: [], disagreements: [] };

  const byEdge = new Map<
    string,
    {
      edge: AppViewEdge;
      views: string[];
      lowest: number;
      bands: Set<number>;
      upstreamDisputed: boolean;
    }
  >();

  for (const answer of answers) {
    for (const edge of answer.edges) {
      const key = edgeKey(edge);
      const existing = byEdge.get(key);
      if (existing === undefined) {
        byEdge.set(key, {
          edge,
          views: [answer.appViewDid],
          lowest: edge.confidenceBp,
          bands: new Set([band(edge.confidenceBp)]),
          upstreamDisputed: edge.disputed,
        });
        continue;
      }
      existing.views.push(answer.appViewDid);
      // THE FLOOR. `Math.min`, not `Math.max` — this line is the spec sentence.
      existing.lowest = Math.min(existing.lowest, edge.confidenceBp);
      existing.bands.add(band(edge.confidenceBp));
      existing.upstreamDisputed = existing.upstreamDisputed || edge.disputed;
    }
  }

  const disagreements: RelationshipDisagreement[] = [];
  const edges: ResolvedEdge[] = [];

  for (const entry of byEdge.values()) {
    const supporting = new Set(entry.views).size;
    const partial = supporting < consulted;
    // A threshold split is material by definition: the views disagree about
    // what the edge may be USED for.
    const split = entry.bands.size > 1;

    if (split) {
      disagreements.push({
        kind: 'threshold_split',
        subjectKey: entry.edge.subjectKey,
        relationship: entry.edge.relationship,
        positions: positionsFor(answers, entry.edge),
      });
    }
    if (partial) {
      disagreements.push({
        kind: 'partial_support',
        subjectKey: entry.edge.subjectKey,
        relationship: entry.edge.relationship,
        positions: positionsFor(answers, entry.edge),
      });
    }
    if (entry.upstreamDisputed) {
      disagreements.push({
        kind: 'upstream_dispute',
        subjectKey: entry.edge.subjectKey,
        relationship: entry.edge.relationship,
        positions: positionsFor(answers, entry.edge),
      });
    }

    // An edge only some views report is CAPPED below the standing threshold.
    // §10.7 lets weaker semantic edges improve recall, so it is kept and
    // shown; it may not inherit standing or authorise a substitution on the
    // word of a subset.
    const capped = partial ? Math.min(entry.lowest, INHERIT_STANDING_BP - 1) : entry.lowest;

    edges.push({
      subjectKey: entry.edge.subjectKey,
      relationship: entry.edge.relationship,
      objectKey: entry.edge.objectKey,
      confidenceBp: capped,
      supportingViews: supporting,
      consultedViews: consulted,
      contested: split || partial || entry.upstreamDisputed,
    });
  }

  // A single-object relationship whose views name DIFFERENT objects is the
  // sharpest disagreement there is: it is a claim about lineage, and picking
  // one would erase the other's.
  for (const conflict of conflictingObjects(answers)) disagreements.push(conflict);

  const contestedSubjects = new Set(
    disagreements
      .filter((d) => d.kind === 'conflicting_object')
      .map((d) => `${d.subjectKey} ${d.relationship}`),
  );
  for (const edge of edges) {
    if (contestedSubjects.has(`${edge.subjectKey} ${edge.relationship}`)) edge.contested = true;
  }

  // Deterministic order, so two reads of unchanged answers agree.
  edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
  disagreements.sort((a, b) =>
    a.subjectKey === b.subjectKey
      ? a.relationship === b.relationship
        ? a.kind.localeCompare(b.kind)
        : a.relationship.localeCompare(b.relationship)
      : a.subjectKey.localeCompare(b.subjectKey),
  );
  return { edges, disagreements };
}

/** What each consulted view said about one edge, including silence. */
function positionsFor(
  answers: AppViewAnswer[],
  edge: AppViewEdge,
): RelationshipDisagreement['positions'] {
  return answers.map((answer) => {
    const match = answer.edges.find(
      (candidate) =>
        candidate.subjectKey === edge.subjectKey &&
        candidate.relationship === edge.relationship &&
        candidate.objectKey === edge.objectKey,
    );
    return {
      appViewDid: answer.appViewDid,
      // NULL, not zero, when a view said nothing. Zero is a confidence; silence
      // is the absence of one, and an owner reading "0" would think the view
      // had looked and disagreed.
      objectKey: match === undefined ? null : match.objectKey,
      confidenceBp: match === undefined ? null : match.confidenceBp,
    };
  });
}

/**
 * Single-object relationships where more than one object is claimed.
 *
 * ACROSS views AND WITHIN one. An earlier version kept one object per view, so
 * a single directory recording two competing parents overwrote itself and the
 * conflict vanished — and a directory that records both candidates is the most
 * likely place to find one, because it is the one that noticed. §10.7 cares
 * about the disagreement, not about who is holding it.
 *
 * A view naming two parents therefore appears as TWO positions, which is also
 * what an owner needs to see: "this directory itself lists two".
 */
function conflictingObjects(answers: AppViewAnswer[]): RelationshipDisagreement[] {
  const claimsBySubject = new Map<
    string,
    { appViewDid: string; objectKey: string; confidenceBp: number }[]
  >();
  for (const answer of answers) {
    for (const edge of answer.edges) {
      if (!SINGLE_OBJECT_RELATIONSHIPS.has(edge.relationship)) continue;
      const key = `${edge.subjectKey} ${edge.relationship}`;
      const claims = claimsBySubject.get(key) ?? [];
      claims.push({
        appViewDid: answer.appViewDid,
        objectKey: edge.objectKey,
        confidenceBp: edge.confidenceBp,
      });
      claimsBySubject.set(key, claims);
    }
  }

  const conflicts: RelationshipDisagreement[] = [];
  for (const [key, claims] of claimsBySubject) {
    if (new Set(claims.map((c) => c.objectKey)).size < 2) continue;
    const [subjectKey, relationship] = splitKey(key);
    conflicts.push({
      kind: 'conflicting_object',
      subjectKey,
      relationship,
      // Every claim, plus the views that made none. A view that said nothing
      // is a position too — it is the one that did not see the conflict.
      positions: [
        ...claims,
        ...answers
          .filter((answer) => !claims.some((c) => c.appViewDid === answer.appViewDid))
          .map((answer) => ({
            appViewDid: answer.appViewDid,
            objectKey: null,
            confidenceBp: null,
          })),
      ] as RelationshipDisagreement['positions'],
    });
  }
  return conflicts;
}

/** `subject relationship` back into its two halves, splitting on the LAST space. */
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf(' ');
  return at === -1 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
}

/**
 * May this resolved edge authorise a substitution in an order?
 *
 * A CONTESTED edge authorises nothing, whatever its number. That is stricter
 * than the threshold alone and it is the point: an edge two indexes disagree
 * about is exactly the edge that should not silently change what a buyer
 * receives.
 */
export function mayAuthorizeSubstitution(edge: ResolvedEdge): boolean {
  return !edge.contested && edge.confidenceBp >= AUTHORIZE_SUBSTITUTION_BP;
}

/** May standing on the object count toward the subject? Same rule, lower bar. */
export function mayInheritStanding(edge: ResolvedEdge): boolean {
  return !edge.contested && edge.confidenceBp >= INHERIT_STANDING_BP;
}

/** May it be shown as "possibly related"? A contested edge still may. */
export function mayShowAsRelated(edge: ResolvedEdge): boolean {
  // Contested is deliberately NOT disqualifying here. Showing a disputed
  // relationship with its dispute is what §10.7 asks for; hiding it would be
  // the silent choice the sentence forbids, made in the other direction.
  return edge.confidenceBp >= SHOW_AS_RELATED_BP;
}

/**
 * A disagreement in the owner's words (§10.7 "expose material disagreement").
 *
 * Written here rather than in each client for the reason every projection in
 * this codebase is: two renderers deriving their own sentence would eventually
 * disagree about whether a dispute means "probably fine".
 */
export function describeDisagreement(disagreement: RelationshipDisagreement): string {
  const naming = disagreement.positions.filter((p) => p.objectKey !== null).length;
  const total = disagreement.positions.length;
  switch (disagreement.kind) {
    case 'conflicting_object':
      return `Directories disagree about which product this is a ${disagreement.relationship.replace(/_/g, ' ')} of.`;
    case 'threshold_split':
      return 'Directories agree this relationship exists but disagree about how strongly.';
    case 'partial_support':
      return `${String(naming)} of ${String(total)} directories report this relationship.`;
    case 'upstream_dispute':
      return 'A directory reports conflicting claims about this relationship.';
  }
}
