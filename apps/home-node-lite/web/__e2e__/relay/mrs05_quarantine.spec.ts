/**
 * MRS-05 — Unknown sender / quarantine · UI + backstage sender  (§7 MRS-05)
 *
 * A non-contact messages the human; a quarantine card surfaces (body hidden);
 * the human taps "Add to contacts" (release + trust) or "Block" (drop). The
 * gate is deterministic — no judge (§7).
 *
 * Stranger staging: a real stranger node isn't available on the 2-node relay
 * fixture (alonso/sancho are mutual contacts, and the relationship forces the
 * sender to `verified` on receipt). So the unknown-sender precondition is
 * staged backstage via the debug quarantine-seed (§8 — a precondition a human
 * can't produce in one browser; it drops the message into Core's real
 * quarantine store exactly as the receive pipeline does for an unknown-trust
 * sender). accept/block then run for real against that store.
 *
 * @relay — needs the dina-nodes running; SKIPS LOUD otherwise (§10.5).
 */

import { test, expect } from '@playwright/test';

import { attachHygiene } from './relay_hygiene';
import { NODES, debugHeaders, dispatch, nodeDid, relaySkipReason } from './relay_nodes';

interface SeedResult {
  quarantined: { id: string; senderDID: string };
}

async function seedQuarantine(senderDid: string, body: string): Promise<string> {
  const res = await fetch(`${NODES.sancho.core}/v1/debug/quarantine-seed`, {
    method: 'POST',
    headers: debugHeaders(),
    body: JSON.stringify({ sender_did: senderDid, message_type: 'coordination.request', body }),
  });
  if (!res.ok) throw new Error(`quarantine-seed failed: ${res.status}`);
  const j = (await res.json()) as SeedResult;
  return j.quarantined.id;
}

async function stillQuarantined(senderDid: string): Promise<boolean> {
  const { body } = await dispatch(NODES.sancho, 'GET', '/v1/d2d/quarantine');
  const msgs = ((body as { messages?: { senderDID: string }[] }).messages ?? []);
  return msgs.some((m) => m.senderDID === senderDid);
}

async function contactTrust(senderDid: string): Promise<string | null> {
  const { body } = await dispatch(NODES.sancho, 'GET', '/v1/contacts/lookup', {
    query: { q: senderDid },
  });
  const c = (body as { contact?: { trustLevel?: string } }).contact;
  return c?.trustLevel ?? null;
}

test.describe('MRS-05 — unknown sender / quarantine', () => {
  test('"Add to contacts" releases + trusts the sender', async ({ browser }) => {
    const relaySkip = await relaySkipReason();
    test.skip(relaySkip !== null, relaySkip ?? '');

    const STRANGER = 'did:plc:strangeraccept000000000000000000';
    const qid = await seedQuarantine(STRANGER, 'hi, it is me — please add me back');

    // MRS-14 DID allowlist: the stranger (shown on the card) + Sancho's own DID
    // are the only DIDs this flow legitimately surfaces; any OTHER did:* in the
    // console is a foreign social-graph leak.
    const sanchoDid = await nodeDid(NODES.sancho, NODES.alonso);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const hygiene = attachHygiene(page, [STRANGER, sanchoDid]); // MRS-14 browser-half
    try {
      await page.goto(NODES.sancho.web, { waitUntil: 'domcontentloaded' });

      // The quarantine card surfaces (poll-inject on main-chat mount). Body is
      // hidden — the card only shows "unknown sender" + the DID.
      const card = page.locator(
        `[data-testid="chat-row"][data-kind="quarantine"][data-entity-id="${qid}"]`,
      );
      await expect(card, 'quarantine card surfaces in Sancho’s chat').toBeVisible({
        timeout: 45_000,
      });

      // BODY HIDDEN — the anti-spam core (§7): the CARD shows "unknown sender" +
      // the DID, NEVER the stranger's message text. The full body IS fetched
      // (quarantine_sync.web.ts reads QuarantinedMessage.body), so only the
      // render suppresses it. Scope to THIS run's card — accept later RELEASES
      // the body into the long-lived thread, and prior-run releases persist, so
      // a whole-page check would false-fail on legitimately-released history.
      await expect(
        card,
        'the quarantine card must NOT render the stranger’s message body',
      ).not.toContainText('please add me back');

      // Human accepts.
      await page.getByTestId(`quarantine-accept-${qid}`).click();
      await expect(page.getByText(/Added to contacts/i)).toBeVisible({ timeout: 20_000 });

      // Backstage: released from quarantine + sender is now a verified contact.
      await expect(async () => {
        expect(await stillQuarantined(STRANGER)).toBe(false);
      }).toPass({ timeout: 20_000 });
      expect(await contactTrust(STRANGER)).toBe('verified');

      hygiene.assertClean(); // MRS-14 browser-half
    } finally {
      await ctx.close();
    }
  });

  test('"Block" drops the message + blocks the sender', async ({ browser }) => {
    const relaySkip = await relaySkipReason();
    test.skip(relaySkip !== null, relaySkip ?? '');

    const STRANGER = 'did:plc:strangerblock0000000000000000000';
    const qid = await seedQuarantine(STRANGER, 'let me in');

    const sanchoDid = await nodeDid(NODES.sancho, NODES.alonso);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const hygiene = attachHygiene(page, [STRANGER, sanchoDid]); // MRS-14 browser-half
    try {
      await page.goto(NODES.sancho.web, { waitUntil: 'domcontentloaded' });

      const card = page.locator(
        `[data-testid="chat-row"][data-kind="quarantine"][data-entity-id="${qid}"]`,
      );
      await expect(card).toBeVisible({ timeout: 45_000 });

      // BODY HIDDEN (§7 anti-spam) — the card must not render the body (scoped
      // to THIS run's card; see the accept test).
      await expect(
        card,
        'the quarantine card must NOT render the stranger’s message body',
      ).not.toContainText('let me in');

      await page.getByTestId(`quarantine-block-${qid}`).click();
      await expect(page.getByText(/Blocked/i)).toBeVisible({ timeout: 20_000 });

      // Backstage: dropped from quarantine + sender is a blocked contact (so
      // future messages drop pre-gate).
      await expect(async () => {
        expect(await stillQuarantined(STRANGER)).toBe(false);
      }).toPass({ timeout: 20_000 });
      expect(await contactTrust(STRANGER)).toBe('blocked');

      hygiene.assertClean(); // MRS-14 browser-half
    } finally {
      await ctx.close();
    }
  });
});
