/**
 * The owner's cards for commitments (COMMITMENT_KERNEL §8, §9) — the port
 * the engine raises them through; the workflow service implements it.
 *
 * One card per question: raising a card whose id exists is a no-op. A card
 * carries an inbox line that never holds a number (Brain may read
 * descriptions) and an owner payload that may (redacted for Brain by type).
 * The owner's yes is committed by the workflow first and reported to the
 * engine second, so the engine's sweep can ask for an answer it missed.
 */

export interface OwnerCardSpec {
  cardId: string;
  /** The payload `type` the inbox, the presence gate and the Brain redaction key on. */
  type: string;
  /** One line for the inbox. Never a price: Brain may read descriptions. */
  description: string;
  /** The owner-facing payload (prices included; redacted for Brain by type). */
  payload: Record<string, unknown>;
  expiresAtMs: number;
}

export interface OwnerCardPort {
  /** Raise a card; false when one with this id already exists. */
  raise(card: OwnerCardSpec): boolean;
  /** Take a card down without an owner decision (it was answered elsewhere). */
  close(cardId: string, reason: string): void;
  /**
   * The owner's answer the inbox holds for a card, when the engine may not
   * have heard it: the workflow commits the yes, then tells the engine in a
   * second step, and a crash between the two leaves the yes with no effect.
   * The sweep asks, and acts on what it hears. Null: no answer, or none to act on.
   */
  answer?(cardId: string): 'approved' | 'declined' | null;
  /** Close the inbox task once the engine acted on the owner's yes, with the outcome. */
  finish?(
    cardId: string,
    outcome: { ok: true } | { ok: false; refusal: string },
    nowMs: number,
  ): void;
}
