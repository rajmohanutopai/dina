# Promises and waits

Status: built 2026-11-08. One place for what the owner is owed and what they owe,
and promises in Talk caught as they are made.

## 1. Why

Dina already tracks promises and waits, each in its own place: a goal task can
wait on someone, a group booking waits on guests, a tender waits on quotes, an
order waits on a supplier, and a shelf agreement names what each side promised.
Nothing joins them, so "what am I waiting on?" has no full answer. And a
promise made in Talk ("I'll send it Monday") is tracked only if the owner types
it into a goal by hand.

## 2. What it does

1. **One list.** `listPromisesAndWaits(now)` in Core joins every source into
   items of one shape, sorted late first, then by date, then undated. It feeds
   the phone's "Promises and waits" screen and Brain's `list_promises` tool.
2. **Talk promises, offered.** After each Talk message, in or out, Brain asks
   the model one question: does this message hold a promise, who owes it, what,
   and by when? When it does, Dina posts a card in the owner's chat: "Mike said
   he'd send the deck by Monday. Track it?" Nothing is tracked without a yes.
3. **A yes is a plan task.** Talk promises live in the plan store as ordinary
   tasks (`source: 'talk'`, `sourceRef` = the contact's DID, `link` = their Talk
   thread), so the daily plan, check-ins and chat already handle them:
   - **owed to the owner** → a wait: `waitingOn` = their name, `waitingUntil` =
     the date. Once late, the day plan puts "Chase Mike" on the day (§17 of
     DAILY_PLAN.md).
   - **owed by the owner** → a task due on the date (`dueAt`).

## 3. The item

```ts
interface PromiseItem {
  id: string;                // '<source>:<source id>[:<part>]', stable
  direction: 'owed_to_me' | 'owed_by_me';
  source: 'plan' | 'talk' | 'group_plan' | 'tender' | 'order' | 'agreement';
  who: string;               // a name, never empty ("Someone" when unknown)
  whoDid: string | null;
  what: string;              // one line
  dueAt: number | null;      // ms
  late: boolean;             // dueAt before the start of today
  ref: string;               // the source's own id, for opening it
}
```

| Source | Owed to me | Owed by me |
|---|---|---|
| Plan task, open, `waitingOn` set (`talk` or not) | who = `waitingOn`, due = `waitingUntil` | — |
| Plan task, open, `source: 'talk'`, no `waitingOn` | — | due = `dueAt` |
| Group plan open, guest `outcome: 'waiting'` | one per plan: the guests still to answer, due = window close | — |
| Tender not expired, members with no quote | one per tender: suppliers still to quote, due = `expiresAt` | — |
| Unsettled buyer order (`submitted_unconfirmed`, `outcome_unknown`) | the supplier, the order's headline | — |
| Accepted shelf agreement promise | by the other side's role | by this side's role |

Rules:
- A source that fails to read is left out; the rest still list.
  `listPromisesAndWaits` returns `{ items, missing: source[] }` so a reader can
  say what it could not see.
- Archived goals' tasks stay out, as in the day plan.
- Names come from the contact directory; an unknown DID shows as "Someone".
- A shelf agreement promise that repeats ("delivery every 7 days") shows once,
  with no date: the evidence sweep asks about each occurrence (COMMITMENT_KERNEL
  §13).

## 4. Catching a promise in Talk

- **Where:** inbound, when a Talk message from a contact reaches the owner's
  per-peer thread; outbound, when the owner's message to a contact is sent
  (the per-peer screen and the `send message` tool).
- **The question** goes through the owner's model router, so PII is scrubbed
  on the way out, as for every model call. Lite tier, one short JSON answer:
  `{promise: boolean, by: 'sender' | 'recipient', what, due_text, due_at}`.
  The model judges what counts as a promise; there are no hand-written phrase
  rules. `due_at` is checked: a date in the past or beyond a year is dropped
  and the promise is offered undated.
- **The card** (`promise_offer` lifecycle, main thread): the promise in a
  sentence, the date, and two buttons, *Track it* and *Not now*. Its state
  (`open` → `tracked` | `dismissed`) is saved on the message, so it survives a
  restart and a second tap does nothing.
- **Duplicates:** one card per message (keyed by the message id); a message
  already offered is not asked about again.
- **No model, or the model fails:** no card. Missing a promise is better than
  inventing one.
- **Silence First:** the card is an engagement-tier item in the owner's own
  chat, with no notification. It speaks because the owner just took part in the
  exchange.

## 5. Closing

The owner marks a wait "Got it" or a task done, from the list or the goal
screens, as today. A wait closed by the owner clears `waitingOn`. Dina does not
yet close a wait on its own when the promised thing arrives.

## 6. Tests

- Core: `packages/core/__tests__/promises/` (the joined list over a real
  SQLCipher database, tracking once per message, the route's access rule).
- Brain: `packages/brain/__tests__/promises/talk_promises.test.ts` (reading
  the model's answer, one card per message under two checks at once, the
  `send_message` hook, the `list_promises` tool).
- Phone: `apps/mobile/__tests__/services/promises.test.tsx` (the card's
  answers and restart, closing from the list, Talk in and out reaching the
  check).
- Real model: `find_promise.eval.test.ts`, run with `RUN_PROMISE_EVAL=1`.
  Claude Haiku 4.5 passed 10 of 10 twice on 2026-11-08: promises both ways,
  with and without a day, a short reply read in context, and five messages
  that are not promises.
- The card and screen state machine is PH-M18 in docs/STATE_MACHINES.md.
- Simulator, 2026-11-08 (iPhone 17, Claude, against the `dina-nodes` Sancho
  node over test MsgBox): Sancho's "I will send you the deck by Friday" made
  a "promise to you" card due Fri 13 Nov; the owner's "I'll call you tomorrow
  to confirm the venue" made a "promise you made" card due Mon 9 Nov; a
  message with no promise made no card; both tracked items listed on the
  screen after two restarts; Done closed one; asked in a fresh chat, Dina
  listed both from `list_promises`.
- Found on the simulator and fixed: the phone's Ask Core client
  (`lazyCoreClient`) lacked `promisesList` and 13 other methods the owner's
  chat tools need, so `list_promises`, `send_message` ("tell Sancho …"),
  forget, export, spending limits, standing replies and deal values never
  registered on the phone. `ask_core_client.test.ts` now reads every check
  in `agentic_ask.ts` and requires the phone's client to have it.

## 7. Not in this note

- Closing a wait on its own when the other side delivers.
- Catching promises in mail or other channels than Talk.
- Telling the other person about a late promise; a chase stays the owner's.
- Reminders: they are the owner's own notes to self, on their own screen.
