# Shared infrastructure — disaster recovery and backup plan

**Status:** DESIGN, 2026-10-03. Nothing here is built. Today there are no
backups of the shared infrastructure, and four of its most important secrets
exist only on the servers (§1.2).
**Scope:** the shared services every Home Node depends on — the community PDS,
the AppView (ingester, scorer, web, Postgres, Jetstream), MsgBox, the grants
service, Caddy, DNS, secrets and operator access — on prod and test.
**Out of scope:** users' own Home Nodes (they have archive export/import);
the legacy Go managed-hosting compose (`deploy/managed/docker-compose.prod.yml`,
not deployed); the PLC directory (`plc.directory`, run by Bluesky); the app
stores.

Some recoveries need new protocol or product work that this plan does not
design. They are listed in §10 as **open problems**, each with the rule that
applies until it is solved; where that rule is a residual risk rather than
fail-closed, the row says so.

---

## 1. What exists today

### 1.1 Servers and data

Each environment runs every shared service as Docker containers on **one
Hetzner Cloud server**, deployed by `deploy/managed/infra/deploy_shared_infra.sh`
from `deploy/managed/infra/docker-compose.infra.yml`. All state lives in Docker
volumes on the root disk (`/var/lib/docker/volumes`). Every service has
`restart: always`.

| | Prod | Test |
|---|---|---|
| Location | Ashburn (`ash-dc1`, network zone `us-east`) | Helsinki (`hel1-dc2`, `eu-central`) |
| Disk in use | 13 GB of 150 GB | 28 GB of 75 GB |
| Hosted PDS accounts | 66 | several hundred (test identities) |

Measured on 2026-10-02:

