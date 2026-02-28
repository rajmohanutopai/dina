> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 7: Action Layer

Dina detects the need, assembles context, enforces safety rules, delegates execution (to the user or to an action agent like OpenClaw), and verifies the outcome. She is the approval gate, not the executor.

**Two exceptions where Dina acts directly:**
1. **Draft-Don't-Send** — because this is a safety enforcement mechanism. Dina ensures no agent auto-sends on your behalf.
2. **Cart Handover** — because this is an approval gate. Dina generates a payment intent; you authorize it.

### Draft-Don't-Send

**No agent operating under the Dina Protocol shall ever press Send. Only Draft.**

Dina (or a delegated action agent) may draft a response, but the draft must pass through Dina's approval gate before reaching the user for final review.

```
Dina reads incoming email (from Vault)
        ↓
Classifies: conference invite, you're free, low-risk response
        ↓
Drafts reply via Gmail API (drafts.create, NOT messages.send)
        ↓
Stores in Tier 4 (Staging):
{
    "type": "email_draft",
    "gmail_draft_id": "r123456",
    "to": "conference@org.com",
    "subject": "Re: Conference Invite",
    "body": "Hi, I'd love to attend. Added to my calendar.",
    "dina_confidence": 0.85,
    "created_at": "2026-02-15T10:00:00Z",
    "expires_at": "2026-02-18T10:00:00Z"
}
        ↓
Notifies user: "Conference invite. Drafted a 'Yes'. [Review & Send]"
        ↓
User taps [Review & Send] → sees draft in Gmail → edits if needed → presses Send
```

**Rules:**
1. Dina NEVER calls `messages.send`. Only `drafts.create`.
2. Every draft has a confidence score. Below threshold → Dina flags for manual review.
3. Drafts auto-expire after 72 hours.
4. High-risk classifications (legal, financial, emotional) → Dina only summarizes, never drafts.

### Cart Handover

```
Dina finds the best chair
        ↓
Constructs payment intent:

UPI:  upi://pay?pa=merchant@okicici&am=12000&pn=ChairMaker&tr=DINA-TXN-12345
Crypto: ethereum:0x1234...?value=0.05&data=0x...
Web:   https://chairmaker.com/checkout?cart=DINA-CART-12345
        ↓
Stores in Tier 4 (Staging):
{
    "type": "payment_intent",
    "method": "upi",
    "intent_uri": "upi://pay?...",
    "merchant": "ChairMaker",
    "amount": 12000,
    "currency": "INR",
    "dina_recommendation": "Best match. Rep score 94. 89% still using after 1 year.",
    "created_at": "2026-02-15T10:00:00Z",
    "expires_at": "2026-02-15T22:00:00Z"
}
        ↓
Presents to user: "₹12,000 to ChairMaker. [Pay Now]"
        ↓
User taps [Pay Now]
        ↓
Phone OS opens GPay/PhonePe/Metamask via deep link
        ↓
User enters PIN / biometric
        ↓
Payment app sends confirmation (SMS or callback)
        ↓
Dina records outcome in Tier 3 for future Trust Network contribution
```

**Dina never sees:** Bank balance, UPI PIN, card numbers, payment credentials. She generates the link. The OS handles the rest.

### Agent Delegation (via MCP)

For tasks beyond drafting and payments, Dina delegates to external child agents. The integration protocol is MCP (Model Context Protocol) — the same standard used by Claude, OpenClaw, and the broader agent ecosystem. **Dina has no plugins — child agents are external processes.** MCP is a wire protocol for task delegation, not a mechanism for running code inside Dina.

```
User's license needs renewal
        ↓
dina-brain detects (from ingested email or calendar):
  "License expires in 7 days. User hasn't acted."
        ↓
dina-brain classifies: Priority 2 (user should know) or Priority 1 (fiduciary — harm if missed)
        ↓
Option A — Notify only:
  Nudge: "Your license expires next week."
        ↓
Option B — Delegate (if user has pre-authorized):
  dina-brain calls OpenClaw via MCP:
    Tool: "form_fill"
    Context: {task: "license_renewal", identity_persona: "/legal"}
    Constraints: {no_payment: true, draft_only: true}
        ↓
  OpenClaw fills forms, returns draft for review
        ↓
  dina-brain stores in Tier 4 (Staging)
        ↓
  Notifies user: "License renewal forms ready. [Review]"
        ↓
  User reviews, approves, submits
```

**Orchestration rules:**
1. Dina never gives an action agent raw vault data. She provides only the minimal context needed for the task, scrubbed through the PII layer.
2. Every delegated action passes through the Silence Protocol first — Dina decides IF to act, not just HOW.
3. Action agents operate under Dina's constraints. If Dina says `draft_only: true`, the agent cannot send.
4. Outcomes are recorded in Tier 3 for the agent's trust score. If OpenClaw's form-fill quality drops, Dina routes to a better agent.

### Scheduling: Three Tiers, No Scheduler

Dina does not have a general-purpose scheduler. Scheduling is hard when you try to build one. It's easy when you limit yourself to "what's the next thing, and when is it due."

| Problem | Solution | Complexity |
|---------|----------|-----------|
| **Periodic tasks** (watchdog, integrity checks) | Go ticker (`time.NewTicker`) | Trivial. Loop with a sleep. If you miss one, catch it next tick. No persistence needed — tickers restart with the process. Sync scheduling lives in brain, not core. |
| **One-shot reminders** ("wake me at 5 AM", "license expires in 7 days") | Reminder loop on vault | 20 lines of Go. Store reminder in vault with trigger timestamp. One loop checks "what's next." |
| **Complex scheduling** ("every Monday at 9 AM except holidays") | Delegate to calendar service via OpenClaw | Don't build it. Recurrence rules, timezone math, daylight saving — Google Calendar spent years getting this right. |

**The reminder loop:**

```go
func reminderLoop(vault *Vault) {
    for {
        next := vault.NextPendingReminder()  // SELECT ... ORDER BY trigger_at LIMIT 1
        if next == nil {
            time.Sleep(1 * time.Minute)      // nothing pending, check again later
            continue
        }
        sleepDuration := time.Until(next.TriggerAt)
        if sleepDuration > 0 {
            time.Sleep(sleepDuration)
        }
        notify(next)                          // push to client device
        vault.MarkFired(next.ID)
    }
}
```

On reboot, the loop starts, finds the next reminder, sleeps until it's due. If the server was down when the reminder should have fired, `sleepDuration` is negative — it fires immediately. Missed reminders are caught on startup. No cron library, no scheduler dependency, no complexity.

**For recurring schedules:** Brain tells the user "I've noted this. Want me to create a recurring calendar event?" Then delegates to the calendar service via OpenClaw. Don't rebuild Google Calendar inside Dina.

### Design Notes: Future Action Layer Features

**Emotional state awareness (Phase 2+).** Before approving large purchases or high-stakes communications, a lightweight classifier assesses user state (time of day, communication tone, spending pattern deviation). Flags "user may be impulsive" and adds cooling-off suggestion.

**Content verification (Phase 2+).** C2PA/Content Credentials for media provenance. Cross-reference claims against Trust Network. Requires significant ML infrastructure.

**Anti-Her safeguard (Phase 2+).** If interaction patterns suggest user is treating Dina as emotional replacement for human relationships, Dina redirects: "You haven't talked to Sancho in a while." Heuristic-based, tracks frequency/content/time-of-day. Architectural enforcement of the Four Laws.

**Open Economy (Phase 3+).** Dina-to-Dina negotiation via ONDC, UPI/crypto payments. Cart Handover extends to discovery and direct commerce. Requires mature Trust Network and commerce protocol.

---

