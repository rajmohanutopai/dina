/**
 * The release-context log (A2A design §4.2, §6.2 step 2): what Core released
 * to Brain in each conversation, and a digest of each message the owner sent
 * in it. Core resolves provenance from this log alone (A2A-I12): text Brain
 * says is a vault item must be the whole body of an item Core released to it
 * in this conversation, still holding what Core released; text Brain says
 * the owner wrote must be a whole message recorded at the start of a turn.
 *
 * Installed on BOTH boots (the phone too), because the vault read functions
 * record into it below every caller: the server's routes, and the phone's
 * direct calls. Rows expire after `RELEASE_LOG_TTL_MS`; an expired row
 * proves nothing, and is swept at boot and at most once a minute while the
 * log records.
 *
 * Core keeps only a digest of the owner's words (`utteranceDigest`): a proof
 * covers a whole message, so equal digests are the whole test, and the log
 * holds no copy of what the owner said.
 */

import { getPersonaTier, onPersonaDeleted } from '../persona/service';
import { releasedTextFields, setVaultReleaseRecorder, type ReleaseContext } from '../vault/release';

import { canonicalDigest } from './digest';
import { utteranceDigest } from './provenance_text';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type { VaultItem } from '@dina/test-harness';

export const RELEASE_LOG_TTL_MS = 24 * 60 * 60_000;
/** The id a topic-list release is logged under; vault item ids never start with `#`. */
export const TOPICS_ITEM_ID = '#topics';
/** The id a shredded persona's releases leave behind: it taints and proves nothing. */
export const FORGOTTEN_ITEM_ID = '#forgotten';

export interface DisclosureRow {
  session_id: string;
  audience: string;
  persona: string;
  persona_tier: string;
  item_id: string;
  content_digest: string;
  released_at: number;
  expires_at: number;
}

export interface UtteranceRow {
  session_id: string;
  turn_id: string;
  /** `utteranceDigest` of the whole message; the words themselves are not kept. */
  digest: string;
  recorded_at: number;
  expires_at: number;
}

/** What a release handed out of an item, digested so a later change shows. */
export function releasedContentDigest(item: VaultItem): string {
  return canonicalDigest(releasedTextFields(item));
}

function tierOf(persona: string): string {
  try {
    return getPersonaTier(persona);
  } catch {
    // A persona the registry no longer knows counts as sensitive: never under-taint.
    return 'sensitive';
  }
}

/** Expired rows are swept at most this often while the log records. */
const PURGE_EVERY_MS = 60_000;

/**
 * The tier a re-read stores: the stricter of the tier the row holds and the
 * persona's tier now. A read made while the persona was private stays a
 * private read whatever the persona is later lowered to, so a conversation's
 * taint never shrinks by reading again (provenance reads "private when read
 * OR now").
 */
const STRICTER_TIER = `CASE
  WHEN a2a_disclosures.persona_tier = 'locked' OR excluded.persona_tier = 'locked' THEN 'locked'
  WHEN a2a_disclosures.persona_tier = 'sensitive' OR excluded.persona_tier = 'sensitive' THEN 'sensitive'
  ELSE excluded.persona_tier END`;

export class A2AReleaseLog {
  private lastPurge = Number.NEGATIVE_INFINITY;