| Service | Volume | Holds | Prod size | If lost |
|---|---|---|---|---|
| **PDS** (`ghcr.io/bluesky-social/pds:0.4`, a tag) | `pds-data` | `account.sqlite` (accounts, password hashes, emails, sessions, each repo's current root); `sequencer.sqlite` (the firehose backlog); `did_cache.sqlite` (a cache); per account `actors/<shard>/<did>/store.sqlite` (the repo: PeerLens records, catalogues, service listings, commerce epochs; its blob table) and `actors/<shard>/<did>/key` (the account's 32-byte atproto repo signing key); `blocks/` (blobs). 69 SQLite files, all in WAL mode. | 18 MB | **Catastrophic.** Every hosted account's records and repo signing keys are gone; their DIDs still point at `pds.dinakernel.com`, which no longer knows them. Nothing else holds a full copy. |
| **AppView Postgres** (`postgres:17`, a tag) | `postgres-data` | the index of every PeerLens and commerce record; computed scores; **moderation state** — audit rows *and* enforcement flags set directly on subject, attestation and service rows (`appview/src/admin/peerlens-moderation-cli.ts`); historical dispute tombstones from deletions (`appview/src/ingester/deletion-handler.ts`); the ingester's cursor (`ingester_cursor`) | 66 MB | **Severe.** The index can be rebuilt from the PDS only partly (§8); moderation state and tombstones exist nowhere else. |
| **Grants** | `grants-data` | `grants.sqlite` — an identity-free ledger with four columns per grant: `grant_id`, `or_key_id` (the minted OpenRouter key), `platform`, `granted_at`. The daily ceiling is a **count** of grants over the last 24 hours. Grant amounts are not stored here (OpenRouter holds each key's limit). The once-per-device guard is held by Apple DeviceCheck and Google Play. | 380 KB | **Serious.** The record of minted keys is lost, and the 24-hour count restarts, so the service could exceed its ceiling for up to a day. |
| **MsgBox** (built locally) | `msgbox-data` | the buffer of messages accepted for recipients who are offline or have not acked (24 h TTL) | 4 MB | **Serious.** A sender treats MsgBox's `buffered` answer as sent and never retries (`packages/core/src/d2d/send.ts`), and since 1.1.0 MsgBox keeps messages until the recipient acks them, so the buffer is the only copy of every accepted, undelivered message — orders, khata entries, invites, approvals. |
| **AppView ingester, scorer, web; grants service** (built locally) | — | no state of their own | — | Rebuilt from source, if the exact image is kept (§4.3). |
| **Jetstream** (`jetstream:sha-e027425`, a tag) | none | a short buffer of recent firehose events inside its container (default about a day; phase 1 confirms the setting), lost when the container is recreated | — | Nothing durable to lose. While the container survives, it can replay its buffer to a restored ingester. |
| **Caddy** | `caddy-data`, `caddy-config` | TLS certificates, their private keys, the ACME account | small | Re-issued automatically once DNS points at the server — which is too late to check a replacement before cutover (§5.6). Backed up for that reason (§4.2). |

### 1.2 Secrets and access

| Secret | Where it lives today | Copies |
|---|---|---|
| `PDS_ROTATION_KEY` (the PDS's PLC rotation key), `PDS_JWT_SECRET`, `PDS_ADMIN_PASSWORD`, `POSTGRES_PASSWORD` | **only** `$REMOTE_DIR/deploy/.env` on each server, generated there on first deploy by `generate_secrets`; never synced back | inside each server's disk, so also inside Hetzner backups and snapshots of it — **nowhere off Hetzner** |
| Grants and app-attestation keys: `OPENROUTER_PROVISIONING_KEY`, `DEVICECHECK_PRIVATE_KEY`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` and related | `deploy/managed/infra/infra-prod.env` / `infra-test.env` on the operator's laptop (gitignored), written by every deploy into a managed grants block in the server's `deploy/.env` (`sync_grants_env`) | the laptop, and the server |
| SSH private key for both servers | the operator's laptop | none known |

`generate_secrets` creates new values whenever `deploy/.env` is missing, so
running `deploy` against a rebuilt server today would silently mint a new
rotation key and JWT secret instead of restoring the old ones.

**Who holds PLC authority over a hosted DID.** Mobile onboarding passes the
owner's own secp256k1 key (derived from their recovery phrase, `m/9999'/2'/0'`)
as `recoveryKey` when the PDS creates the account
(`apps/mobile/src/onboarding/provision.ts`; `dina_details.md`), so an
app-created DID lists the owner's key as a rotation key with higher priority
than the PDS's. The PDS's key lets the PDS sign PLC operations (handle changes,
its own key changes); the owner's key can override those within PLC's 72-hour
window and can move the DID without the PDS. A DID document also carries a
separate `dina-messaging` service entry pointing at MsgBox
(`packages/home-node/src/plc_dina_update.ts`). Accounts created another way
(test identities, CLI-made accounts) may have no owner key; they are listed per
environment before any PLC procedure.

### 1.3 DNS and backups

- **DNS** for `dinakernel.com` is at Namecheap (`dns1/dns2.registrar-servers.com`);
  service records have 30-minute TTLs.
- **Backups:** the repo contains no backup tooling. Whether Hetzner's server
  backups are on is not visible from here. Each server's public IPv4 is a
  Hetzner Primary IP; whether it survives server deletion is not known.

## 2. What can go wrong

| # | Event | Example | Cost today |
|---|---|---|---|
| E1 | Bad deploy or migration | a migration corrupts Postgres; a PDS upgrade damages its databases | permanent loss of what it damaged |
| E2 | Accidental deletion | `docker compose down -v`; a wrong `docker volume rm` | permanent loss |
| E3a | Server's disk or host fails | hardware failure | everything on it, including the only copy of `deploy/.env` |
| E3b | Server deleted by mistake | wrong server deleted in the console | as E3a, and Hetzner's automatic backups go with it |
| E4 | Location outage | Ashburn unavailable for days | full outage |
| E5 | Provider account lost | Hetzner account suspended; console unreachable | everything, both environments, and no way to manage the old servers |
| E6 | Compromise | root on a server; stolen backup credentials | data; every secret and repo signing key on the server; any backups the server can change |
| E7 | Operator laptop lost or compromised | theft, failure, malware | SSH access; grants secrets; anything else stored only there |
| E8 | Domain lost | registrar account taken over; registration lapses | every service unreachable by name; the PDS and MsgBox host names are in every hosted DID; after a takeover, whoever holds the domain can get certificates for every host name and impersonate the PDS (receiving the passwords apps log in with), the AppView and MsgBox |
| E9 | PDS rotation key lost or leaked | lost with the server; copied by an attacker | lost: the PDS can no longer sign PLC operations; leaked: someone else can, until owners override |
| E10 | Blob bucket's provider lost (once blobs live in a bucket, §4.9) | that provider's outage or account suspension, while the server keeps running | every photo unreachable; blobs published since the last archive run lost |

## 3. Objectives

| Data | Recovery point | Recovery time, E1–E3 | Recovery time, E4–E5 |
|---|---|---|---|
| PDS | **24 hours now; 1 hour once hourly captures are proven** (§4.2, phase 2) | 4 hours | 24 hours |
| AppView Postgres | same capture as the PDS | 4 hours | 24 hours |
| Grants ledger | same capture | 4 hours (then paused up to 24 hours, R6) | 24 hours |
| MsgBox buffer | same capture | 4 hours | 24 hours |
| PDS blobs (once in a bucket, §4.9) | the capture's, since restores use only blob-complete captures; for E10, the last archive run (within an hour of each capture) | 4 hours | 24 hours (E10: 4 hours, R14) |
| Moderation decisions | none (journalled at the second provider before each takes effect, §4.2) | — | — |
| Secrets | none (copied when created or changed) | — | — |

For E5 the recovery point is longer by the mirror's lag: a capture reaches layer
3 up to 2 hours after it is taken (the mirror's alert, §4.7), so E5 can lose the
capture interval plus 2 hours — 26 hours now, 3 hours once hourly captures are
trusted. The age of the newest trusted capture present in layer 3, which
`backup-status` shows (§4.7), is this number. E8 has its own, longer objective
(R9). The targets
are set by what one operator can do; storage is not the limit. Decision D4
(§13).

## 4. Design

### 4.1 Three copies, two providers

1. **Hetzner server backups (daily, whole disk), plus protection.** Switched on
   for both servers: up to seven daily backups, which include our data because
   the volumes are on the root disk. **They are deleted with the server.**
   Hetzner delete and rebuild protection on both servers prevents E3b. Used only
   to bring back a server's system quickly (E1, E3a); never as the source of a
   database (a disk image taken while SQLite writes is not guaranteed
   consistent).
2. **Encrypted restic backups to Hetzner Object Storage in another location.**
   [restic](https://restic.net) repositories (encrypted, deduplicated,
   incremental) in Hetzner's S3-compatible Object Storage, which exists only in
   Nuremberg, Falkenstein and Helsinki: prod (Ashburn) backs up to Falkenstein,
   test (Helsinki) to Nuremberg. Covers E1–E4.
3. **A versioned, lock-protected mirror at a second provider.** After each
   capture, the layer 2 repository is mirrored to a Backblaze B2 bucket that the
   server cannot destroy (§4.5). Covers E5 and E6.

### 4.2 Captures

Each run copies the databases into a staging directory on a tmpfs (capped at
twice their total size, checked before the run starts; about 200 MB on prod
today), wiped on every exit, then `restic backup --host <server-id> --tag <kind>`
stores it together with the image cache (§4.3). The server ID tag lets
restore selection and status ignore snapshots written by a fenced server (§5.3).

**What a capture contains:**

- **PDS:** `account.sqlite` and `sequencer.sqlite` first, then the actor stores
  and key files, then everything under `blocks/` (until blobs move to a bucket,
  §4.9) — each file is copied before
  what it refers to, so anything a copied file names was copied after it and is
  at least as new. (Commits made during the copy can therefore be in a store but
  missing from the copied sequencer; the AppView misses those until replayed or
  rebuilt, §8.) `did_cache.sqlite` is a cache and is skipped.
- **How SQLite files are copied:** with `VACUUM INTO '<dest>'`, never by file
  copy (a file copy of a WAL database can catch a half-written state).
  - `VACUUM INTO` reads one consistent snapshot, like SQLite's online backup,
    but writes a fresh, compacted file. `.backup` copies the database's pages
    as they are, free pages included, and those can still hold deleted rows —
    which would then reach every capture and defeat the deletion bound (§4.4).
  - It can renumber the implicit rowids of tables without an `INTEGER PRIMARY
    KEY`. Phase 1 lists such tables in the PDS, MsgBox and grants databases and
    confirms nothing reads those rowids; a database where something does falls
    back to `.backup`, and the deletion text names it.
  - A WAL database can be opened only by a connection able to write its `-shm`
    file, so the backup container mounts the data volumes read-write and runs
    `sqlite3` as the owner of each volume's files — root where the service
    itself runs as root (the grants image has no `USER` today) — so any `-shm`
    or `-wal` file it creates belongs to the service. Phase 1 records each
    volume's owner. On the nightly stopped capture, a database with no `-wal`
    file left is opened with `immutable=1`, which needs no `-shm`.
- **MsgBox:** its buffer database. Restoring it may deliver a message twice;
  receivers discard repeats (the D2D replay check, and the client's persistent
  handled-message record).
- **Grants:** `grants.sqlite`.
- **AppView:** `pg_dump --format=custom` of `dina_trust` and
  `pg_dumpall --globals-only --no-role-passwords`, both as a read-only role
  (§4.3). Role passwords come from `deploy/.env` at restore time.
- **Caddy:** `caddy-data` (certificates and their private keys), so a replacement
  can be checked under its real host names before cutover (§5.6).
- **Secrets:** `deploy/.env` (including its managed grants block), inside the
  encrypted snapshot, so a restore never depends on `generate_secrets`.
- **The deploy folder as it runs:** the generated `Caddyfile` (written per
  environment by `generate_caddyfile`) and the compose file as edited on the
  server (`prepare_compose` sets `PDS_HOSTNAME` and the build paths), since the
  git tree holds neither as deployed.
- **A rollback override,** if one is active (`docker-compose.rollback.yml`,
  §4.3), since the git checkout a restore starts from does not hold it.
- **A manifest:** time; environment; server ID; the deployed commit (§4.3); for
  every service its compose image reference, image ID and, where present,
  registry digest; the
  Postgres migration level; per file size and SHA-256; per SQLite file its
  `PRAGMA integrity_check` result; counts of moderation-flagged rows and
  tombstones in the AppView and of grants rows; and the PDS check result below.

**Moderation decisions are also journalled off-server as they happen**, in a
**journal bucket** at the second provider — a B2 bucket per environment,
separate from the layer 3 bucket so the mirror never touches it, versioned, with
30 days' default retention and a lifecycle rule that hides each object 12 months
after upload and deletes a hidden version 45 days after it was hidden. So an
entry someone hides early (the write keys can hide) stays recoverable for 45
days, inside the detection window: the check host keeps an inventory of journal
objects (with a list-only key) and alerts when one is hidden before its time.

- The operator runs the moderation CLI — and, once catalogue photos ship, the
  photo takedown CLI (`catalog-photo takedown`) and purges (R13) — on the server
  only through a wrapper, `dina-moderate`, which takes the environment lock (§4.3), so actions run one
  at a time and never during a capture. It runs the CLI as a one-off container
  from the AppView image (`dina-compose run --rm --no-deps appview-web …`), so
  it works while `appview-web` is stopped.
- For each action it writes two objects, each named by UTC time (to the
  microsecond), server ID and a random suffix that together form the action's
  ID: an **intent** before the CLI runs (operator, subject id, action, reason),
  then an **outcome** after the CLI exits. The wrapper adds the action ID to the
  reason it passes to the CLI, so the CLI's own audit row — written in the same
  transaction as the change — carries it. The CLI's database connection also
  carries the action ID as its `application_name` (set in the `DATABASE_URL`
  the wrapper passes to the container). The outcome is decided by
  that row, not by the CLI's exit code, and only once the CLI's transaction has
  finished — that is, once no Postgres session with that `application_name`
  remains (`pg_stat_activity`), since a COMMIT sent just before the CLI died can
  still be completing: then **committed** if the row exists, **failed** if it
  does not. If the wrapper cannot establish either (the database is
  unreachable, or the session lingers past a time limit), the outcome is
  **indeterminate**. If the intent cannot be written, the action is refused; if
  the outcome cannot be written, the wrapper retries and alerts.
- Each object is encrypted with `age` to a recipient key whose secret half is
  held only in the password manager and the offline store (§4.6), so the server
  can add entries but cannot read old ones.
- The wrapper's key, in `/etc/dina-backup/moderation.env` (read by the wrapper
  only, never by a service), can write files to the journal bucket and nothing
  else.
- The backup job ships the PDS's account-deletion events to the same bucket
  hourly, in the same form, with its own write-only journal key in
  `backup.env`.

Every moderation action sets a state (take down or restore, tombstone or
untombstone), so recovery needs no position in the journal: for each subject the
journal names, R7 compares the restored state with the state its last committed
action set, and acts **only where they differ**. Applying an action again is not
harmless — the CLI writes a new audit row and new time and reason every time
(`peerlens-moderation-cli.ts`) — so skipping subjects already in the right state
keeps their original takedown times, reasons and audit trail.

- **Reading it back** happens on the operator's machine, never on a server: a
  read-only journal key and the `age` secret (both in the password manager)
  list and decrypt the entries there, and the operator's machine then applies
  them through `dina-moderate` over SSH.
- **Hidden entries:** the wrapper's key can hide objects (on a versioned bucket a
  delete only adds a hide marker), so replay reads every version the bucket
  still holds, not only current objects.
- **Missing targets:** the CLI refuses an action on a record that is not in the
  database (`appview/src/admin/peerlens-moderation-cli.ts`), so replay skips and
  lists such targets — records deleted since, or created after the capture —
  instead of stopping. R7 replays again once the AppView has caught up. A
  takedown whose record returns later (its author republishes it) is not
  applied automatically: moderation carried by stable identifier is part of P1
  (§10), and until then the operator re-runs the replay after any rebuild or
  catch-up.

**Two kinds of capture, and how far each is trusted:**

- **Nightly stopped capture — trusted.** At the quietest hour (decision D3), the
  host stops the PDS (`docker compose stop -t 30 pds`), checks it exited on its
  own (exit code 0, not 137, which means it was killed), copies, and starts it
  again: under a minute of PDS downtime, during which Home Nodes retry. A killed
  PDS marks the capture `unverified`.
- **Hourly online capture — not yet trusted.** The PDS keeps running. After
  copying, the run checks:
  - every account row has an actor store and key, and every actor store has an
    account row (a store with no row means an account was created during the
    copy; the capture is then `inconsistent`);
  - each account's repo root in `account.sqlite` is at or behind the root in its
    copied store (never ahead);
  - every blob a copied store lists is present in the copied `blocks/` (once
    blobs live in a bucket, in the bucket, §4.9).

  A capture passing all three is marked `checked`; otherwise `inconsistent`.
  These checks cover what the plan knows the PDS relates across files; they are
  not proof that a `checked` capture restores cleanly. Phase 2 proves it: under
  synthetic writes (account creation, record writes, blob uploads and
  deletions), restore 50 hourly captures and confirm each PDS starts, serves
  every repo and passes the verification checklist. Until that passes, restores
  default to the newest nightly capture and the recovery point is 24 hours.
  Decision D3 offers a stopped capture every six hours as the interim instead.

**A damaged file does not stop the run.** If one database fails its integrity
check, the run backs up everything else, keeps that file's last good copy,
marks the snapshot `partial` and alerts.

### 4.3 How it runs

- **A host script** (`/usr/local/sbin/dina-backup`, installed from
  `deploy/managed/infra/backup/`) driven by systemd timers (hourly; nightly
  stopped; mirror after each capture; weekly check and prune on layer 2; weekly
  check on layer 3; monthly restore test). It enforces a time limit and on
  **every** exit path (a `trap`) starts the PDS again if it stopped it. Captures
  refuse to run while the restore flag (`/etc/dina-backup/RESTORING`, §5.5) is
  present.
- **One lock for every operation that changes the server:** captures, deploys,
  migrations, restores and moderation actions all hold the same environment
  lock (`/run/dina-ops.lock`), so a deploy waits for a capture to finish and a
  capture waits for a deploy, and no capture spans two deployments. The
  manifest's image list and commit are read inside the lock.
  - Each operation takes the lock **once**, at its top: a capture in its systemd
    unit (`flock /run/dina-ops.lock dina-backup …`); a deploy by syncing its
    files to a staging folder and then running all its server-side steps —
    moving the files into place first — as one remote script in one SSH session
    (today `deploy_shared_infra.sh` makes a separate `ssh` call per step); a
    repair or restore by the operator starting a **hold** (`dina-ops hold
    <reason>`), which takes the lock and keeps it until released.
  - A hold listens on a Unix socket only root can use, and runs each command
    submitted with `dina-ops run <command>` **as its own child**. Children
    inherit the locked file descriptor (its number in `DINA_OPS_LOCK_FD`) and
    confirm it with `flock -n` on that descriptor, which succeeds only on the
    same lock; the lock stays held while any child runs, even if the hold
    process exits, and once the hold is gone `dina-ops run` refuses. This is how
    work joins a repair: the operator's journal replay
    (`dina-ops run 'dina-moderate --batch'`, with the action list sent over the
    SSH connection) and a rollback (below). A tool started any other way has no
    inherited descriptor, so it takes the lock itself and waits.
  - Waiting for the lock gives up after 30 minutes and alerts.
- **Rollback is not a deploy, and covers only what is repaired:**
  `deploy_shared_infra.sh rollback <env> --capture <id> --services <list>` runs
  only inside a hold (its remote script submitted through `dina-ops run`).
  - It loads the named services' images from that capture instead of building,
    and pins **only those services** to them with a compose override file
    (`docker-compose.rollback.yml`, recorded in `DEPLOYED_COMMIT`). The tree and
    every other service stay as they are, because R1 and R2 restore one
    component's data and the others keep their newer data — older AppView code,
    for one, cannot run on a database a later migration has renamed tables in
    (`appview/drizzle/0011_rename_peerview_to_peerlens.sql`).
  - It **starts, restarts, reloads and migrates nothing**, so the runbook decides
    which service starts when.
  - It is exempt from the freshness gate (§4.7), since a repair may need it
    exactly when captures have stopped, and reports the capture's age.
  - Containers keep the image they were created from, so a rolled-back service
    is started with `docker compose up -d --no-deps <service>` — never `start`
    or `restart`, which would bring back the bad image. Before the hold is
    released, each rolled-back service's container must run the capture's image
    ID, and every other service must run the image it ran when the hold began
    (recorded then).
  - Before rolling back, the operator checks that the rolled-back services can
    work with the services that keep their newer code (their data comes from the
    same capture, so their own schema matches). Where that is doubtful, the
    repair becomes a full recovery from one capture (R3 on the same server,
    principle 1), which rolls everything back together.
  - **The override must hold until a fix ships.** Compose reads an extra file
    only when told to, so every compose command on the server — the deploy
    script, `reload-caddy`, `status`, `logs`, the backup host script's nightly
    stop and start, and the operator's own — goes through one wrapper,
    `dina-compose`, which adds the override whenever it exists. Every
    `rsync --delete` excludes it. A deploy refuses while it exists unless the
    operator passes `--replaces-rollback`, confirming the shipped commit fixes
    the rolled-back service; that deploy removes it. `backup-status` reports an
    active override and its age.
- **The backup container** (Alpine with `sqlite`, the Postgres 17 client,
  `restic`, `rclone`, `curl`) is a compose service under a `backup` profile, so
  `docker compose up -d` never starts it; the host script runs it with
  `docker compose run --rm backup`. It mounts the data volumes read-write only
  so SQLite can keep its `-shm` files (§4.2), writes nothing else to them, and
  **never mounts the Docker socket**: stopping and starting the PDS is
  the host script's job, so the container holding bucket credentials cannot
  control the host.
- **Credentials:** `/etc/dina-backup/backup.env` (root, mode 0600), outside the
  folder the deploy script syncs with `--delete`. It holds the restic repository
  password, the layer 2 bucket key, the layer 3 key (§4.5), the journal key that
  ships account deletions (§4.2), and the password of a Postgres role,
  `dina_backup`, granted `pg_read_all_data` only. The services
  never see this file.
- **Deployed commit:** `deploy_shared_infra.sh` writes `DEPLOYED_COMMIT` (git SHA,
  dirty flag, component stamps) to the server on every deploy, and prod deploys
  refuse a dirty tree in any synced folder. The generated `Caddyfile` stops being
  tracked in git (today it is, with test host names, and every deploy rewrites
  it), and generated files are outside the check.
- **Exact images:** compose pins every third-party image by registry digest
  (PDS, Postgres, Caddy, and Jetstream, which today is a `sha-…` tag, not a
  digest). An image cache on disk (`/var/cache/dina-backup/images/`) holds a
  `docker save` archive of every running image — third-party and the locally
  built MsgBox, AppView and grants images — named by image ID. The deploy
  script writes a new image's archive inside the lock, before the services
  restart on it; any capture that finds a running image missing from the cache
  writes it first (no PDS stop is needed) and is marked `untrusted` if it
  cannot. Archives of images no longer running are removed from the cache.
  Every capture includes the cache; restic skips unchanged files by their
  metadata, so this costs little, and an image's archive lives as long as the
  captures that ran it. A restore can always run the exact binaries that wrote
  the data, without a registry or a build.
  - An archive saved by image ID loads with no name, so compose cannot find it
    by the references it uses (registry digests, or the names of locally built
    services). A restore therefore tags each loaded image locally
    (`dina-restore/<service>:<capture>`), writes a **pin override**
    (`docker-compose.pin.yml`) naming each service's tag, and starts services
    with `--pull never --no-build`. The pin override gets the rollback
    override's protections: `dina-compose` adds it, every `rsync --delete`
    excludes it, and `backup-status` reports it. `dina-compose` stacks the files
    as base, then pin, then rollback, so a rollback made after a restore wins.
    The next ordinary deploy replaces the pin override. The monthly restore test
    does the same with no registry access.
- **Commands:** `deploy_shared_infra.sh` gains `rollback <env> --capture <id>
  --services <list>` (above), `backup-now <env>`,
  `backup-status <env>` (last success per job and per layer; snapshots from this
  server only) and `restore-test <env>` (§7).

### 4.4 Retention and the deletion bound

- **Layer 2, weekly:**
  - `restic forget --tag hourly --group-by '' --keep-within-hourly 48h` and
    `restic forget --tag nightly --group-by '' --keep-within-daily 30d
    --keep-within-weekly 84d --keep-within-monthly 365d`. `--group-by ''`
    makes the rules span every server ID — by default restic groups by host,
    and `--keep-within` counts from the newest snapshot in each group, so a
    replaced server's snapshots would be kept for ever;
  - then an **absolute rule:** every snapshot older than 12 months and a week by
    its own timestamp is forgotten, whatever its host or tags (a short script
    over `restic snapshots --json`), so nothing depends on new captures arriving;
  - then `restic prune --max-unused 0`, which repacks partly used packs, so no
    data from a forgotten snapshot is left behind in a pack another snapshot
    still uses.
- **Layer 3** follows layer 2 file for file (§4.5), so its current files are
  layer 2's. A file layer 2 deletes becomes a hidden version in layer 3, which a
  lifecycle rule removes 45 days after hiding — once its object lock (§4.5) has
  expired.
- **Retired repositories:** R8 copies the snapshots worth keeping into a new
  repository, where they keep their original timestamps and the rules above
  expire them; the old repository and both its buckets are deleted 30 days after
  R8 (the lock period). Under R4, the abandoned Hetzner layer 2 bucket is deleted
  within 30 days of Hetzner access returning. Either can be kept longer only
  under an incident hold recorded in the drill log with a review date.
- **Exceptions are tracked:** every copy that cannot be deleted on schedule — an
  abandoned bucket at a provider we cannot reach, or one under an incident hold
  — is listed in the drill log with its last snapshot date, until its deletion
  is confirmed.
- **Layer 1:** seven days (Hetzner). Manual snapshots: deleted after 30 days.
- **Quarantine copies** made during a recovery (R1, R2): deleted after 30 days
  unless an incident hold is recorded in the drill log with a review date.
- **Journal bucket:** each object hidden 12 months after upload and deleted 45
  days later.
- **Blob bucket (§4.9):** non-current versions 30 days after they stop being
  current.
- **Blob archive (§4.9):** a blob is deleted, every version, by the weekly
  check-host job once no capture still needs it and two weeks have passed — at
  most about 13 months after the PDS deleted it. A purge (R13) removes it at
  once.
- **Staging and scratch copies:** deleted when the run ends.

So data deleted from its live source is gone from every backup within 14
months: at most 12 months and a week in layer 2, plus 45 days as a non-current
version in layer 3, plus a day for the lifecycle run — about 13 and a half
months. (SQLite captures are written with `VACUUM INTO`, so deleted rows do not
linger in copied free pages, §4.2.) A deleted PDS account qualifies. **Its records in the AppView do not:**
today the AppView keeps a deleted account's indexed records (P8, §10), so every
new Postgres capture includes them again, and they leave the backups only 14
months after P8 removes them from the AppView. Copies listed as exceptions
above are also outside the bound until deleted. The account-deletion text in the
app and on the PDS says all three things.

### 4.5 Protecting backups from a compromised server or laptop

- **Layer 2:** Hetzner Object Storage credentials apply to every bucket in a
  Hetzner project, with no write-only or per-bucket key (phase 1 confirms). So
  each environment's bucket lives in its **own Hetzner project**, and test's key
  can never touch prod's backups. The layer 2 key on a server **can delete** that
  server's backups; layer 3 is the only copy a compromised server cannot destroy.
  Layer 2 has no object lock, deliberately: prune must free data at once for
  the deletion bound (§4.4), and layer 3 is the protected copy.
- **Layer 3** is a B2 bucket reached through its S3 API, with versioning and
  object lock in compliance mode. After each capture the host runs
  `rclone sync --size-only --immutable --s3-no-head --s3-no-check-bucket
  --exclude 'locks/**'` from layer 2 to layer 3. restic names its files by
  content hash, so name and size are a safe comparison; `--s3-no-head` stops
  rclone reading each object back after uploading it, and
  `--s3-no-check-bucket` stops it probing the bucket, so no read rights are
  needed; `--immutable` makes the run fail,
  and alert, if a file in layer 3 differs from layer 2 instead of overwriting
  it, so unchanged files never gain new versions. Layer 3 always holds a complete,
  current copy of the repository — including `config`, the key files and packs
  written years ago, which never expire while they are current.
  - The server's B2 key can list, write and hide files (on a versioned bucket a
    delete only adds a hide marker). It cannot read files or delete a version,
    and it has no
    right to change object-lock retention at all — a key that could extend
    compliance retention could also lock data for years, beyond the deletion
    bound, with no way back.
  - The bucket's default retention locks every new version for 30 days. A
    version that stops being current (hidden, or replaced by an overwrite) is
    removed by the lifecycle rule only 45 days later. So any version an attacker
    hides or overwrites — even `config`, written years ago and long unlocked —
    stays recoverable for 45 days, and the server's key can do nothing about it.
  - restic's `locks/` folder is excluded from the mirror, so lock files never
    reach layer 3, and the repository there can only be read with `--no-lock`.
