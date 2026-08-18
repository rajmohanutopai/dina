/**
 * §10 item 9 — did a PERSON do this, or did the software ask itself?
 *
 * WHAT WAS WRONG. `ownerPresenceAvailable()` returned a hard-coded `false`, so
 * every step of the photo-catalog lane that binds — the content receipt, the
 * approval — refused on a real server. The lane was complete, tested and
 * unreachable: a seller running home-node-lite could create a draft and never
 * publish it. The comment said the primitive existed with no production
 * caller, and it did: `PassphraseRegistry` in the server app has been
 * verifying Argon2id records for personas all along. Nothing connected them.
 *
 * WHAT PRESENCE MEANS HERE, and it is deliberately narrow. Not "the request
 * authenticated" — an automated script holding the owner's token authenticates
 * perfectly and is not a person. Not "the vault is unlocked" — that survives a
 * reboot and says nothing about who is in the room now. It means SOMEBODY
 * TYPED THE PASSPHRASE A MOMENT AGO, which is the only signal this node has
 * that a human is present and paying attention.
 *
 * A VERDICT CORE REACHED, never a flag a caller passes. The route hands over a
 * passphrase and Core verifies it; nothing accepts `present: true` from
 * outside. That is the whole point of the receipt: it records that a person
 * vouched for a machine-read value, and a receipt a caller could assert by
 * sending a boolean records nothing at all.
 *
 * THE WINDOW IS SHORT ON PURPOSE. Presence is a statement about NOW. Long
 * enough to read a page of items and press approve, short enough that a
 * passphrase typed this morning cannot sign a catalog this afternoon.
 */

/**
 * How long a proof of presence stands.
 *
 * Five minutes: the seller reviews items, presses confirm, reviews the built
 * snapshot, presses approve. Longer would let an unattended machine publish on
 * the strength of a passphrase nobody remembers typing.
 */
export const OWNER_PRESENCE_TTL_MS = 5 * 60 * 1000;

/**
 * Checks a passphrase against whatever this node stores for the owner.
 *
 * INJECTED, because Core does no I/O and holds no verifier records. The server
 * app supplies one backed by `PassphraseRegistry`; mobile will supply one
 * backed by the same check the unlock screen already performs. Returning false
 * and throwing are both "not proven" — the caller must not be able to tell a
 * wrong passphrase from a broken verifier, because the difference is only
 * useful to somebody guessing.
 */
export type OwnerPresenceVerifier = (passphrase: string) => Promise<boolean>;

let verifier: OwnerPresenceVerifier | null = null;
let provenAtMs = 0;

export function installOwnerPresenceVerifier(value: OwnerPresenceVerifier | null): void {
  verifier = value;
  // A NODE THAT SWAPS ITS VERIFIER HAS NOT GOT A PERSON IN THE ROOM. Keeping
  // the stamp across an install would let a boot sequence inherit presence
  // proven against a verifier that is no longer the one in force.
  provenAtMs = 0;
}

/**
 * CAN this node establish presence at all?
 *
 * A capability question, and a different one from "is somebody here now". The
 * retired item-list publish route asks this: it should refuse and point at the
 * draft lane once that lane is usable, and staying open while the lane cannot
 * publish is what keeps a seller from being locked out of both.
 */
export function ownerPresenceCanBeEstablished(): boolean {
  return verifier !== null;
}

/**
 * Verify a passphrase and, if it is right, stamp the clock.
 *
 * The passphrase is not stored, not logged and not returned. Callers get a
 * boolean.
 */
export async function proveOwnerPresence(passphrase: string, nowMs: number): Promise<boolean> {
  if (verifier === null) return false;
  // An empty string is not a passphrase, and letting it reach the verifier
  // invites a backend that treats "no record" as "no mismatch".
  if (passphrase === '') return false;
  let proven = false;
  try {
    proven = await verifier(passphrase);
  } catch {
    // A verifier that throws has not proven anything. Failing closed here is
    // what stops a broken Argon2id backend reading as a successful login.
    return false;
  }
  if (proven) provenAtMs = nowMs;
  return proven;
}

/**
 * Is somebody here right now?
 *
 * A stamp in the FUTURE counts as no proof, for the same reason a publication
 * claim stamped ahead of the clock is treated as abandoned: a device whose
 * clock moved backwards would otherwise carry presence for the size of the
 * skew, and presence is the one thing that must not outlive the person.
 */
export function ownerPresentNow(nowMs: number): boolean {
  if (provenAtMs <= 0) return false;
  const age = nowMs - provenAtMs;
  return age >= 0 && age < OWNER_PRESENCE_TTL_MS;
}

/** Drop any standing proof — used on lock, on logout, and by tests. */
export function clearOwnerPresence(): void {
  provenAtMs = 0;
  staffProvenAtMs.clear();
}

// ---------------------------------------------------------------------------
// Attributed presence (TRADE_FIRST_STRATEGY §6.4)
// ---------------------------------------------------------------------------
//
// The owner's stamp above stays exactly as it was — every shipped caller
// keeps its contract. What §6 adds is presence FOR A NAMED PRINCIPAL: a
// staff device proves with its own per-device PIN (an Argon2id record
// minted at the grant ceremony; the PIN unlocks nothing in the vault),
// and the stamp is kept PER DEVICE with the same five-minute window.
// A vouch made under a staff stamp is attributed to that device's DID.

/** Checks a staff device's PIN. Injected by the composition root. */
export type StaffPresenceVerifier = (deviceDid: string, pin: string) => Promise<boolean>;

let staffVerifier: StaffPresenceVerifier | null = null;
const staffProvenAtMs = new Map<string, number>();

export function installStaffPresenceVerifier(value: StaffPresenceVerifier | null): void {
  staffVerifier = value;
  // The owner-verifier rule, held to for staff too: swapping the
  // verifier drops every standing stamp.
  staffProvenAtMs.clear();
}

export function staffPresenceCanBeEstablished(): boolean {
  return staffVerifier !== null;
}

/** Verify a staff PIN and stamp that DEVICE's clock. Fail-closed. */
export async function proveStaffPresence(
  deviceDid: string,
  pin: string,
  nowMs: number,
): Promise<boolean> {
  if (staffVerifier === null) return false;
  if (deviceDid === '' || pin === '') return false;
  let proven = false;
  try {
    proven = await staffVerifier(deviceDid, pin);
  } catch {
    return false;
  }
  if (proven) staffProvenAtMs.set(deviceDid, nowMs);
  return proven;
}

/** Is THIS staff device's person here right now? Same window, same
 *  future-stamp rule as the owner's. */
export function staffPresentNow(deviceDid: string, nowMs: number): boolean {
  const stamp = staffProvenAtMs.get(deviceDid) ?? 0;
  if (stamp <= 0) return false;
  const age = nowMs - stamp;
  return age >= 0 && age < OWNER_PRESENCE_TTL_MS;
}

/** Drop one device's proof — on its grant revocation or device revoke. */
export function clearStaffPresence(deviceDid: string): void {
  staffProvenAtMs.delete(deviceDid);
}
