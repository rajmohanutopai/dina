# Agent guardrails belong in code, not the prompt

*Technical notes from building Dina, a sovereign personal AI. Part 1 of a series.*

There is a tempting way to make an AI agent safe. You write, in the system prompt, something like: *"Before you send an email, spend money, or share private data, stop and ask the user for confirmation."* The model is smart. It will understand. It will comply.

It will comply most of the time, which is precisely the problem.

A system prompt is a request, not a constraint. The model that you are asking to restrain itself is the same model an attacker is trying to manipulate, and it is a probabilistic system: it produces the most likely continuation, not a guaranteed one. A single cleverly worded message in an email it is summarizing, a jailbreak phrased as a hypothetical, an instruction buried in a tool result, and the "please confirm first" rule is one token away from being forgotten. You cannot ask the fox to guard the henhouse and call it a security boundary, no matter how sternly you word the request.

So in Dina, the agent does not enforce its own limits. The limit is enforced in deterministic code that sits outside the model, and the model is never in the trust path of that decision. This post is the argument for why, and exactly how it works, with the part I got wrong left in.

## Propose, classify, gate

The design separates three things that are usually tangled together:

1. **The agent proposes.** It can want anything. The LLM, or an external agent connected through Dina, decides it would like to send an email, read a vault, transfer money. Wanting is free and unconstrained. This is the only part the model touches.
2. **Deterministic policy classifies.** A plain function maps the proposed action to a risk tier. No model runs here. It is a lookup table and a comparison.
3. **A gate decides execution.** Before any action with an effect runs, the execution code calls a pure function that returns a boolean. If it returns false, nothing happens. The model cannot talk its way past a boolean.

And it runs in the right place. The classifier and the gate live in **Core**, the process that holds the encryption keys and is the only one that ever opens the vault. Core treats the reasoning layer and every connected agent as an *untrusted tenant*: an agent does not call a function, it submits an *intent* over HTTP, and Core decides. The model and the gate are not just separate functions, they are separate processes, and only one of them holds the keys.

The classifier is unglamorous on purpose:

```ts
// packages/core/src/gatekeeper/intent.ts
export type RiskLevel = 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';

const DEFAULT_POLICY: Record<string, RiskLevel> = {
  search: 'SAFE',  list: 'SAFE',  remember: 'SAFE',  store: 'SAFE',
  send_large: 'MODERATE',  modify_settings: 'MODERATE',
  purchase: 'HIGH',  payment: 'HIGH',  transfer_money: 'HIGH',
  credential_export: 'BLOCKED',  key_access: 'BLOCKED',  read_vault: 'BLOCKED',
};

// Unknown action? Fail safe to MODERATE (needs approval) — never SAFE.
let riskLevel = DEFAULT_POLICY[action] ?? 'MODERATE';
```

That `?? 'MODERATE'` is half the philosophy in one operator. Most security bugs are not "we classified a dangerous thing as safe." They are "a dangerous thing showed up that we never classified at all." A fail-safe default turns the unknown into the cautious case instead of the silent case.

The other half is a set of actions no automated caller may *ever* perform, not even with your approval:

```ts
const BRAIN_DENIED = new Set([
  'did_sign', 'did_rotate', 'seed_export', 'persona_unlock',
  'vault_raw_read', 'vault_raw_write', 'vault_export', 'vault_backup',
]);
```

Signing as you, exporting your seed, reading the raw vault: there is no risk tier for these and no approval dialog. They are denied to agents outright; you do them yourself, in the UI, or not at all. Some boundaries should not even have a "yes" button.

Everything in between is a deterministic decision, with two more rules layered on, also in code, also model-free:

- **Trust ring for money.** `purchase` and `payment` require a Ring-2+ (verified) caller. An untrusted agent attempting them is `BLOCKED`, not merely held for approval. Cart Handover as policy: Dina advises on spending and never touches it, and an unknown agent does not even get to ask.
- **Untrusted callers lose the fast path.** Any non-verified agent has its `SAFE` actions escalated to `MODERATE`. "Safe" is relative to who is asking.

What comes out is an `IntentDecision`: `allowed`, `requiresApproval`, and an `audit` flag (every non-SAFE decision is logged). `SAFE` runs silently. `MODERATE` and `HIGH` are held until you say yes; a `MODERATE` yes can be covered by a scoped session grant, a money action surfaces every time. `BLOCKED` never runs. The agent receives a decision, not a capability. It cannot move the threshold, cannot self-approve, and cannot perform the operation itself, because the thing that performs operations is Core, and Core holds the keys.

The point is not that this code is clever. The point is that it is *dumb*, deterministic, and outside the model. A prompt injection can make the agent *propose* something terrible. It cannot make Core run it.

## Risk tiers, and what "approval" actually is

| Tier | Examples | What happens |
|---|---|---|
| **SAFE** | search, list, remember, store | runs immediately, silently |
| **MODERATE** | bulk send, modify settings, *any unknown action* | held for a yes; a session grant can cover it |
| **HIGH** | purchase, payment, transfer | held for a yes, audited, every single time |
| **BLOCKED** | read the raw vault, export keys, sign as you | denied; you do these in the UI, never an agent |