- **What an attacker with the server's key can do:** hide or overwrite files in
  layer 3. **What they cannot do:** remove the versions underneath. Recovery
  copies the bucket as it stood before the attack into a clean bucket, with the
  historical view set on the source only, and restores from that (R5).
- **Detection inside the 45 days:** a weekly `restic check --read-data --no-lock`
  of layer 3 — which reads and authenticates every pack, so a same-size change to
  a pack's contents is caught, not only a changed name or size — plus a
  comparison of layer 3's current file list with layer 2's, plus a **snapshot
  inventory**: the check host keeps its own list of every snapshot it has seen,
  works out from §4.4's rules when each should expire, and alerts if one
  disappears earlier — so a server that forgets and prunes old snapshots with
  valid restic commands, leaving a repository that passes every check, is still
  caught well inside the 45 days. It also alerts when a new snapshot carries a
  time earlier than its previous run, the sign of a backdated snapshot. It runs on a **check host** that is not the
  server it protects (decision D8). The check host
  holds a read-only B2 key and the restic password, so it can decrypt every
  backup: it runs nothing else, takes logins only with the operator's SSH keys,
  is listed with the secrets it holds (§4.6). **Anyone with a read key and the
  restic password holds every secret in the backups**, so a lost or suspect
  check host — or any leak of both — is handled as R8 for every environment it
  checks: the servers are not rebuilt, but every secret R8 rotates is rotated,
  the repositories are replaced, R10 "Leaked" runs, and the PDS closes until P4
  exists.
