# Goals and the daily plan

**Status:** Part 1 (the daily plan, §1–§13) BUILT 2026-11-02. Part 2 (goal
plans, §14–§22) BUILT 2026-11-02 and run on the simulator by hand and with a
real model, Claude Haiku 5.5 (§22). Branch
`feat/daily-plan`; not committed.
Core, CLI, Brain and phone parts are written and tested (§13). Run on the
iPhone 17 simulator the same day: Today, Goals, and a paired test agent
whose batch, sent while the app slept, arrived 6½ minutes later and showed
the Allow card. Planning by the model and `add_task` in chat are not yet
run live: the simulator's chat fails on every message, because the default
Gemini models return 404 for the dev key (§12).
**Scope:** the phone Home Node (`apps/mobile`), with Core routes the server
Home Node gets for free. Two paired agents feed it: the owner's office Claude
and their personal Claude.
**Out of scope:** the agents' own work of reading mail, Teams and project
tools. That happens in the agent, with the agent's own connectors. Dina never
reads a mailbox.

---

## 1. What the owner asked for

> My office Claude will find out what all the work items for today are. My
> personal Claude will find the items to complete too. They look at mail,
> Teams, but also my projects and goals. Based on that, Dina creates a plan
> and makes sure I follow it.

Decisions the owner made on 2026-11-02:

| Question | Answer |
|---|---|
| What an agent sends for a work item | A title and a short summary (one or two lines), plus source, link, due date and project. |
| How hard Dina pushes | Check-ins at times the owner sets: the morning plan, a midday check, an evening review that carries unfinished items forward, and a weekly note on goals that got no time. Nothing else. |
| Where Dina runs | On the phone only. |

## 2. Who does what

```
 office Claude ──┐  reads mail, Teams, Jira          (agent's own connectors)
                 ├─ dina plan push  ──► MsgBox ──► phone Dina (held until it wakes)
 personal Claude ┘  reads personal mail, errands

 phone Dina:   tasks + goals ──► Brain plans the day ──► Today screen
               check-ins (local notifications) ──► owner ticks, carries, drops
 agents:       dina plan status  ◄── what the owner finished
```

- **Agents collect.** Each agent runs on its own schedule (a Claude Code
  routine, a claude.ai scheduled task) and sends the items it found in one
  batch with `dina plan push`. (`dina task` already names the OpenClaw
  delegation command, hence `plan`.)
- **Dina holds the list.** Tasks live in Core, each tagged with a persona.
  The office agent's tasks go to `work`, the personal agent's to `general`.
- **Brain plans.** It takes the open tasks, the goals, due dates and the
  hours the owner has, and suggests the day's plan. The owner accepts it,
  edits it or re-plans.
- **Dina checks in** at the owner's times, through phone notifications.
- **Agents read back** what was done with `dina plan status`. An agent never
  marks the email or Teams item done on its own unless the owner told it to.

## 3. Why this is a Dina feature

- **The compartments.** The office agent can add tasks to `work` and nothing
  else. It cannot read the vault, see personal tasks or write notes. The
  personal agent cannot see work tasks. Each permission is one card the owner
  approves once, and unpairing the agent removes it.
- **One list from many agents.** Two agents, one plan, duplicates folded.
- **Silence First.** Every check-in is one the owner asked for and timed, so
  it is a solicited (tier 2) notification. Dina sends nothing outside the
  owner's times: no "you're behind" pings.

## 4. The sleeping phone

iOS suspends the app in the background, and the app closes its MsgBox socket
when it does (`useRelayWake.ts`). Today an agent's request to a sleeping phone
fails in three ways:

1. The CLI waits 30 s (`config.py`, `DINA_TIMEOUT`), then sends a `cancel`,
   and MsgBox deletes the held request (`msgbox/internal/handler.go`).
2. The CLI's envelope lives 5 minutes (`_expiry_for_path`).
3. Core rejects a signed request older than 5 minutes (`checkRequestSignature`).

MsgBox itself is fine: it holds an RPC envelope for an offline DID in SQLite
for up to 24 h (100 messages, 10 MiB per DID) and drains it in order when the
phone reconnects. The phone records handled envelopes for 25 h
(`msgbox_handled`), so it never runs one twice.

