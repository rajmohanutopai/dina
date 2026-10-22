# Hosted Dina: add the plugin, get a Dina

**Status:** DESIGN, 2026-10-21. The demo cut (§10) is built, uncommitted; §12 says what
was built, how it was checked, and what is not built.
**Related:** `docs/OPENAI_DOTS_INTEGRATION.md` (the dot flow and the bridge),
`docs/USER_BACKUP.md` (backup), `docs/COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md`
§17 (managed runtime rules), `docs/WEB_OWNER_SURFACE_PLAN.md` (owner in a
browser).

---

## 1. Goal

A person adds the Dina plugin in ChatGPT, signs in once, and has a Dina. No
phone app, no server, no second AI. Their dot uses it for **trust**
(PeerLens) and **negotiation** (tenders) from then on.

**Memory is not in this release.** Ask and remember run in Brain, a hosted
Dina has no Brain, and the `dot` tool profile leaves out `dina_ask` and
`dina_remember` (`OPENAI_DOTS_INTEGRATION.md` §5). Adding memory later needs
Brain or a shared stateless worker under §17.2, and its own design.

Two ways in, one plugin:

| Who | Path |
|---|---|
| Most people | **Create my Dina.** We run one for them (this doc). |
| People who already run Dina | **I have a Dina.** They paste a `dina1:` setup code and the bridge links their own node (built; `cli/src/dina_cli/dot_bridge.py`). |

**For now, invite only.** The plugin stays a personal plugin (not listed in
OpenAI's directory) and sign-up needs an invite code.

## 2. What we promise, plainly

- Each person's Dina is its own Core, with its own encrypted store, identity
  and keys, run as its own OS user.
- It runs in **security mode**: its seed is wrapped under the owner's
  passphrase. A locked Dina can't be opened by us. An unlocked Dina has its
  keys in memory on our machine, and a person with root on that machine could
  read them.
- **Restarts lock it.** A crash, an upgrade or a host reboot leaves the Dina
  locked until its owner unlocks it on their owner page. We never keep the
  passphrase to unlock it for them.
- **The shared front door never sees the passphrase, the 24 words, or the
  owner page.** Those go straight to the person's own Dina over a TLS
  connection that ends inside it (§4, §5).
- **What a breach of the front door gives:** for every linked Dina, the power
  to draft tenders and read their status (ranks, names, outcomes; no prices
  or limits), to run PeerLens searches, and to ask Dina to check an action
  (validate), which at most puts a card in front of the owner. Nothing more,
  because a hosted link's agent device is limited to those routes in Core
  (§3.2). It can also take over a sign-up in progress: a new cell that has
  not yet got its passphrase (§4).
- Whatever Dina returns to the dot goes to OpenAI, as with any plugin.
- The owner can export everything and move to their own phone or server with
  the 24 words. The hosted cell stops once the move is confirmed; the
  identity, its PDS account and its backups carry on with the moved Dina (§7).
- Dina guides the dot; it does not police the dot's other plugins.

## 3. Shape

```
 Dot ──https + OAuth──► front door  chatgpt.dinakernel.com
                         - sign-in page, tokens, routing
                         - holds per-link agent keys,
                           limited to dot routes (§3.2)
                             │ signed agent requests over a
                             │ per-cell Unix socket
                             ▼
 Owner's browser ──TLS ends in the cell──► hosted cell  <cell>.dina-owner.dinakernel.com
   (sign-up secrets, owner page)           its gate + one Home Node Lite Core (no
                                           Brain), security mode, own OS user, own DID

 Own-Dina links go from the front door through MsgBox, as the bridge does today.
```

### 3.1 Parts

- **The front door** is the bridge, grown: the same OAuth server, link page,
  token hashing and `dot` profile. It runs on the cells' machine, as its own
  OS user, and reaches each cell through that cell's Unix socket.
- **A cell** is a gate and one Home Node Lite Core, both running as the
  cell's own user (`apps/home-node-lite/core-server/src/cell/`). **No Brain:**
  the dot is the only AI, and the negotiation loop, ranking and award logic
  are already in Core. The gate serves the owner origin: sign-up, unlock,
  "connect this browser", and once Core runs, it forwards to Core's socket
  only signed requests (the owner's browser key) and the two unsigned calls a
  browser needs (the console page, browser pairing), dropping any owner
  capability a browser sends. Wrong passphrases are counted per client (IPv6
  by its /64), five per ten minutes, for unlock and connect-browser alike, so
  one stranger cannot lock the owner out; past twenty wrong passphrases from
  anywhere in that window, every check waits longer (up to five seconds), at
  most four run at once, and checks happen before the gate's busy flag, so
  guessers never hold the gate against the owner. The client is the browser's own address: the
  SNI router tells the cell's Caddy with a PROXY protocol line (accepted from
  loopback only), Caddy hands it to the gate, and the gate passes it to Core
  as `x-dina-client`, replacing any a browser sent, so Core's rate limit on
  the socket is per client too. Every call the gate makes to Core has a time
  limit. The cell
  listens on two things only:
  - a Unix socket for agent calls, owned by the cell's user and connectable
    (write permission) only by the front door's group (Fastify can listen on
    a socket path; Core's boot listens on host and port today, so this is
    new);
  - its owner origin, `<cell>.dina-owner.dinakernel.com`, reached by TLS
    passthrough: an SNI router (`cli/src/dina_cli/sni_router.py`) forwards
    the encrypted stream, and the cell ends TLS itself in its own Caddy,
    running as the cell's user, which makes the cell's TLS key, gets its
    certificate by ACME TLS-ALPN-01 through the passthrough, renews it, and
    forwards to the gate's socket. No shared part ever holds that key:
    whoever holds it could stand in for the owner page. `<cell>` is a random
    label, since every certificate name is published in public logs.
