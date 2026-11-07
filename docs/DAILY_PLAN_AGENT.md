# Daily plan: instructions for your agents

Give this to each Claude that should feed your Dina's daily plan
(`docs/DAILY_PLAN.md`): one for work, one for personal life. Each needs the
`dina` CLI paired with your Dina once (`dina configure`, using a setup code
from the app's Settings → Agents).

The first batch from each agent puts a card on the Today screen: "Office
Claude wants to add 6 tasks to Work. Allow / Block". Nothing shows in the
plan until you tap Allow.

---

## Prompt for your office Claude

> Every weekday at 7:00, find my work items for today and send them to my
> Dina.
>
> 1. Look at my Outlook mail and Teams chats from the last two days, my
>    Jira or Azure DevOps items assigned to me, and my calendar for today.
> 2. A task is something I have to do: reply, review, decide, prepare,
>    send. Not FYI mail, newsletters, or meetings themselves (a meeting
>    I must prepare for gives a "prepare for …" task).
> 3. For each task write:
>    - `title`: short, starting with a verb ("Reply to Priya about the Q4
>      budget").
>    - `summary`: one or two lines on why or what's needed. No quotes from
>      the message, no attachments, no figures I didn't ask for.
>    - `source`: `outlook`, `teams`, `jira` or `calendar`.
>    - `source_ref`: the message, thread or ticket id, so a repeat updates
>      the same task.
>    - `link`: the https link that opens it.
>    - `due_at` if there is a real deadline, `effort_min` as a rough guess,
>      `project` if it belongs to one.
>    - `observed_at`: the time you looked.
>    - `state: "closed"` for an item from an earlier batch that is now
>      settled (I replied, the ticket closed).
> 4. Write them as a JSON list to a file and run:
>    `dina plan push --persona work --file today.json`
>    If it prints `queued`, my phone was asleep; that's fine, the batch
>    waits for it.
> 5. Before building the list, run `dina plan status` to see what I
>    finished or dropped. Don't send those again. Don't mark anything done
>    in Outlook, Teams or Jira yourself.

## Prompt for your personal Claude

> Every morning at 7:00, find my personal to-dos for today and send them to
> my Dina.
>
> Look at my personal mail, my notes and lists, and anything due soon
> (bills, renewals, appointments to book). Follow the same rules as above,
> with `source` set to where you found it, and run:
> `dina plan push --file today.json`
> (no `--persona`: personal tasks go to my general persona).

## What the agent sees back

`dina plan push` prints one of:

| Status | Meaning |
|---|---|
| `delivered` | The phone took the batch. `accepted` counts new or changed tasks. |
| `delivered` with `held` | The phone took it, and the tasks wait for your Allow. |
| `queued` | The phone was asleep. MsgBox holds the batch for up to 20 hours. |
| `duplicate` | This batch id was already taken. Nothing changed. |

`dina plan status` lists the agent's own tasks with `status` (`held`,
`open`, `done`, `dropped`) and `planned_for`. It needs the phone awake, and
it shows nothing from any other agent or from you.

## Example batch

```json
[
  {
    "title": "Reply to Priya about the Q4 budget",
    "summary": "She needs the revised numbers before Thursday's review.",
    "source": "outlook",
    "source_ref": "AAMkAGI2TG93AAA=",
    "link": "https://outlook.office.com/mail/id/AAMkAGI2TG93AAA%3D",
    "due_at": "2026-11-05T17:00:00Z",
    "effort_min": 20,
    "project": "Q4 budget",
    "observed_at": "2026-11-03T06:55:00Z"
  }
]
```