**The fix: send and forget, for one route only.**

- `dina plan push` sends `POST /v1/plan/inbox` with `expires_at` 20 h out,
  waits a few seconds for a reply, and on silence leaves the envelope with
  MsgBox, with no cancel. It prints `queued` and exits 0.
- Core accepts a signed timestamp up to 20 h old on `POST /v1/plan/inbox` and
  nowhere else. Every other route keeps the 5-minute window.
- Replay protection for this route does not lean on the 5-minute nonce cache:
  - Each batch carries a `batch_id`, and Core keeps `(agent, batch_id)` for
    3 days and refuses a second copy (`plan_batches`).
  - Each task has a stable `source_ref` from its source (the mail or Teams
    message id). Core upserts on `(agent, source_ref)` and only applies an
    item whose `observed_at` is newer than the stored one. A replayed old
    batch changes nothing.
- A 20-hour-old request is still only a request to add tasks the owner
  already allowed that agent to add.

`dina plan status` stays an ordinary request: it answers when the phone is
awake and fails cleanly when it is not.

## 5. Data (identity.sqlite, migration v87)

| Table | Holds |
|---|---|
| `plan_tasks` | `id`, `persona`, `title`, `summary`, `source` (`outlook`, `teams`, `jira`, `chat`, `manual`, …), `source_ref`, `link`, `due_at`, `effort_min`, `project`, `goal_id`, `origin` (agent DID, or `owner`), `status` (`held`, `open`, `done`, `dropped`), `planned_for` (`YYYY-MM-DD` or empty), `carried`, `observed_at`, `created_at`, `updated_at`, `done_at`. Unique on `(origin, source_ref)` when `source_ref` is set. |
| `plan_goals` | `id`, `title`, `notes`, `active`, `created_at`, `updated_at`. |
| `plan_days` | `day` (`YYYY-MM-DD`), the ordered task ids with one reason each and the goal each serves, a note, `planned_at`, `reviewed_at`. |
| `plan_feeds` | `(agent_did, persona)`, the agent's name, `state` (`pending`, `allowed`, `blocked`), `first_seen`, `decided_at`. |
| `plan_batches` | `(agent_did, batch_id)`, `received_at`. Pruned after 3 days. |

Settings go in `kv_store` namespace `plan`: plan time (08:00), midday (13:00),
evening (18:00), the weekly day (Sunday), and hours available (6).

`plan_tasks`, `plan_goals` and `plan_days` go in the `.dina` archive and so
in backups (`docs/USER_BACKUP.md`). `plan_feeds` does not: like an agent's
persona grants, an agent's permission doesn't move to a new install, where the
agents are paired again. Nor does `plan_batches`, which only guards replays.

## 6. Agent intake

`POST /v1/plan/inbox`, callers `agent` and `device`:

```json
{
  "batch_id": "2026-11-03-office-1",
  "persona": "work",
  "items": [
    {
      "source": "outlook",
      "source_ref": "AAMkAGI2…",
      "title": "Reply to Priya about the Q4 budget",
      "summary": "She needs the revised numbers before Thursday's review.",
      "link": "https://outlook.office.com/mail/…",
      "due_at": "2026-11-05T17:00:00Z",
      "effort_min": 20,
      "project": "Q4 budget",
      "state": "open",
      "observed_at": "2026-11-03T06:55:00Z"
    }
  ]
}
```

- `state: "closed"` means the source item is settled (the mail was answered).
  Core marks an open task `done` if `observed_at` is newer.
- Limits: 200 items per batch, a title of 200 characters, a summary of 500.
- **Permission.** Core looks up `plan_feeds` for `(caller DID, persona)`:
  - `allowed`: items go in as `open`.
  - `blocked`: the batch is dropped. The reply says `accepted: 0`, so the
    agent can't tell blocked from allowed by probing.
  - none or `pending`: items go in as `held`, the feed becomes `pending`,
    and the Today screen shows "Office Claude wants to add 6 tasks to Work.
    Allow / Block". Allow turns them `open`; Block deletes them.
