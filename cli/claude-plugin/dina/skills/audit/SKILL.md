---
name: audit
description: Show Dina's recent gate/access audit — what was allowed, flagged, or blocked.
user-invocable: true
argument-hint: "[limit]"
---

Run `dina audit` (append `--limit $ARGUMENTS` if the user gave a number) and summarize the recent entries, most recent first: which actions Dina classified and how — allowed, flagged for your approval, or blocked — with the reason where one is given.

Keep it to roughly the last 15 entries unless the user asks for more. If it reports nothing, or that Dina is not configured, say so plainly rather than inventing entries.