- **Reading layer 3** — for R4, R5 and seeding a new layer 2 — uses a separate
  **recovery read key** (list and read only), kept in the password manager and
  never installed on a server except while R4 runs.
- **Whatever can delete or change layer 3 or the journal** — the Backblaze
  account login, its second factor and recovery codes, and the B2 master key —
  lives only with the offline store (§4.6), never in the everyday password
  manager, on a server or on the laptop: anyone who can log in to Backblaze can
  mint a master key, change lifecycle rules and delete every version no longer
  locked, including old `config`, key files and packs. So a compromised server
  or laptop can stop new backups, confuse layer 3's current files and (through
  the Hetzner login or a layer 2 key) delete layer 2, but cannot remove a
  version from layer 3 or the journal. Layer 3 is the copy every compromise
  runbook restores from.
- Phase 3 confirms each of these B2 behaviours (hide without delete rights;
  default retention on new versions; lifecycle removing only non-current
  versions, 45 days after they stop being current; version-at copies into a
  writable bucket; the
  mirror, with exactly the server's list, write and hide key and the flags
  above, completing a first full upload, an upload of new packs, and a second
  run over unchanged files that creates no new versions) before layer 3 is
  relied on.

### 4.6 Secrets and custody

- **Everyday password manager:** each server's `deploy/.env`; the grants
  secrets; `backup.env` and `moderation.env` (whose B2 keys cannot delete;
  `backup.env`'s layer 2 key can, §4.5); the journal's `age` secret key and
  read-only key; the layer 3 recovery read key; the
  check host's read-only B2 key and list-only journal key (it also holds the
  restic password, which is in `backup.env`); once blobs live in a bucket, the PDS's blob-bucket key (in
  `deploy/.env`), the archive's add-only key (in `backup.env`) and read-only
  keys to both buckets for the monthly restore test; the SSH key; an export of
  the DNS records; recovery codes for Hetzner and Namecheap.
- **Offline store** (a separate `age`-encrypted file on a device that is not the
  laptop, and not synced to it): everything above, plus everything that can
  destroy layer 3 or the journal — the Backblaze login, its recovery codes and
  the B2 master key (§4.5), and the admin keys of the blob bucket and archive
  (§4.9), and the purge-list signing key. Backblaze's second factor is kept
  with it. The archive's delete-capable key lives on the check host and here,
  never on a server. (Layer 2
  has nothing comparable to protect: its server key and the Hetzner login can
  already delete it, which is why layer 3 exists.)
  Its `age` identity is printed on paper and kept with the password manager's own
  recovery kit, apart from the laptop, so a clean device can open both without
  anything from the lost laptop.
- **Second factors:** a hardware key or authenticator that is not the laptop,
  plus printed recovery codes, for the password manager, Hetzner and Namecheap;
  Backblaze's are kept with the offline store.
- **SSH:** a second key, kept offline, is installed on both servers. As a last
  resort Hetzner's console can boot a server into its rescue system with a newly
  added key.
- **Whenever a secret changes,** the password manager entry (and the offline
  store, for destructive keys) is updated in the same session; `backup-status`
  warns when the server's `deploy/.env` hash differs from the one recorded at the
  last check-in.

### 4.7 Monitoring

- **One dead-man's-switch check per job per environment** (decision D2):
  hourly capture (alert after 2 hours), nightly stopped capture (26 hours),
  layer 3 mirror (2 hours), moderation journal writes (alert on any failure),
  account-deletion shipping (2 hours), journal inventory (8 days), blob archive
  runs and blob hash checks (§4.9; once blobs live in a bucket),
  weekly layer 2 check and prune (8 days), weekly layer 3 full-read check from
  another host (8 days), monthly restore test (32 days).
  Each job pings on success and reports failure explicitly; silence also alerts.
- **The number that matters most** — the age of the newest trusted capture
  present in layer 3 (and, once blobs live in a bucket, blob-complete, §4.9) —
  is shown by `backup-status`, and a prod deploy refuses to
  proceed while it is older than its objective (the **freshness gate**; a
  rollback, §4.3, is exempt).

### 4.8 Making recovery faster before it is needed

- **Keep the addresses:** turn off `auto_delete` and turn on delete protection
  for each server's existing Primary IP, so a replacement server in the same
  location takes the same address and no DNS change is needed (decision D5).
- **Lower the DNS TTL** on the service records from 30 to 5 minutes.
- **Protect the servers:** Hetzner delete and rebuild protection on both.
- **Protect the domain:** auto-renew, registration several years ahead,
  registrar lock, and a renewal reminder outside the registrar.

### 4.9 PDS blobs in object storage — required before catalogue photos ship

Catalogue photos (`docs/CATALOG_PHOTOS_PLAN.md`) will make blobs most of the
PDS's data: under that plan's limits a supplier tops out near 200 MiB, so a few
hundred suppliers would fill the prod server's 150 GB disk. So **before photos
ship, each PDS keeps its blobs in an S3-compatible bucket**
(`PDS_BLOBSTORE_S3_BUCKET` and related settings) instead of `blocks/` on disk.
Records name blobs by hash, so where the bytes live is a setting no record
mentions. The switch happens first, while the PDS holds a few megabytes (18 MB
on prod today); after photos launch it would mean moving a live, growing store.

Two buckets, at **two different providers**:

- **The blob bucket** — the one the PDS reads and writes. Versioned. The PDS's
  key (in `deploy/.env`) can read, write and delete; on a versioned bucket a
  delete only hides a blob, and the key must have no right to delete versions
  or change the bucket's settings. Non-current versions are removed after 30
  days: long enough to undo a mistake; the archive holds the long-term copy.
- **The blob archive** — append-only. Blobs never change once written (each is
  named by its hash), so the archive only ever adds. After every capture, the
  backup job copies into it each blob the capture's actor stores refer to that
  it does not yet hold (`rclone copy --files-from <cid list> --size-only
  --immutable --s3-no-head --s3-no-check-bucket`, never `sync`; the last two
  flags because its key cannot read, §4.5), reading with a read-only
  blob-bucket key from the bucket's versions where the current object is
  already gone.
  - The archive is versioned, and the server's archive key can list and upload
    but cannot delete any object or version or change settings. An upload can
    still replace a file's current version, so denying deletes alone does not
    make the archive append-only: the replaced version stays, the hash check
    below catches the change, and restores take the version whose bytes match.
    Where the provider can require create-only uploads (Amazon S3 can, with a
    bucket-policy condition on conditional writes), it does, and a replace is
    refused outright.
  - Deleting from the archive is the check host's job (below), so a compromised
    server cannot remove anything from it.

A capture is **blob-complete** once every blob it refers to is in the archive.
The manifest lists the CIDs its stores refer to. **Only the check host marks a
capture blob-complete**: hourly, for each new capture it lists the archive to
confirm every listed CID is present, and accepts the verdict the incremental
hash check (below) recorded for that object's current version, hashing only
versions it has not yet checked — so no blob is downloaded twice. It then
records the capture's CID list in its inventory and marks it complete there. Archive retention (below)
runs on the same host under the same local lock, so marking and deleting never
overlap. Restores, `backup-status` and the freshness gate read the check host's
marks, which it publishes as a status object.

A **purge list** names every CID removed outright (R13): a plain list of CIDs,
no content, **signed with an operator purge key held only in the offline
store**, so a server cannot forge an entry. It is kept as its own versioned
object in the journal bucket, outside the journal's lifecycle, rewritten on
every change and never expiring; each purge also gets a journal entry as its
audit record. Every job that looks for blobs — the archive job, the check
host's marking, hash checks and retention, R14 and restore checks — reads it
with a read-only key limited to that object (in `backup.env` and on the check
host). Purges only ever add, so a job reads **every version** of the object,
keeps those whose signature verifies (an unsigned or badly signed one is
ignored and alerts), and takes the union of their CIDs: an older, genuinely
signed list put back by a compromised server, or a hidden latest one, can
never drop a purge. A listed CID is absent on purpose: never fetched, copied,
restored or awaited.

- **The switch.** Copy `blocks/` into the blob bucket while the PDS runs, then
  start a hold, stop the PDS, copy what was added since, check that every blob
  each actor store refers to is in the bucket with bytes that match its CID,
  change the setting and start the PDS on the bucket. Run the canary
  (§5.6). Keep `blocks/` on disk, unchanged, until a nightly capture taken on
  the bucket has been restored by the monthly test; only then delete it.
- **Checking bytes, not just names.** The PDS's key can overwrite a blob, so the
  check host hashes every object added or changed since its last run, in both
  buckets, and alerts on any whose bytes do not match the CID in its name.
  Restores check every blob they need the same way, and take a matching version
  or the archive's copy when the current object does not match.
- **Archive retention, failing closed.** Weekly, the check host deletes from
  the archive (every version, with its own delete-capable key) the blobs no
  capture still needs. "Still needs" is worked out from the check host's own
  snapshot inventory (§4.5), not from what the repository holds now: the
  inventory records each capture's CID list when first seen, and a capture
  counts until its own expiry date, even if it has vanished from the
  repository. A blob must also have been unneeded for two weeks. Because the
  check host alone marks captures complete, under the same lock, a capture
  that refers to an old blob again (a republished photo) is either in the
  inventory before retention runs, which keeps the blob, or arrives after the
  deletion, finds the blob missing, and stays unmarked until the next archive
  run uploads it again from the blob bucket (where a current record keeps it).
  The job deletes nothing while the inventory has an unexplained-disappearance
  alert open, while any manifest could not be read, or while the last
  full-read check failed.
- **Removing content outright** (an illegal image, a legal order): R13. Neither
  bucket uses a compliance lock, so a purge is always possible with the admin
  keys in the offline store.
- **Test.** Test's blob bucket is Hetzner Object Storage in Helsinki, in its own
  Hetzner project (keys there cover every bucket in a project, §4.5), with its
  archive at a different provider. Hetzner keys cannot be limited, so test's
  PDS key can delete versions: test rehearses the switch, the archive and the
  restores, not the key limits, which are proven on prod's providers before
  prod switches (D10).
- **Monitoring.** Each archive run pings its own check; a capture the check host
  has not marked blob-complete within 2 hours alerts; the hash checks alert on any mismatch;
  `backup-status` shows both buckets' size and growth.

Until the switch, blobs stay in `blocks/` and are captured as today.

## 5. Recovery principles

Every full recovery (R1a, R3–R5, R8) follows these. R1, R2 and R12 repair one
component on a running server and are named exceptions to principle 1.

1. **One capture, never a mix.** The PDS, MsgBox, grants, Caddy data and Postgres
   all come from the same capture: the newest trusted one written by the server
   being replaced, unless the operator chooses an older one.
