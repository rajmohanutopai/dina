/**
 * Display helpers for AT Protocol handles + DIDs.
 *
 * Centralized so every screen that renders a reviewer / author /
 * contact does the same: show a short, scannable username; reveal the
 * full handle + DID + PLC document only when the user taps for details.
 * Avoids accidental drift between subject detail / feed / reviewer
 * profile / search / contacts.
 */

/**
 * Render a 30-char DID as a recognisable head + tail:
 * `did:plc:abc1…7890`. Keeps the leading DID method + first 6 chars of
 * the identifier (enough to disambiguate at a glance) and the last 4
 * (so two DIDs that share a prefix still look different).
 *
 * Short DIDs pass through unchanged.
 */
export function truncateDid(did: string): string {
  if (did.length <= 18) return did;
  return `${did.slice(0, 14)}…${did.slice(-4)}`;
}

/**
 * Extract the username portion of a handle: the first DNS label.
 *
 *   `alice.pds.dinakernel.com` → `alice`
 *   `rajmohanddc9.test-pds.dinakernel.com` → `rajmohanddc9`
 *
 * Why first-label-only: list rows render in tight contexts (avatar
 * row, chat title, search hit). The full FQDN crowds out everything
 * else and reads like an email address even though it's an identity.
 * Power users still see the full handle + the underlying DID + PLC
 * services in the IdentityModal that opens on tap.
 *
 * Defensive on bad input — returns the original string if there's no
 * dot or the first label is empty (e.g. ".alice"), and the trimmed
 * value when there's only whitespace around a label.
 */
export function shortHandle(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed === '') return trimmed;
  const dot = trimmed.indexOf('.');
  if (dot <= 0) return trimmed;
  return trimmed.slice(0, dot);
}

/**
 * Pick the display label for a reviewer / author / contact. Returns
 * the **first label** of the resolved handle when present (e.g.
 * `alice` from `alice.pds.dinakernel.com`), otherwise a truncated DID.
 *
 * The short form is the rendered default everywhere a list row shows
 * a peer. The IdentityModal exposes the full handle, full DID, and
 * full PLC document on tap — see `components/identity/identity_modal`.
 *
 * Defensive type-narrowing so callers can pass `string | null |
 * undefined` straight from a wire shape.
 */
export function displayName(
  handle: string | null | undefined,
  did: string,
): string {
  if (typeof handle === 'string' && handle.length > 0) {
    return shortHandle(handle);
  }
  return truncateDid(did);
}

/**
 * Same as `displayName`, but consults a local "rename your id"
 * override when the rendered DID is the viewer's own. The override
 * lives in `services/display_name_override` and is set from the admin
 * page; passing it in as a plain argument keeps this helper a pure
 * function so it stays trivially testable and free of any storage
 * import.
 *
 * Self-only by design: passing a non-null `selfDid` that doesn't
 * match `did` falls through to the regular handle/DID path. Renaming
 * other people would be a per-contact alias feature, not this one.
 */
export function displayNameWithOverride(
  handle: string | null | undefined,
  did: string,
  selfDid: string | null,
  override: string | null,
): string {
  if (
    selfDid !== null &&
    selfDid === did &&
    typeof override === 'string' &&
    override.length > 0
  ) {
    return override;
  }
  return displayName(handle, did);
}
