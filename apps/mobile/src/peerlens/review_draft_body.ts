/**
 * The minimal review-draft body the Outbox + inline card render and the publish
 * job stores (as `draft_json`). Relocated here from the retired `outbox_store`
 * (the in-memory mirror) so it survives the cutover to the durable job model.
 */
export interface AttestationDraftBody {
  readonly sentiment: 'positive' | 'neutral' | 'negative';
  readonly headline: string;
  readonly body: string;
  readonly confidence: 'certain' | 'high' | 'moderate' | 'speculative';
  readonly subjectTitle: string;
  readonly subjectId?: string;
}