"Approval" is not the model deciding it has permission. It is a record created by a human action and checked by the code that performs the operation. The agent holds a *decision*, not a capability: it cannot self-issue one, cannot widen it, and cannot reuse it past the work session it was granted in. A `MODERATE` yes is scoped to a named session and revoked when that session ends, so "yes, for this task" never silently becomes "yes, forever." A `HIGH` action gets no such grace: money surfaces to you every single time.

This is what lets the system avoid the failure mode that kills approval-based UX: asking about everything until the user reflexively taps yes. `SAFE` reads never interrupt. Stateful actions ask, and the yes is scoped and expires with the task. The *cost* of an approval is matched to the *risk* of the action, and that matching is policy in code, not vibes in a prompt.

## The same discipline, both directions

The insight that took me longest to see: gating is symmetric. There are two questions, not one.

- **Outbound:** what can an agent acting for me *do* to the world? (Send, spend, share.) That is the risk-tier gate above.
- **Inbound:** what can the world, or an agent, *reach* in me? (Read my vaults, invoke my services.)

I had built the outbound gate first and felt good about it, and then realized the inbound side was wide open in spirit if not in fact: an agent that can *read* your health vault to "draft a helpful email" has crossed a boundary just as real as one that *sends* it.

So the inbound side gets the same treatment. Personas (the separate encrypted vaults) carry an access tier, and the gate is, again, deterministic code:

- **default / standard** — open to agents within a session, no drama.
- **sensitive** — closed at boot; an agent must get explicit approval to read it, every read evaluated by the same `requiresApproval` logic.
- **locked** — closed, passphrase-gated, key not even in memory; agents are denied outright, no approval path exists.

And the same logic governs services, the feature that lets your Dina answer other people's Dinas. A published service has reach modes (public, provider-specific, unlisted, private) and a response policy, and a sensitive answer is *drafted for your approval* before it leaves, exactly like an outbound email. Child-scoped data (a student's homework) is hard-blocked from generic discovery entirely, not merely de-ranked. One philosophy, pointed in both directions: the boundary is enforced by code that does not run the model, and the model is never asked to respect a boundary it could rationalize its way around.

One sharp corollary worth stating, because it is where "sovereign" stops being a slogan: an agent never holds your keys. It proposes; Dina, which holds the keys, executes or refuses. The agent operates with the access a task needs and nothing more, and that access is a grant it cannot mint for itself.

## The part I got wrong

Here is the dead end, because a guardrail post without one is marketing.

Dina-to-Dina messages are end-to-end encrypted and carry a signed inner body: a small JSON object with `from`, `to`, a service URI, the payload. When a message arrived asking my Dina to do something on a contact's behalf, the obvious thing to authorize against was that inner body. It is signed. It says who it is from. Use it.

That is a confused-deputy bug wearing a nice suit.

The inner body is *sender-chosen*. The signature proves the bytes were not tampered with in transit; it proves nothing about whether the sender was entitled to claim what they claimed. An agent could set `from` to a contact you trust and `to` to a vault it should never touch, sign its own lie perfectly, and the gate, reading the inner body, would wave it through. The deputy (your Dina) acted on the authority of a claim instead of on the authority of the channel.

The fix is a one-sentence rule that I now apply everywhere: **authorization binds to the authenticated channel, never to a self-asserted claim inside it.** The relay (MsgBox) authenticates each connection per DID. The envelope it stamps, `from_did` and `to_did`, is the thing the gate trusts. The inner body became payload, useful for routing and display, authoritative for nothing. The lesson generalizes well beyond messaging: any time you find yourself authorizing against a value the requester supplied, you have probably built a confused deputy, however good the signature on it looks.

## What this does not solve

The honest limits, because they are the interesting part:

- **The gate stops execution, not bad proposals.** A prompt-injected agent can still propose nonsense all day. The design contains the blast radius (nothing acts without a real approval) but it does not make the model trustworthy, and it should not pretend to. The model is assumed hostile-by-accident; the architecture is what is trusted.
- **Approval fatigue is reduced, not eliminated.** Tiers and session grants keep the common path quiet, but a determined enough agent generating a stream of medium-risk proposals can still wear a user down. The mitigation is product judgment about defaults, and it is genuinely unsolved at the edges.
- **This protects you from agents, not from yourself.** When *you*, the human, drive Dina from the app, you see everything; the gatekeeper exists to constrain external agents and inbound requests, not to second-guess the owner. Conflating the two is how you end up asking a user to approve reading their own notes, which is absurd.
- **Determinism has a cost: the policy table is a maintenance surface.** Every new action type is a row someone has to remember to add, and the fail-safe default is what saves you when they forget. That default is load-bearing, not decoration.

## Why this is the right boundary

The reason to put the gate in code is not that code is fashionable and prompts are not. It is that a security boundary has to be enforced by something that is not the thing being constrained, and that cannot be argued with. A probabilistic model can be the brain. It cannot be the lock. In Dina the brain proposes and the lock decides, the lock is a few dozen lines of boring deterministic TypeScript with a fail-safe default and an audit trail, and you can read every line of it in the source.

That is the whole trick. The interesting engineering is in making the boundary boring.

---

*Dina is open source. The agent gatekeeper described here lives in `packages/core/src/gatekeeper/intent.ts`; the persona gate in `packages/brain/src/ask/persona_gate.ts`. If you work on agent security and want to try to break this, I would genuinely value the critique.*
