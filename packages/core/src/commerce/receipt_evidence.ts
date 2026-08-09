/**
 * Receipt authentication evidence (§9.12, §16.2, WS-2.8).
 *
 * WHAT A RECEIPT PROVES TODAY, AND WHAT IT DOES NOT. The receipt store is
 * content-addressed: the digest names the record, and the record body is
 * therefore self-proving. What it cannot show is HOW this node came to hold it
 * — whether it signed the record itself, or received it from a counterparty
 * over an authenticated envelope, and if so which envelope and under which
 * key. That is exactly what a dispute turns on. "We both agree this is the
 * document" is rarely the argument; "you sent it to me, here is the envelope"
 * is.
 *
 * The column has existed since CMC-1 and every caller writes `'{}'`.
 *
 * WHY EVIDENCE MERGES WHILE THE RECORD DOES NOT. `put` is first-writer-wins,
 * which is right for the BODY: the digest addresses those bytes, so a second
 * writer proposing different bytes under the same digest is a collision or an
 * attack, and the first writer must hold. It is wrong for EVIDENCE, and
 * predictably so — the ordinary sequence is that a node records a document it
 * built (no envelope, it signed the thing) and LATER receives the same digest
 * back from the counterparty carrying real authentication. First-writer-wins
 * throws that second observation away, which is the one a dispute needs.
 *
 * So the two fields have different rules under one write, and the rules match
 * what each field is: the record is a fact about the document, the evidence is
 * a growing list of facts about this node's encounters with it.
 *
 * OBSERVATIONS ARE APPEND-ONLY AND DEDUPED BY IDENTITY. A retry that delivers
 * the same envelope twice must not grow the list; two genuinely different
 * envelopes carrying the same record must both survive, because "they sent it
 * twice under two keys" is itself evidence.
 */

/** One encounter with the record. */
export interface EvidenceObservation {
  /**
   * `signed_here` — this node produced and signed the record. There is no
   * envelope and no counterparty key; the fact worth recording is that the
   * document originated here.
   *
   * `received` — the record arrived from a counterparty. The envelope and key
   * are what a dispute rests on.
   */
  kind: 'signed_here' | 'received';
  /** Counterparty DID on a `received` observation. */
  fromDid?: string;
  /** Transport envelope identifier, when the arrival carried one. */
  envelopeId?: string;
  /** The signing key the counterparty authenticated under. */
  keyId?: string;
  /** Signature bytes as recorded on the wire, hex or base64 as sent. */
  signature?: string;
  /** Epoch ms. */
  observedAt: number;
}

export interface ReceiptEvidence {
  observations: EvidenceObservation[];
}

const EMPTY: ReceiptEvidence = { observations: [] };

/**
 * Identity of an observation, for dedup.
 *
 * `observedAt` is DELIBERATELY absent. A retried delivery of the same envelope
 * arrives at a different millisecond and is the same fact; including the clock
 * would make every retry a new observation and turn the evidence list into a
 * delivery log.
 */
function identity(observation: EvidenceObservation): string {
  return [
    observation.kind,
    observation.fromDid ?? '',
    observation.envelopeId ?? '',
    observation.keyId ?? '',
    observation.signature ?? '',
    // A separator no field can contain. DIDs, envelope ids, key ids and
    // signatures are opaque strings, so joining on a space would let two
    // different observations collide into one identity and silently drop the
    // second — evidence lost to a formatting accident.
  ].join('\u0000');
}

/**
 * Read stored evidence. Unreadable or malformed JSON reads as EMPTY rather
 * than throwing.
 *
 * A receipt whose evidence column was corrupted must not become a receipt
 * nobody can write to: the record body is the thing under dispute, and losing
 * access to it because a metadata field went bad would be the worse failure.
 * The corrupt value is dropped, not merged — merging it would give an attacker
 * who could write that column a way to inject observations.
 */
export function readEvidence(json: string): ReceiptEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return EMPTY;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY;
  const observations = (parsed as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) return EMPTY;
  const clean: EvidenceObservation[] = [];
  for (const entry of observations) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.kind !== 'signed_here' && record.kind !== 'received') continue;
    if (typeof record.observedAt !== 'number' || !Number.isFinite(record.observedAt)) continue;
    clean.push({
      kind: record.kind,
      ...(typeof record.fromDid === 'string' ? { fromDid: record.fromDid } : {}),
      ...(typeof record.envelopeId === 'string' ? { envelopeId: record.envelopeId } : {}),
      ...(typeof record.keyId === 'string' ? { keyId: record.keyId } : {}),
      ...(typeof record.signature === 'string' ? { signature: record.signature } : {}),
      observedAt: record.observedAt,
    });
  }
  return { observations: clean };
}

/**
 * Merge new observations into stored evidence, deduping by identity.
 *
 * Existing observations keep their position and their original `observedAt`:
 * the FIRST time this node saw a given envelope is the fact worth keeping, and
 * a later duplicate delivery does not change when it first arrived.
 */
export function mergeEvidence(
  storedJson: string,
  incoming: readonly EvidenceObservation[],
): string {
  const stored = readEvidence(storedJson);
  const seen = new Set(stored.observations.map(identity));
  const merged = [...stored.observations];
  for (const observation of incoming) {
    const key = identity(observation);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(observation);
  }
  return JSON.stringify({ observations: merged });
}

/** The evidence a node records for a document it produced itself. */
export function signedHere(observedAt: number): string {
  return JSON.stringify({ observations: [{ kind: 'signed_here', observedAt }] });
}

/** The evidence a node records for a document that arrived from a counterparty. */
export function receivedFrom(args: {
  fromDid: string;
  observedAt: number;
  envelopeId?: string;
  keyId?: string;
  signature?: string;
}): string {
  return JSON.stringify({
    observations: [
      {
        kind: 'received',
        fromDid: args.fromDid,
        ...(args.envelopeId === undefined ? {} : { envelopeId: args.envelopeId }),
        ...(args.keyId === undefined ? {} : { keyId: args.keyId }),
        ...(args.signature === undefined ? {} : { signature: args.signature }),
        observedAt: args.observedAt,
      },
    ],
  });
}