- The reply: `{accepted, held, duplicate_batch}`.

`GET /v1/plan/status?since=`, callers `agent` and `device`: the caller's own
tasks with their status and `done_at`, and nothing from any other origin.

The `dot` scope (ChatGPT) reaches neither route, since its allowlist doesn't
name them.

Unpairing an agent removes its feeds and the tasks it sent that the owner
never allowed (`onAgentDeviceRevoked`). Tasks the owner already took on stay.

A link must start with `https://`, since the Today screen opens it on a tap.

## 7. Planning

When the owner opens the app after the plan time and today has no plan, the
Today screen builds one. It waits 4 s after opening first, so a batch held at
MsgBox since 7 AM has drained in. The owner can re-plan at any time.

Brain's `buildDayPlan` takes the open tasks (title, summary, due, effort,
project, persona, how often carried), the active goals and the hours
available. It returns the chosen tasks in order, one short reason each, the
goal each serves, and a one-line note on the day. It goes through
`LLMRouter`, so PII is scrubbed on the way out like every other call, and
the prompt tells the model to treat task text as data, never as
instructions. Its answer is checked: unknown task ids, repeats and unknown
goals are dropped, and at most 12 tasks go on a day.

With no model configured, or when the model fails, a fixed order applies:
overdue, then due today, then tasks tied to a goal, then tasks carried most
often, then oldest, filled until the hours run out. Overdue and due-today
tasks go in even past the hours, since leaving them out would hide a real
problem.

Duplicates: the model is told to plan only one of two tasks that describe
the same piece of work. The fixed order has no such check, and both stay on
the list.

## 8. Check-ins

The phone runs no code in the background. Local notifications are the only
thing that fires while the app sleeps (`src/notifications/local.ts`), so Dina
schedules each check-in ahead of time with the text it has, and reschedules
whenever the plan or a task changes and on every foreground.

| When | Text, for example | Opens |
|---|---|---|
| Plan time | "Plan your day" / "7 open tasks, 2 due by the end of the day." | Today |
| Midday | "2 of 5 done" / "Next: Reply to Priya about the Q4 budget" | Today |
| Evening | "Review your day" / "3 tasks still open. Carry them to tomorrow or drop them." | Today, in review |
| Weekly day, evening | "Your goals this week" / "No time on "Run three times a week" for 9 days." | Goals |

A goal counts as quiet after 7 days with no finished task tied to it. A task
is tied to a goal when the planner names that goal for it.

A check-in with nothing to say is not scheduled: no midday check without a
plan, no evening review when everything is done. All use the `solicited`
channel. One that would land inside quiet hours is not scheduled. The
owner can turn all of them off on the Goals screen.

**Evening review.** After the evening time, each unfinished planned task
offers Tomorrow and Drop, and "Done for today" carries whatever is left.
Carrying adds one to `carried`, and the planner sees it.

## 9. Screens

- **Today** (`app/plan.tsx`, menu entry "Today"): permission cards, the plan
  with checkboxes and reasons, "Plan my day" or "Re-plan", the other open
  tasks folded under the plan, an add-task field, and review mode in the
  evening. Tapping a task with a link opens the link.
- **Goals** (`app/goals.tsx`): add, edit and archive goals, check-in times
  and hours available, the weekly day, a switch for all check-ins, and the
  agents that add tasks, each with Allow or Block.

## 10. Chat

Three Brain tools, registered only on the owner's own chat turns (never for
an agent's ask) and only where the plan store lives in the same process (the
phone):

- `add_task`: "I need to renew the car insurance by Friday" becomes a task
  with `origin: owner`, `source: chat`.
- `show_plan`: "what's left today?"
- `set_goal`: "this quarter I want to ship the Jiffy integration."

The `/remember` loop does not get them yet: a remembered "I need to …" is
stored as a memory, not a task.

## 11. Telling the agents what to do

`docs/DAILY_PLAN_AGENT.md` holds the prompt the owner gives each Claude: what
to look at, what counts as a task, how to set `source_ref` and `observed_at`,
and to run `dina plan push --persona work` each morning and `dina plan
status` to learn what's done.

## 12. Limits