- **The provisioner** creates, starts, stops and deletes cells. In
  production it is its own process (`dina dot-bridge provisiond`, as root),
  with no network listener; the front door runs as its own unprivileged user
  and reaches it over a local socket only the front door's group may open,
  where it may only make a cell, read a cell's state and addresses, take the
  bootstrap code once, and remove a cell whose sign-up never finished
  (`hosting.py` `PROVISIONER_OPS`). The front door refuses production mode
  without it. Each gate runs in its own process group, and stopping a cell
  signals the whole group, Core included. It reuses parts of `dina-agent`'s
  Home Node code (`cli/src/dina_cli/home_node.py`: verified release install
  and file layout) and the `managed-runtime` cell states
  (`packages/managed-runtime`). It does **not** reuse the supervisor or the
  backup path as they are (§8).

No shared part holds a cell's seed, passphrase, owner capability or TLS key
(§17.2).
Each cell's owner capability file stays in the cell's own folder, readable
only by the cell's user.

### 3.2 A narrow agent scope for hosted links

Today a paired agent can reach more than the dot needs: `/v1/vault/query` on
default-tier personas, for example (`packages/core/src/auth/authz.ts`). A
hosted link's device gets a new agent scope, `dot`, that Core's authz allows
on these routes only:

- `POST /v1/commerce/agent/tender-drafts`, `GET .../tender-drafts/status`;
- `POST /v1/agent/peerlens/search`, the `dina_peerlens` tool (not `attest`,
  which publishes, nor `status`, which tracks a publication);
- `POST /v1/agent/validate` and `GET /v1/intent/proposals/{id}/status`, the
  `dina_validate` tools; a risky action becomes an approval card for the
  owner;
- session start and end, and status;
- `DELETE /v1/devices/self`, so unlinking revokes the device in Core.

Each of these matches a tool in the `dot` profile (`mcp_server.py`
`DOT_PROFILE_TOOLS`), so the dot is never offered a tool its Dina refuses.
Contract test: each `dot` tool's real client request succeeds under the
scope, and `peerlens/attest` and `/v1/vault/query` are refused.

Everything else is refused in Core, whatever the front door sends. This is
the answer to the hosted-bridge question in `OPENAI_DOTS_INTEGRATION.md`
§4.3 for hosted cells: the front door holds keys, but keys that can do
little. Own-Dina links keep their owner's choice of scope.

## 4. Sign-up

1. On the link page, "Create my Dina": the person enters an **invite code**
   and a **display name**. Nothing secret.
2. The provisioner makes a cell: a folder (and in production an OS user), a
   random label and a port, and starts the cell's gate. Core does not run
   yet. The gate mints a **sign-up ticket** and reports it to the provisioner
   over an inherited pipe.
