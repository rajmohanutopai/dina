/**
 * MRS-14 relay-tier browser-half sweep. Captures a page's console + network
 * egress and asserts no vault content / secret / recovery phrase leaked into
 * the console, and no request egressed to an unexpected host. Pairs with
 * relay_teardown.ts (the server-log half).
 *
 * Foreign-DID (social-graph) check — CORRECTION of an earlier inverted note:
 * this check matters MOST in the relay tier (per log_hygiene's own docstring,
 * it's meant to turn on "once D2D/Talk tests introduce contacts" — i.e. exactly
 * here), NOT in the contact-less single-human functional tier. The relay tier
 * is multi-party, so SOME DIDs (the participants the UI legitimately shows —
 * the peer sender, the quarantined stranger) flow on purpose; those are passed
 * as `ownDids` so a genuinely-foreign DID (a leaked social-graph entry) is
 * still caught rather than the check being disabled wholesale. A caller that
 * passes no `ownDids` keeps the DID check OFF (a DID appearing in the console
 * would need an allowlist first); a caller that knows its participant DIDs
 * passes them to turn the check ON. DID_RE matches did:plc AND did:key, so the
 * allowlist must cover every DID the flow legitimately surfaces on screen.
 */

import { expect, type Page } from '@playwright/test';

import { egressHost, isAllowedEgress, scanForLeaks } from '../support/log_hygiene';

export interface RelayHygiene {
  /** Assert the captured console + egress are leak-free. Call before ctx.close(). */
  assertClean(): void;
}

/**
 * @param ownDids the DIDs this flow legitimately surfaces in the UI/console
 *   (peer sender, quarantined stranger, the node's own). When non-empty, the
 *   foreign-DID leak check runs and flags any OTHER did:plc/did:key.
 */
export function attachHygiene(page: Page, ownDids: readonly string[] = []): RelayHygiene {
  const consoleAll: string[] = [];
  const requestUrls: string[] = [];
  page.on('console', (m) => {
    consoleAll.push(m.text());
    for (const arg of m.args()) {
      arg
        .jsonValue()
        .then((v) => consoleAll.push(typeof v === 'string' ? v : JSON.stringify(v)))
        .catch(() => {
          /* non-serialisable console arg — the .text() form above still covers it */
        });
    }
  });
  page.on('pageerror', (e) => consoleAll.push(e.message));
  page.on('request', (r) => requestUrls.push(r.url()));

  return {
    assertClean(): void {
      // Enable the foreign-DID check when the caller supplied the participant
      // allowlist (see file header); omit → check stays off.
      const leaks = scanForLeaks(
        consoleAll.join('\n'),
        'browser-console',
        ownDids.length > 0 ? { ownDids: new Set(ownDids) } : {},
      );
      expect(
        leaks,
        `MRS-14: browser console leaked — ${leaks.map((l) => l.kind).join(', ')}`,
      ).toEqual([]);

      const badEgress = requestUrls.filter((u) => !isAllowedEgress(u));
      expect(
        badEgress,
        `MRS-14: unexpected third-party egress — ${badEgress.map(egressHost).join(', ')}`,
      ).toEqual([]);
    },
  };
}
