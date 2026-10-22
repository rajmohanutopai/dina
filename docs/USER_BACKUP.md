# Backup for a person's own Dina

**Status:** DESIGN, 2026-10-21. Nothing here is built.
**Scope:** the data in one person's Dina, on a phone or a server Home Node,
and on a hosted Dina (`docs/HOSTED_DINA.md`).
**Out of scope:** our shared servers (`docs/DISASTER_RECOVERY_PLAN.md`), and
sync between two live copies of one Dina.

---

## 1. The problem

A person loses their phone. With the 24-word recovery phrase and their
handle they get back their identity: the same DID and keys. They do not get
back their memories, contacts, orders or settings, unless they had exported a
`.dina` file by hand and kept it somewhere safe. Few people will.

So today, losing a phone means losing the Dina's data.

## 2. What exists

| Piece | Where | State |
|---|---|---|
| 24-word recovery phrase | onboarding; `app/recovery-phrase.tsx`, `app/backup-reminder.tsx` | Built. The app asks for it once the vault holds enough to be worth keeping. |
| Recover from the phrase | onboarding `RecoverDraft` (`src/onboarding/state.ts`) | Built. Restores the identity on a new phone. Needs the handle too: it resolves the handle to find the `did:plc`, then checks the phrase's rotation key is listed. |
| `.dina` archive | `packages/core/src/export/archive.ts` | Built. A fixed list of tables, no secrets, no master seed. AES-256-GCM under a key from Argon2id(passphrase). Import only into a fresh install unless forced. The list leaves out the tender tables (`commerce_tenders`, `commerce_tender_members`, the negotiation and notice tables, `commerce_tender_drafts`). |
| Export and restore on the phone | Settings → Admin; `src/services/restore_import.ts` | Built. The person shares the file somewhere and picks it later. |
| Backup key from the seed | `deriveBackupKey()` in `packages/core/src/crypto/hkdf.ts` | Written and tested. Never called. |
| Sealed-copy store logic | `packages/managed-runtime/src/managed_store.ts` | Built as a library, no server. Keeps sealed bytes per tenant, returns them byte-identical and only to that tenant, and has no way to decrypt. |
| Off-site backup | `docs/ROADMAP.md` item 1.22 | Not started. |

The old architecture spec (retired; `git show de30e394^:ARCHITECTURE.md`,
"Tier 5" and "Protection 4") planned five layers: the SQLite write-ahead log,
a snapshot before each migration, file-system snapshots, an off-site
encrypted copy, and a cold archive no one can delete. The first two exist.
This doc builds the fourth, the one that answers a lost phone.

## 3. Goal

Lose the phone, install Dina on a new one, type the 24 words, and get the
data back, without having kept any file.

Rules:

1. **We can't read it.** The copy is sealed with a key that comes from the
   person's seed. We store bytes we cannot open.
2. **The 24 words are enough.** No handle to remember, no second password,
   no file to keep.
3. **The owner can delete it,** all of it, from the app.
4. **Restore shows what it is restoring,** with the date and the item count,
   before it writes anything.

## 4. Design

### 4.1 The key

```
backup_key = deriveBackupKey(master_seed, SHA-256("dina:backup:salt:v1"))
           = HKDF-SHA256(seed, salt, info = "dina:backup:key:v1", 32 bytes)
```

The salt is a fixed constant, so the key needs only the seed. The device's
vault salt (`vault_salt_store`) can't be used: it lives on the lost phone.
This is a third branch from the one seed, beside the signing tree and the
vault keys; a leaked backup key yields neither.

A **backup signing key** comes from the same branch:

```
backup_sign_seed = HKDF-SHA256(seed, salt, info = "dina:backup:sign:v1", 32 bytes)
backup_sign_key  = Ed25519 key from backup_sign_seed
backup_id        = hex(SHA-256(backup_sign_key public key))
```

The store files copies under `backup_id`, not under the DID, so the words
alone find them and the store never learns the DID.

### 4.2 The sealed copy

The same `.dina` archive payload (`buildArchivePayload`), so export, import,
the secret denylist and the checksums stay one code path. What changes is the
outer wrapping:

- a new format version byte for "sealed under the backup key", next to the
  current "sealed under a passphrase";
- AES-256-GCM under `backup_key`, with a random nonce;
- inside, signed by the backup signing key: the DID, the handle, a counter
  that only goes up, and the time it was made. The DID and handle let a new
  phone finish recovery without the person typing their handle (§4.5).

Copies are immutable and named by their counter. The store refuses a `PUT`
for a counter it already holds. After a restore, the next copy takes the
highest counter in the store's list plus one, not the restored copy's
counter plus one, so restoring an older copy never overwrites a newer one.

The archive gains the tender tables, for both this backup and the manual
export (§5). On restore, tenders and drafts that were still open come back
closed as lapsed, so nothing resumes a negotiation the owner did not see.
The master seed and every secret on the denylist stay out, as today.

### 4.3 Where it goes

**A backup store at `backup.dinakernel.com`.** A small new service:

- `PUT /v1/backups/{backup_id}` and `GET /v1/backups/{backup_id}` (latest,
  or by counter), `GET /v1/backups/{backup_id}/list`,
  `DELETE /v1/backups/{backup_id}`;
- every call signed with the backup signing key, using the same canonical
  string as Core's signed requests (`@dina/protocol`:
  `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256_HEX(BODY)}`),
  with the public key in an `X-Backup-Key` header in place of `X-DID`. The
  store checks that SHA-256 of that key equals the `backup_id` in the path,
  that the signature is good, that the timestamp is within five minutes, and
  that the nonce is new. So only the holder of the words can read, write or
  delete the copies, and the store never resolves a DID;