3. The front door sends the browser to the cell's owner origin with the
   ticket in the URL fragment, so no server log sees it. The ticket is
   single-use and lasts ten minutes; the gate spends it on the first
   passphrase set with it. Whoever holds the ticket first claims the cell,
   which is why §2 lists a sign-up in progress among what a breached front
   door can take.
4. On the cell's own origin the person sets a **passphrase**, and may give a
   currency and a delivery postal area. The gate starts Core for its first
   boot with the passphrase on a pipe: Core makes its seed, wraps it, and
   creates its identity (a `did:plc` and a handle on our community PDS, as
   phone onboarding does). The gate reads the **24 recovery words** back from
   the wrapped seed with the passphrase and shows them once; the page asks
   for two of them back.
5. The gate sets the café up as a buyer: buyer settings (currency, postal
   area), then the buyer pack (begin, bind its reference runner, confirm),
   with the passphrase as the proof of presence.
6. The gate mints a single-use owner-device code, and the page pairs the
   browser's own non-extractable key with it (§5).
7. Core's first boot also minted the single-use bootstrap code, with the
   `dot` scope, and handed it to the gate over another pipe
   (`deliverBootstrapCapability`, `boot.ts`). The gate passes it to the
   provisioner, the front door takes it once and pairs the link's agent key
   with it over the cell's socket. It is never written to disk or logged.
8. The page sends the browser back to the front door, which completes OAuth
   and returns the person to ChatGPT, linked.

The front door sees the invite code, the display name and the ticket. It
never sees the passphrase, the words or the owner page.

## 5. The owner's own steps

Some steps need the owner, not the dot: unlocking, opening a tender with a
target and ceiling, awarding, adding suppliers, deleting.

- **The page:** the Core-served owner console, on the cell's own origin. TLS
  ends in the cell, so the front door can neither read nor change the page.
- **The browser is an owner device.** At sign-up the page makes a
  non-extractable WebCrypto key, and the cell pairs it as the owner's device.
  `/app` on a server already does this (`apps/mobile/src/services/owner_device.web.ts`),
  but `/app` has no tender-draft form, and the owner console that has one
  sends the shared `x-dina-owner-capability` header with no device signing
  (`owner_console.ts`). So the console gains owner-device signing (new, §8),
  and the capability stays inside the cell.
- **Presence:** the passphrase step stays, so opening a tender still proves
  the owner is there.
- **Unlock after a restart:** Core unlocks a wrapped seed only at boot, so the
  gate does the run-time unlock. A locked cell runs only its gate, which
  serves the unlock page; when the owner types the passphrase, the gate checks
  it against the wrapped seed and starts Core with it on an inherited pipe
  (`DINA_UNLOCK_PASSPHRASE_FD`), never in Core's environment. When Core stops
  for any reason, the gate reports the cell locked again. Core in turn lives
  only as long as its gate: it watches a pipe the gate holds
  (`DINA_PARENT_WATCH_FD`) from the start of its boot and exits when the gate
  dies (after at most five seconds of graceful closing), and it refuses to
  start while another Core still answers on its socket. Before the gate shows
  the recovery words it marks the cell `setup_complete`; the provisioner never
  removes a marked cell as an unfinished sign-up, whatever its gate is doing,
  and it stops the gate before it looks a last time, so a sign-up cannot
  finish behind its check.
- **Who can still act as the owner:** someone with root on the cells'
  machine, who could change the cell's code. That is the custody limit in §2.
- **The phone app** as a second owner device needs tender cards mirrored to
  the phone, which the phone mirror does not carry today
  (`OPENAI_DOTS_INTEGRATION.md` §4.6). Later.

## 6. Suppliers

A new Dina knows no bakeries. `knownSuppliers()` reads only past buyer orders
and past tender members (`packages/core/src/commerce/tender_drafts.ts`), so
an accepted trade invite alone does not make a supplier, and a fresh cell's
draft fails with `no_known_suppliers`. The dot must not name suppliers
(`OPENAI_DOTS_INTEGRATION.md` §6.3).

So:

- **An owner-kept supplier list in Core:** supplier DID and commerce
  `service_rkey`, written only from owner routes. `knownSuppliers()` reads it
  first, then orders and tenders as today; blocked suppliers stay out.