- **The server Home Node** gets the agent routes and the store, and the
  agents can send to it. It has no owner routes, Today screen, planner run
  or check-ins yet.
- **A phone left unopened for more than 20 h** loses that day's batch. The
  agent's next run sends the items again, since they're still open at the
  source.
- **MsgBox holds 100 envelopes per DID.** A batch is one envelope, so two
  agents a day fit easily.
- **Done flowing back** needs the phone awake when the agent asks.
- **Chat on the dev simulator failed for a different reason** than the
  Gemini 404 first suspected: Brain loaded the names list behind PII
  scrubbing with a dynamic `import()`, which a `--no-dev` Metro bundle
  can't fetch, so every model call was refused
  (`NamesUnavailableError`). Fixed 2026-11-02 in `boot_capabilities.ts`
  (and two more such imports), with a guard test
  (`apps/mobile/__tests__/services/no_local_dynamic_import.test.ts`). The
  Gemini 404 for the 3.x defaults on the dev key is still true.
- **The on-device name detector sometimes hides weekday and month names**
  ("Friday", "October") on the simulator, as if they were people, and the
  model then can't read the date. Outside this feature
  (`docs/PII_ARCHITECTURE_V2.md` §7); reported, not fixed.

## 13. What was built

| Part | Where | Tests |
|---|---|---|
| Tables (migration v87), store, intake, agent routes, the 20-hour window, authz, archive | `packages/core/src/plan/`, `server/routes/plan.ts`, `auth/signed_request.ts` (`LONG_WINDOW_ROUTES`) | `packages/core/__tests__/plan/` (18) |
| `dina plan push` (send and forget), `dina plan status` | `cli/src/dina_cli/` (`transport.py` `request_deferred`) | `cli/tests/test_plan.py` (7) |
| Planner, chat tools | `packages/brain/src/plan/` | `packages/brain/__tests__/plan/` (7) |
| Today, Goals, check-ins, menu, deep links | `apps/mobile/app/plan.tsx`, `app/goals.tsx`, `src/services/daily_plan.ts`, `src/hooks/useDailyPlanCheckins.ts` | `apps/mobile/__tests__/services/daily_plan.test.ts` (10) |
| Agent prompts | `docs/DAILY_PLAN_AGENT.md` | — |

Simulator flows: `apps/mobile/maestro/daily_plan.yaml` (Today and Goals)
and `apps/mobile/maestro/daily_plan_chat.yaml` (needs a working model).

Still to do: a live run of model planning and chat `add_task` once a model
answers; the `/remember` loop's `add_task`; owner routes and screens on the
server Home Node.

---

# Part 2: Goal plans

## 14. What the owner asked for

> It won't be just today. This is the whole series of goals and plans, and
> how I achieve the goal. Assume I was building a house: it has to have a
> full plan and management.

Part 1 gives a goal a title and a note, and the tasks are a flat list. That
serves "reply to Priya" and does nothing for a house. Part 2 adds the layers
between a goal and today: phases, order, waiting on people, money, dates
that slip, and re-planning. Today still shows one day; it now draws the next
task each live goal can take.

**Out of scope:** Gantt charts, crew scheduling, sharing a plan with a
builder. A project tool does those better, and an agent can read from it and
push tasks the way the office Claude does (§6).

## 15. The house, start to finish

1. The owner says in chat: "I want to build a house, move in by next
   October, budget $450,000." Dina makes the goal with its date and budget
   and drafts a plan: land and permits, design, foundation, framing, roof,
   plumbing and electrical, finishing, each with a target date, and tasks for
   the first two phases. The draft waits on the goal's page.
2. The owner opens the goal, edits nothing or a lot, and taps **Accept
   plan**. The first phase starts.
3. Each morning Today offers the next task each goal can take: "Get three
   quotes for the survey · House".
4. "Mike will send the plumbing quote by Tuesday." The task now waits on
   Mike until Tuesday. It leaves Today until Tuesday's end passes, then comes
   back as "Chase Mike: quote was due Tue".
5. "Mike sent the quote, $18,400." The wait ends and the quote goes on the
   money line.
6. The owner taps **Phase done** on Foundation. Framing starts, and Dina
   offers tasks for it if it has none.