  constructor(
    readonly db: DatabaseAdapter,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** Sweep expired rows now and then: every boot, and while the log is in use. */
  private sweep(now: number): void {
    if (now - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = now;
    this.purgeExpired();
  }

  recordDisclosures(ctx: ReleaseContext, persona: string, items: readonly VaultItem[]): void {
    const now = this.nowMs();
    this.sweep(now);
    const tier = tierOf(persona);
    this.db.transaction(() => {
      for (const item of items) {
        this.db.run(
          `INSERT INTO a2a_disclosures
             (session_id, audience, persona, persona_tier, item_id, content_digest, released_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id, audience, persona, item_id, content_digest)
           DO UPDATE SET released_at = excluded.released_at, expires_at = excluded.expires_at,
                         persona_tier = ${STRICTER_TIER}`,
          [ctx.sessionId, ctx.audience, persona, tier, item.id, releasedContentDigest(item), now, now + RELEASE_LOG_TTL_MS],
        );
      }
    });
  }

  /**
   * A persona's topic list released into a conversation: a row under the
   * reserved id `#topics`, which no vault item has, so it taints the read set
   * and can never prove a quote.
   */
  recordTopics(ctx: ReleaseContext, persona: string, topics: readonly string[]): void {
    const now = this.nowMs();
    this.sweep(now);
    this.db.run(
      `INSERT INTO a2a_disclosures
         (session_id, audience, persona, persona_tier, item_id, content_digest, released_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, audience, persona, item_id, content_digest)
       DO UPDATE SET released_at = excluded.released_at, expires_at = excluded.expires_at,
                     persona_tier = ${STRICTER_TIER}`,
      [ctx.sessionId, ctx.audience, persona, tierOf(persona), TOPICS_ITEM_ID, canonicalDigest([...topics].sort()), now, now + RELEASE_LOG_TTL_MS],
    );
  }

  /** Every live release in a conversation: its read set. */
  readSet(sessionId: string): DisclosureRow[] {
    return this.db.query(
      `SELECT * FROM a2a_disclosures WHERE session_id = ? AND audience = 'brain' AND expires_at > ?
        ORDER BY released_at`,
      [sessionId, this.nowMs()],
    ) as unknown as DisclosureRow[];
  }

  /** The live releases of one item in a conversation (one per content it had when read). */
  releasesOf(sessionId: string, persona: string, itemId: string): DisclosureRow[] {
    return this.db.query(
      `SELECT * FROM a2a_disclosures
        WHERE session_id = ? AND audience = 'brain' AND persona = ? AND item_id = ? AND expires_at > ?`,
      [sessionId, persona, itemId, this.nowMs()],
    ) as unknown as DisclosureRow[];
  }

  /**
   * Record one turn's message, as its digest. The first record of a turn
   * stands: a turn's words cannot be replaced after the fact. Also sweeps
   * expired rows, so both boots stay bounded without a timer.
   */
  recordUtterance(sessionId: string, turnId: string, text: string): boolean {
    const now = this.nowMs();
    this.sweep(now);
    return (
      this.db.run(
        `INSERT INTO a2a_utterances (session_id, turn_id, digest, recorded_at, expires_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, turn_id) DO NOTHING`,
        [sessionId, turnId, utteranceDigest(text), now, now + RELEASE_LOG_TTL_MS],
      ) === 1
    );
  }

  /** The digests of the owner's live messages in a conversation, oldest first. */
  utterances(sessionId: string): UtteranceRow[] {
    return this.db.query(
      `SELECT * FROM a2a_utterances WHERE session_id = ? AND expires_at > ? ORDER BY recorded_at, turn_id`,
      [sessionId, this.nowMs()],
    ) as unknown as UtteranceRow[];
  }

  /** When the conversation's oldest live turn was recorded, or null when it has none. */
  conversationStart(sessionId: string): number | null {
    const found = this.db.query(
      `SELECT MIN(recorded_at) AS start FROM a2a_utterances WHERE session_id = ? AND expires_at > ?`,
      [sessionId, this.nowMs()],
    ) as DBRow[];
    const start = found[0]?.start;
    return typeof start === 'number' ? start : null;
  }

  /** The newest live turn in a conversation, or null: a proposal must follow one. */
  latestUtterance(sessionId: string): UtteranceRow | null {
    const found = this.db.query(
      `SELECT * FROM a2a_utterances WHERE session_id = ? AND expires_at > ? ORDER BY recorded_at DESC LIMIT 1`,
      [sessionId, this.nowMs()],
    ) as DBRow[];
    return (found[0] as unknown as UtteranceRow | undefined) ?? null;
  }

  purgeExpired(): number {
    const now = this.nowMs();
    return (
      this.db.run(`DELETE FROM a2a_disclosures WHERE expires_at <= ?`, [now]) +
      this.db.run(`DELETE FROM a2a_utterances WHERE expires_at <= ?`, [now])
    );
  }

  /**
   * A persona is shredded: its sealed originals go, and its releases lose
   * everything that could prove a quote — but a conversation that read it
   * keeps its taint. Each conversation keeps one marker row under the
   * reserved id `#forgotten`, restricted, which proves nothing.
   */
  forgetPersona(persona: string): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO a2a_disclosures
           (session_id, audience, persona, persona_tier, item_id, content_digest, released_at, expires_at)
         SELECT session_id, audience, persona, 'sensitive', ?, 'forgotten', MAX(released_at), MAX(expires_at)
           FROM a2a_disclosures WHERE persona = ? AND item_id != ?
          GROUP BY session_id, audience
         ON CONFLICT (session_id, audience, persona, item_id, content_digest) DO NOTHING`,
        [FORGOTTEN_ITEM_ID, persona, FORGOTTEN_ITEM_ID],
      );
      this.db.run(`DELETE FROM a2a_disclosures WHERE persona = ? AND item_id != ?`, [persona, FORGOTTEN_ITEM_ID]);
      this.db.run(`DELETE FROM a2a_entities WHERE persona = ?`, [persona]);
    });
  }
}

let installed: A2AReleaseLog | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Install the release log on this host (both boots), or remove it. The vault
 * read functions record into it; a read asked to record with no log fails.
 * A deleted persona's rows go with it.
 */
export function installA2AReleaseLog(log: A2AReleaseLog | null): void {
  installed = log;
  // A boot sweeps what expired while the node was down or idle.
  log?.purgeExpired();
  unsubscribe?.();
  unsubscribe = log === null ? null : onPersonaDeleted((persona) => log.forgetPersona(persona));
  setVaultReleaseRecorder(
    log === null
      ? null
      : {
          items: (ctx, persona, items) => log.recordDisclosures(ctx, persona, items),
          topics: (ctx, persona, topics) => log.recordTopics(ctx, persona, topics),
        },
  );
}

export function getA2AReleaseLog(): A2AReleaseLog | null {
  return installed;
}
