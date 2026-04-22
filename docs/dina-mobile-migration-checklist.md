# dina-mobile migration-day checklist

Running checklist for the day when the external `dina-mobile` repo is archived and `apps/mobile/` in this repo becomes authoritative. Produced by task 1.14.13 audit; drives the work of task 0.22 (archive notice) + final link updates.

## Pre-conditions (required before touching these files)

- [ ] dina-mobile repo is frozen (no new commits expected)
- [ ] `apps/mobile/` in this repo is at parity with dina-mobile's HEAD (Phase 1a' done)
- [ ] Mobile tests green (`npm test -w @dina/app` exit 0) — **done 2026-04-21 via task 1.14.10**

## In-repo files that need updating

### Operational references (must change)

| File | Current | Change to |
|------|---------|-----------|
| `README.md` (line ~20) | "copies cleanly into `dina-mobile`" | "runs in `apps/mobile/`" |
| `docker/openclaw/README.md` (lines ~9, ~87, ~89) | "copies cleanly into `dina-mobile`" + section "Using with dina-mobile" | rename section to "Using with the mobile app" + point at `apps/mobile` |
| `docker/openclaw/docker-compose.yml` (line ~3) | "Meant to be copied into dina-mobile without modification" | rewrite — this file now lives in the same repo as the mobile app |
| `docs/TODO.md` (line ~18) | "needs to be copied/vendored into `dina-mobile`" | mark done or delete the item |
| `SECURITY.md` (lines ~343, ~350) | "dina-mobile client" | "mobile app (`apps/mobile/`)" |
| `docs/designs/MSGBOX_TRANSPORT.md` (lines ~755, ~892) | historical references to dina-mobile | add parenthetical "(now `apps/mobile/`)" where the reference is about the current codebase; leave historical context intact |
| `apps/mobile/app.json` | `"slug": "dina-mobile"` | **deliberate decision needed**: changing the slug affects Expo push-notification registrations and store listings. Recommended: leave `"slug": "dina-mobile"` for now (device continuity); revisit when app rebrands |

### Historical references (keep verbatim)

These files are the migration record or explicitly about the donor origin — changing them would rewrite history:

- `docs/HOME_NODE_LITE_TASKS.md` — the migration plan itself
- `docs/ts-release-flow.md` — decision log with the option-(c) rationale
- `packages/PROVENANCE.md` — by design, records the donor repo

### External-system updates (outside the repo)

These are not modifiable from here; enumerated so the migration-day operator can action them:

- [ ] GitHub `rajmohanutopai/dina-mobile` — push an archive notice to its README pointing at `rajmohanutopai/dina/tree/main/apps/mobile`
- [ ] Blog posts or announcements mentioning `dina-mobile` — either leave (historical) or add a redirect note
- [ ] Notion / internal docs mentioning dina-mobile — update links to point at this repo
- [ ] `@dina/app` npm/Expo EAS registration (if any) — verify still points at the right repo

## Related tasks in `docs/HOME_NODE_LITE_TASKS.md`

- **Task 0.22** — "Archive notice in dina-mobile/README.md" — executes the off-repo part
- **Task 0.23** — "Record the dina-mobile HEAD SHA that will be frozen for the move" — on migration day, pin `packages/PROVENANCE.md` to the final frozen SHA
- **Task 1.14.12** — "Archive dina-mobile repo" — the GitHub archive action itself
- **Task 1.14.13** — this audit (marked done once this file exists)