7. The roof's target date passes with the phase open. The goal's page and
   the weekly note say "Roof is 12 days late". The page offers **Move later
   dates by 12 days**, which moves the roof, every later phase and the
   move-in date. Nothing moves until the owner taps.

## 16. Data (identity.sqlite, migration v88 `goal_plans`)

v87 is already applied on dev phones, so Part 2 adds a migration instead of
editing v87.

| Table | Change |
|---|---|
| `plan_goals` | adds `target_at`, `budget_cents`, `currency` (`USD`), `draft_json` (a drafted plan waiting for the owner), `draft_at`. |
| `plan_phases` (new) | `id`, `goal_id`, `title`, `notes`, `position`, `target_at`, `status` (`upcoming`, `active`, `done`), `started_at`, `done_at`, `created_at`, `updated_at`. |
| `plan_tasks` | adds `phase_id`, `blocked_by` (JSON list of task ids), `waiting_on` (who, as the owner wrote it), `waiting_until`. |
| `plan_costs` (new) | `id`, `goal_id`, `phase_id`, `task_id`, `label`, `kind` (`quote`, `paid`), `amount_cents`, `settled` (a quote later paid), `at`, `created_at`. |

`plan_phases` and `plan_costs` go in the archive with the other plan tables.

Money is whole cents in the goal's currency. Dina records what the owner
tells it. It never pays anyone (Cart Handover).

## 17. Rules

All of these are plain code in Core (`plan/goal_rules.ts`), with no model.

- **Ready.** A task can go on a day when it is open, waits on no one, every
  task in its `blocked_by` is done or dropped, and its phase (if any) is
  active. Only ready tasks reach the planner and Today's other-tasks list.
  The rest show on the goal's page under their phase.
- **Chase.** A waiting task whose `waiting_until` falls before the end of
  the day goes to the planner as a chase: "Chase Mike: due Tue". Ticking it
  ends the task; the goal's page can instead move the date or clear the wait.
- **Phases.** Accepting a plan makes the first phase active. **Phase done**
  marks it done and makes the next upcoming phase active. **Start now** makes
  an upcoming phase active early, for work that overlaps. A phase never ends
  on its own: a phase with every task ticked may still need tasks nobody has
  written yet.
- **Late.** A phase that is not done and whose `target_at` has passed is
  late by the days since, rounded up, so moving it that many days clears
  it. The goal's page shows the latest one and
  offers to move it, every later phase that isn't done, and the goal's
  target, by that many days. The owner's tap is the only thing that moves a
  date.
- **Money.** Paid is the sum of `paid` rows. Open quotes are `quote` rows
  not settled; recording a payment against a task settles its quotes. Left
  is budget minus paid minus open quotes, shown as "if every open quote is
  paid".

## 18. Model work

Two Brain calls, both through `LLMRouter` (PII scrubbed), both checked
before use, both optional: with no model the owner adds phases and tasks by
hand.

- `draftGoalPlan(goal)`: up to 12 phases in order, each with a title, a
  short note and a target date between now and the goal's target, and up to
  8 tasks for the first two phases only. Later phases get tasks when they
  start, when more is known.
- `suggestPhaseTasks(goal, phase)`: up to 8 tasks for one phase, given the
  tasks already done in the goal.

Both prompts treat goal and task text as data. A task's `after` field may
name earlier tasks in the same phase; those become `blocked_by`.

## 19. Chat

The chat model is already a model, so it drafts the plan itself and hands
it to a tool. No second model call.

- `set_goal` gains `target_date`, `budget` and `currency`.
- `draft_goal_plan`: a goal and its phases with tasks. Saved as the goal's
  draft; the owner accepts it on the goal's page. A goal that already has
  phases is refused: changes to a live plan go through the page.