2. **Contain before restored data or services start.** Software is installed
   first, while the server holds no data: Docker from its package repository,
   and pinned `restic` and `rclone` binaries checked against recorded SHA-256
   sums (or pushed from the operator's machine). Then, before any restore, the
   replacement runs behind a firewall that blocks inbound traffic except from
   the operator **and** outbound traffic
   except to the backup buckets, the journal bucket and the blob bucket and
   archive (§4.9), the operator, DNS resolvers and `plc.directory`
   (MsgBox and the PDS resolve DIDs there, and verification runs with empty
   caches) — the provider's firewall
   (Hetzner Cloud Firewall) where the control plane works, and the host's own
   firewall (`nftables`, set before Docker starts) everywhere, including at
   another provider. A server built from a Hetzner disk image is first booted into
   the rescue system, where `/var/lib/docker` is deleted and `docker.service`
   disabled, so no container with `restart: always` comes back on the image's
   stale volumes.
3. **Fence the old server, with or without its provider.** Revoke the old
   server's layer 2, layer 3, journal, blob-bucket and archive keys (the
   replacement gets new ones), so
   it cannot write backups, journal entries or blobs even if it returns. Where Hetzner's control plane works, also
   power it off and detach its Primary IP. Where it does not (E5), the cutover is
   a DNS change, and **a DNS change is not a fence**: clients with a connection
   already open to the old server (MsgBox sockets are long-lived) keep using it
   until it drops. If the old server is still running, messages exchanged there
   in that time are lost when it stops (as in D6), and the operator cannot end
   those connections. This residual is accepted for E5, where Hetzner has usually
   stopped the servers already; an application-level fence (P7, §10) would close
   it. If the old server returns, it is powered off and its data is never trusted
   again.
   Failing back means running the recovery in reverse from a fresh capture of the
   replacement, never pointing DNS back at the old machine.
4. **Exact images.** Services start from the images saved in the restored
   capture (§4.3), not from tags or a fresh build.
5. **Secrets first.** `deploy/.env` is restored from the capture (or the password
   manager) before any deploy command runs, and `generate_secrets` refuses to
   create secrets when the restore flag (`/etc/dina-backup/RESTORING`) is present
   or the PDS volume is not empty.
6. **Check in two stages, then cut over.**
   - **Before cutover, contained:** first check the restored certificates'
     expiry. If they are valid for at least another day, run the checks below
     from the operator's machine against the replacement's address with the real
     host names (`curl --resolve <name>:443:<new-ip>`). If not — an older
     capture — or under R8, which does not restore them, run the checks against
     the services directly (their ports through an SSH tunnel), let Caddy issue
     certificates at cutover (ACME needs the public names), and run the TLS
     checks in the next stage.
   - **After cutover:** the same checks through public DNS. A failure there is a
     rollback trigger: move the names back to the contained-but-healthy state,
     never to the old server.
7. **Reconcile safety-critical changes before cutover** (R7): deletions and
   takedowns made after the capture are re-applied while the replacement is still
   contained. Reconciliation that cannot be completed (§10) is listed and
   disclosed, never skipped silently.

**Verification checklist** (every item checks a response, not just a status
code):

- `com.atproto.server.describeServer` answers with the expected DID and host.
- A dedicated canary account logs in, writes a record, reads it back, uploads a
  small blob and fetches it, and the new repo commit verifies against the
  account's signing key in its PLC document.
- The canary record appears in the AppView within 5 minutes (ingestion works).
- **First checkpoint, before reconciliation:** the AppView's moderation-flagged
  rows and tombstones, and the grants ledger's rows and newest entry, match the
  manifest.
- **Second checkpoint, after reconciliation:** every subject in the journal has
  the state of its last committed action, and a sample of taken-down subjects —
  including ones from the journal — is hidden from search.
- A MsgBox probe completes an authenticated round trip and exits with failure if
  no response arrives (`scripts/ops/msgbox_probe.ts`, a tracked replacement for
  the bed-only `dina-nodes/commerce/ack_probe.ts`, which exits 0 on any close).
- `/version` on MsgBox and AppView matches `DEPLOYED_COMMIT`'s stamps.

## 6. Runbooks

- **R1 — MsgBox or grants database damaged (E1, E2), server running.** Start a
  hold (§4.3) for the whole repair. Stop the service that writes the database.
  If a deploy caused the damage, roll back that service to the capture being
  restored (§4.3, `--services` naming it); nothing restarts. Move the database
  and its `-wal` and `-shm` files to a quarantine folder (§4.4), restore the
  database from the capture with the service's file ownership, run
  `PRAGMA integrity_check`, and start the service with `dina-compose up -d
  --no-deps`. For grants, R6 applies. Before releasing the hold, check every
  service's image as §4.3 requires.