- **On the owner page, "Add a supplier":** the supplier's Dina ID, its
  listing key and the owner's own name for it. Built. Finding a supplier by
  handle, invite link or PeerLens search is later work.
- A supplier the owner lists is named by the owner's label wherever no
  contact names it, so the dot reads "Albert", not a blank.
- The dot can suggest ("you have no bakeries yet; add some on your Dina
  page"), but only the owner adds.

Test (built): a fresh Dina with no orders or tenders drafts against a
supplier the owner listed.

## 7. Running cells

- **Isolation:** one OS user and folder per cell; the agent socket connectable
  (write) only by the front door's group; no TCP listener on loopback or elsewhere
  except the owner origin's TLS. Test: from one cell's user, connecting to
  another cell's socket fails.
- **Locked and asleep:** a cell that is not unlocked answers the dot with
  "Your Dina is locked; open your Dina page to unlock it." A cell is idle
  only when it has no open tender, held order, pending D2D message or
  approval waiting. Only an idle cell may be stopped; stopping locks it. A
  cell with work in flight stays unlocked until the work ends or lapses.
  Messages to a stopped cell wait in MsgBox under its usual hold, and the
  dot's status read says the Dina is locked.
- **Backup:** when a cell has changed, it backs up before it stops, and at
  least daily while it runs (`docs/USER_BACKUP.md`). On by default for hosted
  cells, told at sign-up. A locked cell can't back up; nothing has changed
  in it since its last copy.
- **Upgrades:** new release, one cell at a time; each upgraded cell restarts
  locked. Owners see "Dina was updated; unlock to continue."
- **Limits:** a cap on cells per machine and on calls per cell.
- **Deletion:** "Delete my Dina", confirmed with the passphrase, clears: the
  cell's process, folder and certificate; its PDS account and records; its
  backups (`USER_BACKUP.md` §6); and the front door's links, agent keys and
  token hashes for it. The `did:plc` stays in the PLC directory, as all PLC
  identities do; the doc for the person says so.
- **Moving out:** after the owner restores on their own phone or server and
  confirms, the hosted cell stops for good: its process, folder, certificate
  and the front door's links, agent keys and token hashes are cleared, so
  two nodes never sign as one DID. The PDS account, its records and the
  backups stay: the moved Dina uses the same identity and the same
  `backup_id`. Only "Delete my Dina" removes those. Test: after a move, the
  moved Dina publishes, its handle resolves, and it reads its backups.

## 8. What we reuse and what is new

| Reused | From |
|---|---|
| OAuth server, link page, token hashing, `dot` profile | `dot_bridge.py`, `mcp_server.py` |
| Tender drafts, status read, owner open form | Core routes, `/owner` |
| Verified release install and file layout | `cli/src/dina_cli/home_node.py` |
| Single-use bootstrap pairing code | `deliverBootstrapCapability`, `boot.ts` |
| Browser owner key (WebCrypto) | `owner_device.web.ts` |
| Cell states | `packages/managed-runtime` |

| New | Size | State |
|---|---|---|
| Sign-up branch, invite codes, sign-up ticket | small | built |
| `dot` agent scope in Core authz | small | built |
| Owner supplier list; `knownSuppliers()` reads it | small | built |
| Run-time unlock (the gate), first passphrase, one-time phrase step | medium | built |
| Owner-device signing in the owner console | medium | built |
| Per-cell TLS (the cell's own Caddy, ACME TLS-ALPN-01) | medium | written, not run |
| Core listening on a Unix socket | small | built |
| Core-only supervision (the gate starts only Core) | medium | built |
| Backup and export from a security-mode cell | medium | not built |
| Provisioner: create, start, stop, delete cells; random labels | medium | built |
| SNI passthrough router | small | written, unit-tested, not run on a host |
| Per-cell OS users and socket groups (`isolate`) | medium | written, not run (Linux, root) |
| Front door routing to cells; "locked" replies | small | built |
| Tender tables in the archive (`USER_BACKUP.md` §5) | small | not built |
| Backup store (`USER_BACKUP.md`) | medium | not built |

## 9. Risks

- **We run people's Dinas.** A different promise from "your hardware". It
  must be said plainly, and export must work from day one.
- **Root on the cells' machine** can read unlocked cells' keys and change
  their code. Stopping idle cells limits how many are unlocked at once.
- **Restarts lock every cell.** A release means every owner unlocks again.
- **Cost:** a Core per person is light, but idle cells must stop for this to
  scale; hundreds per machine, not thousands.
- **OpenAI's rules** for plugins and dots may change; the plugin stays
  personal until we decide to list it.

## 10. The CEO demo

The smallest version that shows the real thing:

1. Invite-only "Create my Dina" on a test machine, with the cell's owner
   origin and run-time unlock (the gate).
2. One cell for the café. Two bakery Dinas (ours), added to the café's
   supplier list on the owner page.
3. The `dot` scope, the browser owner key and the passphrase step.
4. RajDot drafts the croissant tender; the owner opens it on the owner page;
   the Dinas haggle; the owner awards; the dot reports the bakery's answer.

Left out of the demo: backup, stopping idle cells, deletion, moving out, the
phone as a second owner device.

## 11. Decisions (settled 2026-10-21)

1. **Custody:** the promise in §2 is accepted for an invite-only first
   release, on condition that export works from day one.
2. **Invite codes:** only the owner (Rajmohan) makes them, about 10 to start.
   Each works once. People linking their own Dina through the bridge need no
   code.
3. **Machines:** hosted cells and the front door get their own machine, apart
   from the one running MsgBox and the PDS. The CEO demo may use the test
   machine.

## 12. What is built (2026-10-21, uncommitted)

**Code.**
- Core: the `dot` scope (`auth/agent_scope.ts`), the owner supplier list
  (`commerce/owner_suppliers.ts`, migration v83, `/v1/commerce/trade/suppliers`),
  supplier names from the owner's labels.
- Home Node Lite: Core on a Unix socket (`DINA_CORE_SOCKET`), the passphrase
  on an inherited pipe (`DINA_UNLOCK_PASSPHRASE_FD`), the bootstrap code with
  the `dot` scope (`DINA_BOOTSTRAP_SCOPE`), the gate (`src/cell/`), and the
  owner console's browser-key signing and Suppliers section.
- CLI: the provisioner (`hosting.py`), the SNI router (`sni_router.py`), the
  Unix-socket transport, and the front door's "Create my Dina", invite codes
  (`dina dot-bridge invite create`) and cell links.

**Checked.**
- Tests: the scope through the real signed pipeline; the supplier list; the
  gate against a fake Core on a real socket; console signatures verified with
  Core's own verifier; the front door's sign-up flow; the provisioner with a
  stand-in gate; the SNI parser on a real TLS ClientHello. The full
  core-server (3032) and CLI (586) suites pass.
- One run on this Mac against the cloud test infra: a fake ChatGPT client
  linked through the front door; sign-up made a café cell with its own
  `did:plc`; the browser key paired; the dot drafted a tender; the owner
  listed two bed suppliers, opened it with the passphrase, awarded and sent;
  the supplier haggled down and accepted the order; the dot read ranks,
  names and "sent, accepted", never a price. Stopping the cell's Core locked
  it, the dot was told so, and the passphrase unlocked it.

- Code review: three rounds, Claude and Codex (2026-10-22), 27 findings
  fixed. The last round's two fixes (the delete race, guessing from many
  addresses) were tested here but not re-reviewed; no cold audit ran. A
  second local run on the final code passed sign-up through a ranked tender,
  and killing a cell's gate made its Core exit within two seconds.

**Not built or not run.**
- Production mode (`isolate`): the separate provisioner, per-cell OS users,
  folder and socket permissions, per-cell Caddy (its Caddyfile, PROXY
  protocol included, has not been parsed by a real Caddy) and the SNI router
  on a real Linux host with DNS. Written, not run.
- Backup, stopping idle cells, "Delete my Dina", moving out.
- Linking ChatGPT again to an existing cell (if pairing fails after a
  sign-up that otherwise worked, the cell has no link and the invite is
  spent). A sign-up that fails before then removes its cell and gives the
  invite back.
- Finding suppliers by handle or search; the phone as a second owner device.
- Cells run Core from source (`node --import tsx`), not a release bundle.