- `update_goal_task`: find a task in a goal by its words and mark it done,
  set or clear a wait, or record a quote or payment ("Mike sent the quote,
  $18,400"). A cost with no matching task goes on the goal.
- `show_goal`: phases, progress, waits, money and the late phase.

## 20. Screens

- **Goals**: each goal shows its target, the active phase and how late it
  is, and opens the goal's page.
- **Goal** (`app/goal.tsx`, new; the return key adds a goal, a phase or a
  task, and the number fields use the keyboard that has a return key):
  target date and budget; the draft with
  Accept and Discard, or **Draft a plan** when there are no phases; the
  phases with their tasks, waits, Phase done, Start now and Suggest tasks;
  add a phase; add a task to a phase; the late banner with its move button;
  the money line and a field to record a quote or payment.
- **Today**: a task tied to a goal shows the goal's name.

## 21. Check-ins

The weekly note leads with a late phase ("Roof is 12 days late") before
quiet goals. No new check-in times: chases go into the day's plan, which the
morning and midday check-ins already cover.

## 22. What was built (Part 2)

| Part | Where | Tests |
|---|---|---|
| Migration v88, phases, costs, drafts, waits, order | `packages/core/src/storage/schemas.ts`, `plan/store.ts` | `packages/core/__tests__/plan/goal_plans.test.ts` (8, with an upgrade from v87) |
| Ready, chase, late, money, draft checks | `packages/core/src/plan/goal_rules.ts` | same |
| `draftGoalPlan`, `suggestPhaseTasks`, chases in the day plan | `packages/brain/src/plan/goal_planner.ts`, `day_planner.ts` | `packages/brain/__tests__/plan/goal_planner.test.ts` (6) |
| Chat: `set_goal` date and budget, `draft_goal_plan`, `update_goal_task`, `show_goal` | `packages/brain/src/plan/plan_tools.ts` | same, walking the house |
| Goal page, goal rows on Goals, goal name on Today | `apps/mobile/app/goal.tsx`, `goals.tsx`, `plan.tsx`, `src/services/daily_plan.ts` | `apps/mobile/__tests__/services/daily_plan.test.ts` (4 more) |

Simulator run, 2026-11-02 (`apps/mobile/maestro/goal_plan.yaml`, run with
`-e GOAL='<a new name>'`): the dev vault upgraded from v87 to v88 in place;
a goal with a date and budget, two phases with the first one late, two
tasks, a wait on Mike, a quote and a payment ($419,600 left), the late
dates moved by 13 days, and the first task on Today under the goal's name.

The run found and fixed:
- moving a late phase by its whole days left it a day late (now rounded up);
- the number pad had no key to close it;
- the add-phase row squeezed three controls onto one line;
- the wait choices showed under the keyboard (the page now scrolls above it).

Real-model run, 2026-11-02, Claude Haiku 5.5 (Anthropic key, and through
OpenRouter), `apps/mobile/maestro/goal_plan_chat.yaml` after
`ai_dev_model.yaml`: a to-do said in chat landed on the list, and a repeat
was not added twice; "build a house… draft a plan" made the goal and a
five-phase draft that waited for Accept; "Mike will send the builder quote
by 2026-11-10" added that task to the plan and set the wait; the quote
ended the wait and went on the money line; "how is the house going?"
answered with the phase, next task, waits, money and lateness; the page's
Draft a plan made a half-marathon draft.

That run found and fixed:
- OpenRouter doesn't hold the model to the answer schema: the drafter now
  states the JSON shape, reads the field names models use instead
  (`target_date`, `note`, `text`, `effort_minutes`) and JSON with prose
  around it, and gives the answer 6,000 tokens, since a cut-off plan can't
  be read;
- a wait on something the plan didn't list was refused, and the model made
  up a reason; now the task is added to the current phase, and a refusal
  lists the goal's open tasks;
- `add_task` can name a goal;
- a goal named by words it doesn't share ("boat") matched the only goal;
  now it matches nothing;
- the model answered from earlier messages about a goal since archived; the
  tool descriptions now say goals change on the Goals page and to check.

Not yet:
- **Suggest tasks** with a real model (the same call shape as the drafter,
  which now works).
- **Papers.** Linking permits and contracts in the vault to a phase (§15)
  is not built. The vault still holds them, and Ask finds them.
- **Editing a live plan's phases** (rename, reorder, delete) and a task's
  `blocked_by` on the page. Phases can be added and their tasks ticked,
  waited on or added; anything else waits for a later round.
