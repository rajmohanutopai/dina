---
name: audit
description: Show Dina's recent coding-gate audit events for this paired agent.
---

# Review Dina Audit

Run `dina audit` and summarize roughly the 15 most recent entries unless the
user requests another limit. Report which actions were allowed, required
approval, or were denied, with the reason when present.

The audit projection is caller-scoped. Do not claim access to another device's
events or raw sensitive audit details. If no entries exist or Dina is not
configured, state that plainly.
