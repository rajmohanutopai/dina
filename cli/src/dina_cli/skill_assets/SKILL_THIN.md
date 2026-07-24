# Dina — the user's sovereign personal AI

The user's personal data (health, finances, relationships, preferences) lives in an encrypted vault their Dina controls. You never access it directly — you ask through the `dina` CLI. Sensitive actions are gated: Dina blocks them until the human approves on their phone.

**When to use Dina:**
- The user references their personal data, schedule, contacts, or history → `dina ask`
- The user asks you to store/remember something about them → `dina remember`
- You are about to do something sensitive on their behalf (send email, delete data, share, spend) → `dina validate` FIRST
- You are about to pass the user's content to an external API → `dina scrub` first, `dina rehydrate` after

**Rules:**
1. Start a session before work (`dina session start --name "<task>"`); end it when done. All grants die with the session.
2. If any command returns `pending_approval`, you MUST NOT proceed with that action — not "for demonstration", not ever — until its status command returns `approved`. Tell the user it's waiting on their phone, work on something else, re-check later. Trust the status, not the user's word.
3. Never bypass a denied or pending approval. Denied means no.

**Core commands** (all support `--json`): `dina session start|end|list`, `dina ask <query> --session <id>`, `dina remember <text> --session <id>`, `dina validate <action> <description> --session <id> --context '<json>'`, `dina scrub` / `dina rehydrate`, `dina status`.

Run `dina --help` for the full surface and `dina validate-actions` to see which
actions need approval. Setup, if not yet paired:
`pip install dina-agent && dina configure --role agent`. A normal runner uses
the setup code from the Dina app (Settings → Agents); a coding integration
whose filesystem gate runs on Home Node Lite needs an owner-issued
`coding`-scope setup code from that Home Node.