- keeps the last 7 daily and 4 weekly copies per `backup_id`;
- a size limit and a rate limit per `backup_id`;
- stores sealed bytes plus the `backup_id`, the size and the time. No DID,
  no names, no contents;
- runs in the shared infra and is backed up under the disaster recovery plan,
  which must then add it to its list.

**Also allowed, by owner choice:** a file in the person's own iCloud Drive or
Google Drive, or, for a server Home Node, its own S3 bucket. Same sealed
bytes; only the place differs.

### 4.4 When

- **Phone:** after changes, when the app is in the foreground and the last
  copy is more than a day old, or when the owner taps "Back up now". iOS
  gives little background time, so we don't count on it.
- **Server Home Node:** nightly, when anything changed.
- **Hosted Dina:** when it has changed, before it stops, and at least daily
  while it runs (`docs/HOSTED_DINA.md` §7). A locked Dina can't back up, and
  nothing changes in it while locked.
- Never while a restore is in progress.

### 4.5 Restore

1. New phone: the person types the 24 words.
2. Dina derives the backup key and backup signing key, and asks the store for
   the list of copies under `backup_id`, with a signed request.
3. The app opens the latest copy and shows its date and item count, from the
   archive's manifest. The owner confirms, or picks an older one.
4. The recover flow continues with the DID and handle from inside the copy,
   so the person need not type the handle. The flow still checks that the
   phrase's rotation key is listed for that DID.
5. `importArchive` into the fresh install, as the manual restore does now.
6. If the store holds nothing, the recover flow asks for the handle as it
   does today, and goes on with an empty Dina.

### 4.6 Turning it on

The first time the app asks for the recovery phrase, it also offers backup:
"Keep an encrypted copy of your Dina so you can get it back on a new
phone. We can't read it." On by default once the owner has confirmed their
phrase; a backup they can't restore is no use without it.

Settings → Backup shows the last copy's date, a "Back up now" button, where
copies go, and "Delete all backups".

## 5. What changes

| Part | Change |
|---|---|
| `packages/core/src/export/archive.ts` | Seal and open under a raw key as well as a passphrase; the signed DID, handle, counter and time inside; the tender tables added, with open tenders and drafts restored as lapsed. |
| `packages/core/src/crypto/hkdf.ts` | Call `deriveBackupKey` with the fixed salt; derive the backup signing key; frozen test vectors. |
| New `packages/core/src/backup/` | Schedule, counter, store client (signed requests), restore listing. |
| New `apps/backup-service` | The store: four routes and the backup-key check of §4.3, around `managed_store.ts` (which replaces an object of the same name today, so it gains a refuse-if-present write for immutable copies); retention, limits, SQLite or object storage. |
| Mobile | The offer, Settings → Backup, and recovery that looks for a copy before asking for the handle. |
| Home Node Lite | The nightly job. |
| `deploy/managed/infra` | `BACKUP_HOST`, gated like the other optional services. |
| `docs/DISASTER_RECOVERY_PLAN.md` | Add the backup store to what it protects. |

Tests: frozen key and `backup_id` vectors; seal and open; a wrong seed
fails; a request signed by a key that does not hash to the `backup_id` is
refused, and so is a replayed nonce; restoring counter 10 while 11–20 are
kept, then backing up, makes counter 21 and keeps 11–20; listing and fetching
copies work with DID resolution down; delete removes every copy; a round trip keeps completed tenders,
their members and draft states, and closes open ones as lapsed; an
end-to-end lose-and-restore run on the simulator with only the 24 words.

## 6. Security and privacy

- **A breach of the store** gives sealed bytes, `backup_id`s, sizes and
  times. The contents stay sealed, and no DID is stored beside them.
- **Someone with the 24 words** can restore the data. That is already true
  of the identity; the words now guard the data too. The app should say so
  when it shows them.
- **An old copy served back.** The store can't forge a copy, but it can
  hold back the newest ones. A device that is still running warns when the
  store returns an older counter than it last wrote. A new phone after a loss
  has nothing to compare with; it shows "this copy is from 3 October" and the
  owner judges. A signed "latest counter" record kept off the store (on the
  PDS, say) would close this gap; later (§7).
- **What we learn:** that a `backup_id` exists, how big its copies are, when
  it backs up, and from which IP address. Linking a `backup_id` to a DID
  takes the IP address or timing.
- **Deleting:** "Delete all backups" removes the copies from the store. The
  store's own backups age out on their schedule (disaster recovery plan
  §4.4), and the app should say how long that takes.

## 7. Later

- A cold archive no one can delete for a set time (the old spec's Tier 5).
- Getting the 24 words back through trusted contacts (Shamir split; old
  spec, `docs/ROADMAP.md` item 2.21).
- Backing up only what changed, once copies grow large.
- A signed "latest counter" record outside the store, so a new phone can tell
  when the store holds back newer copies.

## 8. Decisions (settled 2026-10-21)

1. **Where:** our store at `backup.dinakernel.com`, with the person's own
   iCloud Drive or Google Drive as an option.
2. **Default:** on, once the person has confirmed their recovery phrase.
3. **Limits and price:** free at first, with a size cap per `backup_id`, and
   7 daily and 4 weekly copies kept. The cap and any price are set once real
   sizes are known.