- **R1a — PDS damaged (E1, E2), server running.** A PDS-only restore would leave
  Jetstream's cursor ahead of the restored sequencer (the PDS refuses a cursor
  from its future, and then skips the numbers in between) and the AppView
  holding records and catalogue pointers the PDS no longer has
  (`packages/commerce-protocol/src/catalog_publication.ts` would then refuse an
  owner's next catalogue as a fork). So PDS damage is repaired by a **full
  restore from one capture on the same server**. First: start a hold and set
  the restore flag; close Caddy's public routes and set the firewall (§5.2);
  stop every service (`dina-compose stop`) and confirm no container is running
  and no process holds the data volumes open. Docker cannot rename a volume and
  compose fixes each volume's name, so quarantine by copying on the host, which
  needs no image (the firewall would stop a pull): with every container stopped,
  copy each volume's data folder into a quarantine folder (`cp -a
  /var/lib/docker/volumes/<project>_pds-data/_data/.
  /var/lib/dina-quarantine/<date>/pds-data/`, and the same for the others),
  check each copy's file count and total size against its volume, then remove the stopped containers (`dina-compose rm -f`)
  and the old volumes (`docker volume rm`), so step 5 creates them empty under
  the same names. Then follow R3 from step 4, skipping what is already done
  (Docker running, the hold and the flag), with Jetstream recreated in step 7.
- **R2 — Postgres damaged (E1, E2), server running.** Start a hold (§4.3)
  for the whole repair. Stop `appview-ingester`,
  `appview-scorer` and `appview-web`; keep the Jetstream container running.
  Restore globals if roles are missing, then set each login role's password from
  its source (`ALTER ROLE`): `dina` from `deploy/.env` (`POSTGRES_PASSWORD`),
  `dina_backup` from `backup.env`. The recovery is not complete until a capture
  using `dina_backup` succeeds. `dropdb dina_trust`; `createdb -O dina dina_trust`;
  `pg_restore --exit-on-error --dbname dina_trust`. Check the manifest's counts.
  If a migration caused the damage, roll back the AppView services
  (`appview-ingester`, `appview-scorer`, `appview-web`) to the capture being
  restored (§4.3); nothing restarts and no migration runs. Check that the restored
  migration level matches the code about to run, and stop if it does not. Start the
  ingester and scorer, with `appview-web` (the public side) still stopped. The
  ingester resumes from the restored cursor; if Jetstream still holds events back
  to that cursor, the gap is replayed — wait for it to catch up — otherwise
  records written since the capture are missing from the index until the rebuild
  (§8, P1) exists, a known loss recorded in the drill log. Apply the journal
  (R7), verify effective suppression (a sample of taken-down subjects is
  hidden), then start `appview-web`. After a rollback, the rolled-back services
  start with `up -d --no-deps`, and before releasing the hold every service's
  image is checked as §4.3 requires.
- **R3 — server lost (E3a, E3b) or location lost (E4).**
  1. Fence the old server (§5.3), revoking its bucket keys. In the same location,
     detach its Primary IP for the replacement.
  2. Mint new keys: layer 2 (Hetzner console, in the environment's backup
     project), layer 3 and the two journal write keys (with the offline B2
     master key), and the blob-bucket and archive keys (with their admin keys). Record them in the password manager. Restores from layer 2
     read with the new layer 2 key.
  3. Create the replacement — same location for E3, another for E4 — contained
     (§5.2). In the same location it is created with the old Primary IP:
     Hetzner assigns a Primary IP only to a powered-off server, so it is given at
     creation, not moved at cutover, and the firewalls keep the server contained
     meanwhile. E3a quick path: restore the newest Hetzner backup, boot it into the
     rescue system, delete `/var/lib/docker` (the image's containers and volumes,
     which Docker would otherwise restart on stale data), disable
     `docker.service`, then boot normally. Otherwise: a fresh server, with Docker
     (disabled at boot), `restic` and `rclone` installed before the firewall
     closes (§5.2).
  4. Start Docker by hand (`systemctl start docker`; still disabled at boot).
     From here on, avoid reboots: the hold's lock lives in `/run`, so a reboot
     ends it; if one is needed, start a new hold and repeat step 8's checks.
     Push the tree at `DEPLOYED_COMMIT` from the operator's checkout with the
     deploy script's existing `rsync` (the server never clones from GitHub);
     write `/etc/dina-backup/backup.env` and `moderation.env` with the new keys;
     start a hold (§4.3); set the restore flag; `restic restore` the
     chosen capture.
  5. Make every server-side file the capture records match the capture
     exactly — `deploy/.env`, the generated `Caddyfile` and prepared compose
     file, `DEPLOYED_COMMIT` (written from the manifest) and the rollback
     override: restore each the capture holds, and delete any the capture lacks
     (a Hetzner disk image on the E3a path may carry older copies). Create empty
     volumes; load the saved images, tag them and write the pin override
     (§4.3). If the capture holds a rollback override, rewrite its image
     references to the new restore tags — the manifest's image IDs already
     include the rolled-back images — so it keeps its services listed for the
     deploy guard without naming tags that no longer exist. Restore the PDS,
     MsgBox, grants and Caddy files into the volumes with correct ownership.
     Where blobs live in a bucket, write the new blob-bucket key over the old one
     in the restored `deploy/.env` and the new archive key into `backup.env`;
     read the signed purge list and verify its signature; then check that every
     blob the
     restored stores refer to, except purged ones, is in the blob bucket with
     bytes matching its CID, bringing any missing or mismatched one back from
     a matching version or from the archive (§4.9).
  6. Start Postgres alone; restore globals, role passwords and `dina_trust` as in
     R2.
  7. Write the grants pause (R6). Start the PDS, MsgBox, grants and the AppView
     services, Caddy last, with `--pull never --no-build`; create Jetstream
     afresh (`--force-recreate`), so it holds no cursor from before the
     restore. Enable `docker.service` at boot.
  8. Check that every running container's image ID matches the restored
     manifest, recreating any that differs through `dina-compose up -d
     --no-deps`. Check the manifest's counts (§5.6, first checkpoint). Reconcile before
     cutover (R7). Verify, contained (§5.6, second checkpoint and the rest).
  9. Cut over: same location — open the firewall (the address is already the
     replacement's); another location — change the DNS records and open the
     firewall. Verify again through public DNS.
  10. Clear the restore flag; release the hold; take a fresh capture.
- **R4 — provider lost (E5).** R3 at another provider, from layer 3, with these
  differences: revoking the old server's Hetzner keys and minting new Hetzner
  ones is **deferred** until Hetzner access returns (the old layer 2 bucket is
  simply not used, and the host filter keeps the old server's later snapshots out
  of selection); the replacement's layer 2 is a bucket at an available
  provider, **seeded first by copying layer 3's current files** (`rclone copy`,
  reading layer 3 with the recovery read key, §4.5, installed only for the
  copy) — the same restic repository, so the mirror that follows keeps every
  pre-incident snapshot instead of hiding it — and **the restore then reads the
  seeded layer 2**, like R3; layer 3 and the journal continue with new server
  keys; if the blob bucket or archive was at the lost provider, R14 replaces
  it;
  containment uses the host's own firewall; and the cutover is by DNS, which is
  **unfenced** (§5.3). The objective is 24 hours.
- **R5 — layer 3 tampered with (E6).** Create a clean bucket with the offline
  master key. Copy layer 3 as it stood before the attack into it, with the
  historical view set on the source remote only —
  `rclone copy 'b2l3,version_at=<time>:<bucket>' b2clean:<new-bucket>`, where
  `b2l3` uses the recovery read key and `b2clean` a key for the new bucket — since
  `--s3-version-at` as a flag would apply to both remotes and make the
  destination read-only. Then `restic check --no-lock` the copy and restore from
  it with `restic restore --no-lock`. Report the time window of the tampering.
- **R6 — grants after any restore.** Before the grants container is created,
  write a pause-until file (`/etc/dina-backup/grants-paused-until`, 24 hours
  after the failure, together with the `GRANTS_PAUSED` value the restored block
  held) **and** set `GRANTS_PAUSED=true` in the grants block of the restored
  `deploy/.env`, since the service reads it once at start
  (`apps/grants-service/src/config.ts`) and a capture usually holds `false`.
  `sync_grants_env` then reads the file on every deploy and keeps writing
  `GRANTS_PAUSED=true` until that time — today every deploy rewrites the block
  from the laptop's `infra-*.env`, which would unpause it — so the restored
  24-hour count cannot let the ceiling be exceeded. **Ending the pause:** at the
  deadline a systemd timer (`dina-grants-resume`) takes the environment lock,
  sets the grants block back to the value saved in the pause-until file (so a
  pause the operator set on purpose stays), deletes the file and recreates the
  grants container (`dina-compose up -d --no-deps grants`), so grants resumes
  without waiting for a deploy; it alerts on failure. There is no early resume:
  grants minted after the capture are missing from the restored count, and only
  the passing of the full 24 hours makes that count safe again. List the keys the
  OpenRouter provisioning key has minted and compare them with the ledger (the
  provisioning API lists keys; phase 2 confirms the call).
- **R7 — reconcile after a restore.**
  - **Before cutover (contained):**
    - for each subject the journal names whose restored state differs from its
      last committed action, apply that action, from
      the operator's machine (§4.2); list missing targets, and replay again
      after the AppView has caught up, just before cutover;
    - find accounts deleted after the capture — from the PDS's account-deletion
      events, which the backup job ships to the journal hourly — and delete them
      again on the PDS; deletions in the last hour before the failure may be
      missing from the journal, and are disclosed. (Their records stay in the
      AppView, as they do after any deletion today: P8.)
    - **intents with no outcome or an indeterminate one** (the server died, or
      could not tell, during an action): takedowns and tombstones are applied,
      the safe side; reversals are listed for the operator to decide.
    - **commerce epochs:** any epoch record written after the capture — a node's
      first (genesis) record, or an advance made when an owner restores their
      node from an archive, which fences off older copies of the node — is
      missing from the restored repo. Two things follow
      (`packages/core/src/commerce/epoch_service.ts`). The owner's current node
      sees its record gone or fallen back and **stops commerce signing** until it
      restarts. Where only the genesis was lost, the restart publishes a new one
      and trade resumes. **Where an advance was lost, the restart adopts the
      older epoch, and every buyer that saw the newer one refuses the honest
      node's quotes** (their watermarks refuse any lower epoch,
      `packages/core/src/commerce/watermark_gate.ts`) — an outage with those
      buyers that does not end on its own. It ends when the owner runs their
      node's archive-restore flow, which publishes the next epoch (once per lost
      advance), or when P3 exists. And where an advance was lost, a
      **fenced-off copy** of the node that starts sees an epoch matching its own
      and can sign quotes again: buyers who saw the newer epoch refuse them
      (their epoch watermarks); buyers who never did would accept them. The
      operator cannot tell from the capture which owners are affected, **and has no way
      to reach owners today**: onboarding gives every account a placeholder
      email at `dina.invalid` (`apps/mobile/src/onboarding/provision.ts`,
      `apps/home-node-lite/core-server/src/identity/provision_pds.ts`), which
      never delivers. Until an operator notice channel exists (P9, §10), the
      only protection against fenced-off copies is buyers' watermarks. That is a
      residual risk, not a fail-closed rule; whether to accept it is decision D9
      (§13), and closing it is P3.
    - **accounts created after the capture:** walk
      `plc.directory/export?after=<capture time>` (reachable from the contained
      server), keep operations whose PDS service endpoint is this PDS, subtract
      the restored accounts. Their DIDs point here, but their account and
      signing key are gone. Recreating them under the same DID is open problem
      P2 (§10). Meanwhile their handles are free, and registration stays open
      because onboarding needs it, so before cutover the operator creates a
      **placeholder account** holding each listed handle (on a new DID the
      operator controls, then deactivated), so nobody else can take it; P2
      replaces each placeholder. The owners are told through P9's channel once
      it exists.
  - **After cutover:**
    - **the AppView:** R2's rule — Jetstream replay where possible, else a known
      gap until the rebuild (§8, P1) exists.
    - **MsgBox:** messages accepted after the capture are gone (decision D6).
- **R8 — compromise (E6).** Build a replacement and restore a capture from before
  the compromise, contained, **choosing it by when the provider received it,
  never by restic's own timestamps**: a root attacker holds the restic password
  and a layer 2 key, and can write snapshots with any time, host or tags, even
  carrying altered images or `deploy/.env`. So R8 restores from layer 3 as it
  stood before the earliest possible start of the compromise (R5's version-at
  copy), keeping only snapshot IDs the check host's inventory recorded before
  that time. Then, before cutover:
  - rotate `PDS_JWT_SECRET` (ends every session), the admin and Postgres
    passwords, every bucket key and the grants and attestation keys;
  - **do not restore `caddy-data`:** start Caddy empty, with a new ACME account,
    so it issues new certificates with new private keys at cutover, and revoke
    the old certificates through the old ACME account. Before cutover the
    contained checks run against the services directly (their ports through an
    SSH tunnel), since the new certificates do not exist yet;
  - **replace the backup repositories:** `restic init` a new layer 2 repository;
    `restic copy` those snapshots into it from the version-at copy, on the
    operator's clean machine (copying re-encrypts them under the new repository's keys — changing
    the password of the old one would not, because its data keys stay the same);
    mirror the new repository into an **empty** new layer 3 bucket; retire the old
    repositories and buckets (§4.4);
  - **rotate every hosted account's repo signing key** — open problem P4 (§10).
    After a server compromise the attacker holds **every** hosted account's key,
    and commits they sign elsewhere stay valid to anyone checking against PLC
    until the keys are rotated. PDS 0.4 has no read-only mode, and taking every
    account down (`com.atproto.admin.updateSubjectStatus`) only stops the PDS
    serving the repos — it neither stops forged commits nor touches the
    AppView, which ignores account events (P8). So **the PDS does not
    reopen after a compromise until P4 exists**, which is why P4 is the first
    open problem to design (§14);
  - **the journal during the compromise:** a root attacker can use the
    wrapper's key and the public `age` recipient to add entries that look
    genuine. Entries (and shipped account deletions) written after the earliest
    possible start of the compromise are held back: takedowns among them are
    applied (the safe side); every reversal and deletion is applied only after
    the operator confirms it from their own records;
  - **R10 "Leaked" is mandatory** whenever the compromise reached a server or
    its `deploy/.env`, which holds the PDS rotation key; it is optional only when
    the incident was stolen bucket credentials without the restic password.
- **R9 — domain lost (E8).** First, recover it: Namecheap's account recovery with
  the recovery codes and ownership evidence (account email, payment records).
  If the account was taken over, the attacker could impersonate every service
  meanwhile (§2), and nothing in the app detects it (P10); once the domain is
  back, rotate `PDS_JWT_SECRET` (ends every session the attacker may hold) and
  treat the passwords apps sent during the takeover as exposed (P10).
  If that fails within a few days, move to a new domain: new host names in
  `infra-*.env`; a new `PDS_HOSTNAME`; for every hosted DID a PLC operation
  changing **both** its PDS service endpoint and its `dina-messaging` endpoint
  (signed with the PDS rotation key, or owners' keys where it is missing); new
  handles; and an app update that rewrites what each existing install has saved
  — the PDS URL and handles (`provision.ts`), and the AppView and
  service-discovery URLs (`infra_preferences.ts`), all preferred over release
  defaults by `boot_capabilities.ts` — changing only values that point at the old
  domain, so a provider the user chose stays. Verified with an upgraded existing
  install that has every preference set, without re-onboarding: login,
  publication, D2D, PeerLens and service discovery. Objective: days to
  weeks. A reserve domain shortens it (decision D7).
- **R10 — PDS rotation key lost or leaked (E9).**
  - **Lost:** generate a new `PDS_ROTATION_KEY`. Adding it to each DID needs the
    owner's key, which no shipped app surface can use for this yet (P5); until
    then those DIDs keep working but cannot change PLC through the PDS, and are
    listed. Accounts without an owner key can no longer change PLC at all.
  - **Leaked:** at once, sign with the old PDS key a PLC operation per DID that
    replaces it with a new one, canary first, then all; check each in the audit
    log — an operator script, since these operations need only the PDS key.
    Owners' higher-priority keys could cancel an operation the attacker signs
    within 72 hours, but no shipped app lets an owner see their PLC log or sign
    a cancelling operation today (P5, P6), so that protection is not available
    yet.
- **R11 — operator laptop lost or compromised (E7).** First decide which case
  it is. **Lost or broken**, with an encrypted disk and the password manager
  locked when it went: on a clean device, open the password manager with its
  recovery kit, decrypt the offline store with the paper `age` identity, log in
  with the offline SSH key; remove the lost laptop's key from both servers and
  rotate everything it held locally (grants and attestation keys, the bucket
  keys it could have copied). **Possibly compromised** — malware suspected, or
  stolen or left while the password manager was unlocked: the password manager
  holds `deploy/.env` (the PDS rotation key), `backup.env` (the restic password
  and a layer 2 key) and the SSH key gives root, so this is E6 for both
  environments — R8 for each (including R10 "Leaked" and repository
  replacement), a new password-manager master password and second factors, and
  the laptop's SSH key removed. **When unsure, treat it as compromised.**
- **R12 — MsgBox only, server running.** Restore its buffer from the newest
  capture (R1 steps). Receivers discard messages they already handled.
- **R13 — purge a blob (content that must be removed outright).** First take
  it down and list it (`catalog-photo takedown`, through `dina-moderate`, so
  the journal records it). Then, with the admin keys from the offline store,
  delete every version of the blob in the blob bucket (including any copy the
  PDS's takedown moved aside) and every version in the archive. Add its CID to
  the purge list, sign the new list with the offline purge key, and write a
  journal entry; R7 then removes the blob again after any restore and no job
  looks for it (§4.9); a restored record that still refers to it serves
  nothing. Captures taken after the switch hold no blob bytes. A blob from
  **before** the switch can also be in:
  - `blocks/` if still kept: delete the file;
  - pre-switch captures: `restic rewrite --exclude <file> --forget` on every
    snapshot holding it (which replaces each snapshot and removes the
    original), check that no snapshot still refers to the file, then prune and
    let the mirror run. Rewritten snapshots get new IDs, so R13 records each
    original-to-new pair in the check host's inventory, signed with the purge
    key and marked as a purge: the disappearances count as explained, the new
    IDs keep their originals' first-seen time and expiry, and R8's selection
    follows the pairs. Layer 3 keeps the old packs as locked or hidden versions
    for up to 75 more days, which cannot be shortened;
  - Hetzner disk backups (up to 7 days) and manual snapshots: delete the
    snapshots.

  R13 ends with a report of which copies are gone and the date each remaining
  one expires.
- **R14 — blob bucket's provider lost (E10).** Create a new blob bucket at an
  available provider other than the archive's; copy the archive's current
  objects into it (`rclone copy`, with a read key); give the PDS a new key and
  point it there (inside a hold); check the restored stores' blobs as R3 step 5
  does; run the canary. Blobs published after the last archive run — within an
  hour of each capture — are lost and listed. If the archive's provider is the
  one lost, create a new archive at another provider and refill it from the
  blob bucket's current objects and versions. Blobs the PDS deleted more than
  30 days earlier existed only in the lost archive and are gone: captures that
  refer to them lose their blob-complete mark (a restore from them would miss
  those photos), and new captures are blob-complete again once the refill
  ends. Objective: 4 hours.

## 7. Drills

- **Monthly, automated (`restore-test`), per environment:** restore the newest
  trusted capture into scratch storage; integrity checks; `pg_restore` into a
  scratch Postgres; start the PDS from the capture's saved image, tagged and
  pinned as §4.3 describes, with no registry access, on the restored data in an
  isolated network. Once blobs live in a bucket, the test creates a scratch
  bucket with its own key, copies into it the blobs the restored stores refer
  to (read-only keys to the blob bucket's versions and the archive, never the
  PDS's write key), points the test PDS at it, and deletes it afterwards; the
  production buckets are never written. Read a record, fetch a blob — including
  one deleted from the PDS after the capture — and check it against its CID,
  and verify a commit signature.
  Report to its own check.
- **Phase 2, once, then yearly:** the 50-capture proof for hourly captures
  (§4.2).
- **Quarterly, by hand, on test:** delete the test server (testing E3b) and run
  R3 from layer 2, timed against §3 and verified with §5's checklist in both
  stages, including one journal entry replayed inside the hold before
  cutover. Every other quarter, use the E3a quick path instead, to test
  rescue-mode containment and a server created with the old Primary IP, with a
  rollback override on the disk image and none
  in the chosen capture, and an older `DEPLOYED_COMMIT` on the image: R3 must
  remove the override and replace `DEPLOYED_COMMIT` with the manifest's.
- **Every six months:** on a throwaway server at a provider other than Hetzner,
  restore prod from layer 3 with no Hetzner access (R4), using the recovery read
  key, including seeding a new layer 2 from layer 3 and one mirror run after it; and run R11 on a clean
  device that has never held the laptop's data. Prod data never goes into test;
  throwaway servers are deleted afterwards.
- **Before layer 3 is relied on (phase 3), and yearly:** with the server's B2
  key, run the hourly mirror twice and confirm the second run creates no new
  versions; try to delete a version and to change a version's retention (both must
  fail); hide and overwrite `config`, a snapshot file and a pack, and change a
  pack's contents without changing its size (must succeed); with the server's
  layer 2 key and the restic password, forget and prune an old snapshot while
  fresh captures continue, and write a backdated snapshot; hide a journal entry
  older than 30 days; the weekly check must report the changed pack, the
  snapshot inventory the missing and the backdated snapshots, and the journal
  inventory the hidden entry; R8's selection must exclude the backdated one; then run R5 and restore successfully
  from the pre-attack versions.
- **Yearly:** prove the journal: run takedowns, restores and one action that
  fails, on records present and on one created after the capture; kill the CLI
  after its commit but before it exits, and again while its COMMIT is in
  flight, and confirm the outcome is never recorded as failed for a change that
  committed; kill the hold process during a replay and confirm a
  capture waits until the replay ends; confirm the original takedown times and
  reasons of subjects already in the right state survive the replay; hide one
  entry and add one forged entry with the wrapper's key; let several mirror runs
  and a prune pass; restore an older capture and confirm R7 leaves every
  journalled subject in the state of its last genuine committed action, lists
  the missing target, and holds the forged entry for review.
- **Before prod switches its blob store, and yearly, on test:** the blob
  archive: delete a record's blob between a capture and the next archive run
  and confirm the archive still gets it from the bucket's versions; overwrite a
  blob with different bytes of the same size, in both buckets, and confirm the
  hash check alerts and a restore takes the matching version; restore an older
  capture with the blob bucket unreachable (R14); purge a blob (R13) and confirm
  it is gone from every version in both buckets, that the next capture is still
  blob-complete and that an older capture still restores; purge a pre-switch
  blob and confirm the rewritten snapshots raise no disappearance alert and
  remain selectable; forge a purge-list entry with the server's keys, and put
  back an older signed list while hiding the latest, and confirm every job
  ignores the forgery, alerts, and keeps every purge; forget and prune a capture with the
  server's keys and confirm archive retention keeps its blobs and refuses to
  run; publish a capture referring to an old blob between retention's last
  check and its delete, and confirm the capture is not marked complete until
  the blob is archived again; run the switch with uploads continuing until the PDS
  stops, and confirm no blob is missing after it.
- **Yearly, on test:** deleted data: delete a synthetic account and record
  carrying a marker string, take a capture, and confirm the marker appears
  nowhere in the capture's restored database files.
- **Yearly, on test:** retention across a replaced server: after an R3 drill,
  confirm the old server ID's snapshots expire on schedule while the new one's
  captures continue, and that the absolute rule removes a snapshot past 12
  months and a week.
- Every drill is recorded in §15.

## 8. The AppView: recovery and rebuild

`appview/scripts/backfill.ts` already walks a PDS (`com.atproto.sync.listRepos`,
then `com.atproto.repo.listRecords`) and dispatches each validated record to the
ingester's handlers. As a recovery tool it falls short:

- it skips records on errors and rate limits without reporting them, so a run
  cannot be shown complete;
- a current repo shows no deletions, so it cannot remove entries for records
  deleted since a capture;
- catalogue indexing needs a chain from genesis (sequence 1, consecutive
  advances, `packages/commerce-protocol/src/catalog_publication.ts`), so it
  cannot start from a pointer at sequence N once earlier snapshot records are
  gone — which the photos plan's snapshot pruning would cause;
- records that only change others (revocations) do nothing when their target is
  not yet indexed;
- handlers update rows without comparing repo revisions
  (`appview/src/ingester/handlers/attestation.ts`), so a backfill write landing
  after a newer live update can overwrite it, or recreate a record after its
  deletion;
- moderation state lives partly as flags on the indexed rows themselves and as
  historical tombstones, which a fresh walk does not recreate.

**So, for now,** the AppView is recovered from the Postgres capture in the same
run as the PDS (R3), plus Jetstream replay where possible (R2). The skew between
the PDS and the index is a known loss when replay is not possible.

**The rebuild this needs** is open problem P1 (§10): a fresh index built from the
restored PDS with completeness reporting, dependency order, catalogue head
adoption, revision-aware writes (or a buffered live stream applied after the walk
with a barrier), and moderation state and tombstones carried across by stable
identifiers — checked by effective visibility, not row counts, before the
database is swapped in.

## 9. New work this plan needs (built)

| Item | Phase |
|---|---|
| Backup host script, container, timers, `backup.env`, the `dina_backup` role | 1 |
| Ordered PDS capture, the three cross-file checks, the stopped capture with exit-code check | 1 |
| `DEPLOYED_COMMIT`; dirty-tree refusal across synced folders; third-party images pinned by digest; the image cache | 1 |
| `generate_secrets` refusing during a restore or when the PDS volume is not empty | 1 |
| The environment lock: one holder per operation, `dina-ops hold` and `dina-ops run`, the deploy script's server-side steps in one SSH session | 1 |
| SQLite captures with `VACUUM INTO`, the implicit-rowid audit, `sqlite3` run as each volume's owner | 1 |
| The deploy folder as it runs in each capture; the generated `Caddyfile` untracked; generated files outside the dirty-tree check | 1 |
| The restore pin override and `--pull never --no-build` restores | 1 |
| The grants pause-until file read by `sync_grants_env`, and the `dina-grants-resume` timer | 1 |
| The account-deletion shipping key and its check; the journal's lifecycle and inventory | 1 |
| `rollback --services`, the `dina-compose` wrapper, `--replaces-rollback`, and the override excluded from every `rsync --delete` | 1 |
| Retention across server IDs and the absolute 12-months-and-a-week rule | 1 |
| An operator notice channel to hosted owners (P9) | 1 |
| The B2 account and the journal bucket (versioning, retention, lifecycle, the write-only key, the `age` recipient); `dina-moderate` (intent and outcome objects, refusal when the intent cannot be written); shipped account-deletion events | 1 |
| A separate Hetzner project per environment for layer 2 | 1 |
| `backup-now`, `backup-status`, `restore-test` | 1–2 |
| `scripts/ops/msgbox_probe.ts` and the canary-account checks | 2 |
| The 50-capture proof for hourly captures | 2 |
| Layer 3: B2 bucket, versioning, default retention, the server key's rights (write and hide only), lifecycle on non-current versions, mirror, the check host with its weekly full-read check and snapshot inventory, R5 | 3 |
| The PDS blob store (§4.9): blob bucket and append-only archive at two providers, key rights proven, the switch with the PDS stopped for the last copy, blob-complete captures, the check host's hash checks and archive retention, R13 and R14, restores checking bytes, `catalog-photo takedown` through `dina-moderate`, monitoring | before photos ship |

## 10. Open problems (designed elsewhere)

Each row says what holds until the problem is solved; where that is a residual
risk rather than a fail-closed rule, the row says so.

| # | Problem | Until it is solved |
|---|---|---|
| P1 | **AppView rebuild-and-swap** (§8) | Recover the AppView from the same capture; record any gap as a known loss. |
| P2 | **Recreating a lost account under its existing DID.** Ordinary provisioning (`provision.ts`, `provision_pds.ts`) mints a new DID. Needs: the owner's key signing a PLC operation that installs a new atproto key, then `createAccount` for the existing DID with service auth from that key, then republishing from the node's local data, with lost records listed. | Affected accounts are listed and cannot publish; placeholder accounts hold their handles (R7). Their owners learn of it only when publishing fails, until P9 exists. |
| P3 | **Commerce epochs after a PDS rollback.** A node adopts the live epoch record on every start (`epoch_service.ts`), so a fenced-off copy of a node can sign again when a restore rolls the record back; re-fencing needs the current node to publish successors above its own epoch (each exactly predecessor + 1 with the predecessor's digest, `packages/commerce-protocol/src/epoch.ts`) under owner presence. | Current nodes stop signing until they restart; where an advance was lost, buyers that saw the newer epoch then refuse them until the owner runs the archive-restore flow or P3 exists — an outage the operator cannot announce until P9. Fenced-off copies: not fail-closed, a residual risk (D9) — buyers' watermarks protect those who saw the newer epoch; nothing else does until P9 lets the operator warn affected owners. |
| P4 | **Rotating every hosted account's repo signing key** (a new key in the actor store, a PLC operation updating `verificationMethods.atproto`, a new commit), canary first. | After a server compromise the PDS stays closed to the public. Commits forged with the stolen keys stay valid until P4 exists. |
| P5 | **Owner-key PLC operations from the app**, and bulk running of PLC operations for R9 and R10, canary first. | Operations signed with the PDS key run per DID by an operator script. Operations that need the owner's key cannot be done; those DIDs are listed. |
| P6 | **Node watch of its PLC audit log**, with the owner able to cancel an operation within 72 hours. | Not available: owners cannot use the 72-hour override today. |
| P7 | **An application-level fence for MsgBox** (clients drop connections to a relay that is not the current one). | DNS cutover under E5 is unfenced (§5.3). |
| P8 | **The AppView acting on account deletions and takedowns.** Today it only logs them (`appview/src/ingester/jetstream-consumer.ts`), in normal running as after a restore, so a deleted account's records stay indexed and searchable. | As today: an operator can hide specific records with the moderation CLI. Not caused by this plan, but the deletion text must not claim otherwise. |
| P9 | **An operator notice channel to hosted owners.** Every hosted account's PDS email is a placeholder at `dina.invalid`, so the operator cannot reach any owner. Needs a channel the app already reads — for example a signed notice it fetches, or a D2D message from a published operator DID that the app shows although the sender is not a contact. | None: P2 and P3 notices cannot be sent. Built in phase 1 (§9). |
| P10 | **Apps trusting services by their TLS name alone.** A domain takeover lets the new holder impersonate the PDS, AppView and MsgBox. Needs apps to check services against keys published outside the domain (for example in the DID documents), and a way to change the PDS passwords apps hold. | None: during a takeover the attacker can impersonate the services; afterwards sessions are ended, but passwords sent meanwhile stay valid. |

## 11. Security and privacy

- Backups hold password hashes, emails, sessions, repo signing keys, TLS private
  keys and the PDS rotation key. restic encrypts every backup before upload; its
  password is kept apart from the data it protects. Journal objects are
  encrypted with `age` before upload, to a key the server does not hold.
- A deleted account survives in backups for up to 14 months (§4.4), and in the
  live AppView until P8 is solved.
- The check host (D8) can decrypt every backup and is guarded like the servers
  (§4.5).
- Keys are scoped by environment (a Hetzner project each) and purpose. The
  layer 2 key on a server can delete that server's layer 2 backups; at layer 3
  the server can only write and hide, and only the offline store can delete or
  change retention. No environment holds another's keys.
- The backup job's logs carry counts, sizes and durations — never contents, DIDs
  or handles. The moderation journal holds subject identifiers and reasons, as
  the AppView's own audit table does.

## 12. Cost

| Item | Cost |
|---|---|
| Hetzner server backups | a percentage of each server's price (Hetzner console) |
| Hetzner Object Storage | about €6.49/month base, which covers far more than this data |
| Backblaze B2 | cents a month at this size, including retained versions |
| PDS blob bucket and archive (§4.9) | grows with photos: at a few hundred GB, single-digit to low double-digit dollars a month per copy; the bucket's download fees depend on D10, and the archive is rarely read |
| Dead-man's-switch checks | free tier |
| Primary IPs | already in use; keeping them costs nothing extra |

## 13. Decisions for the owner

- **D1 — second provider.** Recommended: Backblaze B2 (S3 API, versioning, object
  lock in compliance mode, scoped keys, US and EU regions). Alternative:
  Cloudflare R2, if it offers the same key scoping and locks.
- **D2 — alerting.** Recommended: healthchecks.io (free tier; email and phone
  push). A self-hosted check would share the failures it should report.
- **D3 — stopped captures.** Recommended: nightly, at the quietest hour (under a
  minute of PDS downtime), with hourly online captures trusted only after the
  phase 2 proof. Alternative: a stopped capture every six hours, for a 6-hour
  recovery point until then, at four short outages a day.
- **D4 — objectives (§3).** Recommended as stated.
- **D5 — keep the existing Primary IPs** (auto-delete off, protection on).
  Recommended: yes.
- **D6 — MsgBox loss after a restore.** Messages accepted between the capture and
  the failure cannot be recovered. Recommended: accept now; later, consider
  senders keeping accepted messages until the recipient acks end to end.
- **D7 — a reserve domain.** Recommended: register one and keep it parked.
- **D8 — the check host.** It must not be a server it protects, and it can
  decrypt every backup. Recommended: one small VM at a provider other than
  Hetzner, used for nothing else (it also runs R4 drills). Ruled out: each
  environment checking the other, which would put prod's backup password on the
  test server.
- **D9 — commerce after a PDS restore (P3).** A fenced-off copy of a node can
  sign again, and until P9 exists the operator cannot even warn owners. Current
  nodes also stop signing until they restart, and where an advance was lost,
  buyers that saw it keep refusing them until the owner runs the archive-restore
  flow.
  Recommended: accept for now — it needs an owner's node restore after the
  capture and before the failure, and buyers who saw the newer epoch refuse it
  — build P9 in phase 1, and design P3 in phase 4.
- **D10 — where prod's blob bucket and archive live (§4.9).** Hetzner has no
  Object Storage in Ashburn. The archive is read only to hash each new blob
  once, for restore tests and for restores, so its downloads stay near the
  size of each month's new photos. Whatever is chosen must first prove, with the real
  keys: versioning; a bucket key that can write and delete but not delete
  versions or change settings; an archive key that can add but not delete or
  replace; the check host's and the admin key's deletes still working on the
  archive; and lifecycle on non-current versions.
  - **Recommended:** blob bucket at Backblaze B2's US East region (Reston,
    Virginia, near Ashburn; cheap downloads); archive at Amazon S3 in us-east-1,
    with versioning, and a bucket policy aimed at the server's archive
    principal only (an `aws:PrincipalArn` condition) that denies it every
    delete and settings change and requires create-only uploads — an explicit
    deny on Amazon overrides every allow, so a deny without that condition
    would also stop the check host's retention and the admin purge. It is
    rarely read, so download fees stay small.
  - **What this concentrates:** Backblaze would then hold layer 3, the journal
    and the live photos. Losing that account loses all three at once: layer 2
    still holds the backups and the archive the photos (R14), but the journal
    would be gone. Accept that, or put the blob bucket elsewhere.
  - **Alternative:** Cloudflare R2 for the blob bucket (no download fees) only
    if it proves versioning and the key limits, which it is not known to have.
    The two buckets stay at two different providers. Check current prices.

## 14. Phases

- **Phase 0 — now, mostly in the Hetzner, Namecheap, Backblaze and
  password-manager consoles.** Copy each server's `deploy/.env` into the password
  manager and the offline store; add the grants secrets and the SSH key. Switch on
  Hetzner backups, delete and rebuild protection, and Primary IP protection with
  auto-delete off, on both servers. Take a manual snapshot of each. Add the
  offline SSH key. Two-factor login and printed recovery codes everywhere. Domain
  auto-renew, multi-year registration, registrar lock. Lower the DNS TTLs. Export
  the DNS records.
- **Phase 1 — layer 2.** §9's phase 1 items, on test first, then prod. Monitoring
  for each job. Confirm Jetstream's buffer setting and how Hetzner Object Storage
  keys are scoped. Take a stopped capture on the read-only-PDS path and confirm
  it opens every database. Rehearse R1, R1a and R2 on test,
  including a rollback inside the hold with an old capture while the freshness
  gate would refuse a deploy: the writer must stay stopped during the file
  swap, the public side closed until reconciliation ends, and every service's
  image as §4.3 requires before the hold is released. Use a capture from before
  an AppView schema change while repairing MsgBox, and confirm the AppView
  keeps its newer image and keeps working. For R1a, start with the full stack
  running and let Jetstream run past the capture, and require a new canary
  record in the AppView within 5 minutes of the restore. Restore a capture whose
  grants block says unpaused, and confirm grants refuses claims from its first
  start and after a deploy, and accepts them again after the resume timer runs
  with no deploy. Restore a capture taken while a rollback override was active,
  with no registry access, and confirm every service starts on its restored
  image and an ordinary deploy still refuses. Quarantine the volumes by copy,
  with registry access blocked and no helper images cached, and check the
  copies before removing anything. After a restore, run
  `reload-caddy` and a nightly capture and confirm the pin override survives. Let a nightly capture and a
  `reload-caddy` run after the rollback, then confirm the rolled-back service
  still runs the capture's image and that an ordinary deploy refuses.
- **Phase 2 — restores proven.** `restore-test` monthly; the canary checks; the
  50-capture proof; the first quarterly drill (R3 on test, deleting the server),
  timed and logged.
- **Phase 3 — layer 3.** §9's phase 3 items and the tamper drill; R4 from layer 3
  at another provider.
- **Phase 4 — open problems.** P1–P8 and P10 (§10; P9 is built in phase 1), each with its own design document;
  P4 first, because without it the PDS cannot reopen after a compromise.
- **Blob store — before catalogue photos ship, whatever phase the rest has
  reached.** Decide D10 and prove the chosen providers' key limits; switch
  test's PDS to its bucket for the photos plan's phase 0 and prod's before
  photos ship (§4.9), with the archive, blob-complete captures, the check host's
  jobs, R13, R14, the restore changes, the monitoring and the blob drills (§7).

## 15. Drill log

| Date | Runbook | Environment | Time taken | Problems found |
|---|---|---|---|---|
| — | — | — | — | — |
