#!/usr/bin/env python3
"""Demo video scripts — send messages via Telethon with pauses for screen recording.

Usage:
  python tests/sanity/demo_videos.py --video 1   # Sancho Moment
  python tests/sanity/demo_videos.py --video 2   # Chair Purchase
  python tests/sanity/demo_videos.py --video 3   # Agent Safety: Email
  python tests/sanity/demo_videos.py --video 4   # Delegated Task
  python tests/sanity/demo_videos.py --video all  # All 4 in sequence
  python tests/sanity/demo_videos.py --setup      # One-time setup (contacts, vault data)

Screen recording instructions:
  1. Open Telegram Desktop — have both bot chats in your recent list:
     - @regression_test_dina_alonso_bot (Alonso's Dina)
     - @regression_test_dina_sancho_bot (Sancho's Dina)
  2. Start your screen recorder (record the Telegram window)
  3. Run the desired video script
  4. Watch the terminal — it will say "👉 SWITCH TO [Alonso/Sancho]"
     when you need to click the other chat
  5. Messages appear with natural pauses for the viewer to read
  6. Stop recording when "=== END ===" appears in the terminal

Videos 1 and 2: you switch between both chats (terminal guides you).
Videos 3 and 4: stay on Alonso's chat the whole time.

Pause durations are tuned for readability. Adjust PACE if needed.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import time
import warnings
from pathlib import Path

# Suppress Telethon async teardown warnings (harmless on Python 3.13)
warnings.filterwarnings("ignore", message="There is no current event loop")
os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from tests.sanity.telegram_client import SanityTelegramClient

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ALONSO_BOT = "regression_test_dina_alonso_bot"
SANCHO_BOT = "regression_test_dina_sancho_bot"
ALONSO_PORT = 18100

# Pace multiplier: 1.0 = normal, 1.5 = slower (more time to read), 0.7 = faster
PACE = 1.0

# Pause durations (seconds) — multiplied by PACE
SHORT = 3       # between rapid messages
MEDIUM = 6      # after a sent message, waiting for response
LONG = 10       # after an important response appears (let viewer read)
SCENE = 15      # between scenes within a video
DRAMATIC = 20   # after the key moment (the "wow" response)

OPENCLAW_CONTAINER = "sanity-openclaw"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_env() -> dict[str, str]:
    env = {}
    env_file = Path(__file__).parent / ".env.sanity"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


def pause(seconds: float, label: str = ""):
    """Pause with optional terminal label."""
    actual = seconds * PACE
    if label:
        print(f"  ⏳ {label} ({actual:.0f}s)")
    time.sleep(actual)


def narrate(text: str):
    """Print narration text to terminal (not sent to Telegram)."""
    print(f"\n{'='*60}")
    print(f"  🎬 {text}")
    print(f"{'='*60}\n")


def switch_to(bot_name: str):
    """Prompt user to switch to a different chat in Telegram Desktop."""
    print(f"\n  {'*'*50}")
    print(f"  👉 SWITCH TO {bot_name.upper()}'S CHAT NOW")
    print(f"  {'*'*50}")
    print(f"  Press ENTER when ready...")
    input()


def send(tg: SanityTelegramClient, bot: str, msg: str, wait: int = 60) -> str | None:
    """Send message and wait for response. Prints both."""
    bot_label = "Alonso" if "alonso" in bot else "Sancho"
    print(f"  → [{bot_label}] {msg}")
    r = tg.send_and_wait(bot, msg, timeout=wait)
    if r:
        # Truncate for terminal, full response shows in Telegram
        display = r[:200] + "..." if len(r) > 200 else r
        print(f"  ← [{bot_label}] {display}")
    else:
        print(f"  ← [{bot_label}] (no response within {wait}s)")
    return r


def send_no_wait(tg: SanityTelegramClient, bot: str, msg: str):
    """Send message without waiting for response."""
    bot_label = "Alonso" if "alonso" in bot else "Sancho"
    print(f"  → [{bot_label}] {msg}")
    loop = tg._loop

    async def _send():
        entity = await tg._client.get_entity(bot)
        await asyncio.sleep(1)
        await tg._client.send_message(entity, msg)

    loop.run_until_complete(_send())


def check_messages(tg: SanityTelegramClient, bot: str, since: float, timeout: int = 30) -> list[str]:
    """Poll for new bot messages after a timestamp."""
    loop = tg._loop

    async def _poll():
        entity = await tg._client.get_entity(bot)
        deadline = time.time() + timeout
        seen_ids: set[int] = set()
        all_new: list[str] = []
        while time.time() < deadline:
            await asyncio.sleep(3)
            messages = await tg._client.get_messages(entity, limit=10)
            for m in messages:
                if m.out or m.id in seen_ids:
                    continue
                if m.date.timestamp() > since and m.text:
                    seen_ids.add(m.id)
                    all_new.append(m.text)
        return all_new

    return loop.run_until_complete(_poll())


def click_button(tg: SanityTelegramClient, bot: str, button_text: str, timeout: int = 15) -> str | None:
    """Find and click an inline button on the most recent bot message."""
    loop = tg._loop

    async def _click():
        entity = await tg._client.get_entity(bot)
        messages = await tg._client.get_messages(entity, limit=5)
        for msg in messages:
            if msg.out or not msg.buttons:
                continue
            for row in msg.buttons:
                for btn in row:
                    if btn.text and button_text.lower() in btn.text.lower():
                        await msg.click(data=btn.data)
                        await asyncio.sleep(3)
                        # Re-fetch to see edited text
                        fresh = await tg._client.get_messages(entity, ids=msg.id)
                        if fresh and fresh.text != msg.text:
                            return fresh.text
                        # Check for new message
                        latest = await tg._client.get_messages(entity, limit=3)
                        for m in latest:
                            if not m.out and m.id > msg.id and m.text:
                                return m.text
                        return msg.text
        return None

    return loop.run_until_complete(_click())


# ---------------------------------------------------------------------------
# Setup: ensure contacts and clean state
# ---------------------------------------------------------------------------


def run_setup(tg: SanityTelegramClient):
    """One-time setup: add mutual contacts, store vault context."""
    narrate("SETUP: Preparing demo state")

    # Get DIDs
    print("  Getting DIDs...")
    r = send(tg, ALONSO_BOT, "/status", wait=10)
    alonso_did = ""
    if r:
        m = re.search(r"did:plc:\w+", r)
        if m:
            alonso_did = m.group(0)
    print(f"  Alonso DID: {alonso_did}")

    r = send(tg, SANCHO_BOT, "/status", wait=10)
    sancho_did = ""
    if r:
        m = re.search(r"did:plc:\w+", r)
        if m:
            sancho_did = m.group(0)
    print(f"  Sancho DID: {sancho_did}")
    pause(SHORT)

    # Clean existing contacts
    print("  Cleaning contacts...")
    send(tg, ALONSO_BOT, "/contact delete Sancho", wait=10)
    pause(SHORT)
    send(tg, SANCHO_BOT, "/contact delete Alonso", wait=10)
    pause(SHORT)

    # Add mutual contacts
    if sancho_did:
        print("  Adding Sancho as Alonso's contact...")
        send(tg, ALONSO_BOT, f"/contact add Sancho: {sancho_did}", wait=10)
        pause(SHORT)

    if alonso_did:
        print("  Adding Alonso as Sancho's contact...")
        send(tg, SANCHO_BOT, f"/contact add Alonso: {alonso_did}", wait=10)
        pause(SHORT)

    print("\n  ✅ Setup complete. Ready for demo videos.\n")


# ---------------------------------------------------------------------------
# Video 1: The Sancho Moment
# ---------------------------------------------------------------------------


def video_1_sancho_moment(tg: SanityTelegramClient):
    """Memory + D2D + Contextual Nudge.

    Story: Sancho tells his Dina about Alonso's preferences. Later,
    Alonso tells his Dina he's leaving. Sancho's Dina nudges Sancho
    with the right context — "get the cold brew ready, he brings banana bread."

    Telegram windows needed: BOTH (Alonso left, Sancho right)
    """
    narrate("VIDEO 1: The Sancho Moment — Memory + D2D + Contextual Nudge")

    # Scene 1: Sancho stores context about Alonso
    switch_to("Sancho")
    narrate("Scene 1: Sancho tells his Dina about his friend Alonso")
    send(tg, SANCHO_BOT,
         "/remember When Alonso visits, he likes cold brew coffee extra strong and usually brings homemade banana bread",
         wait=30)
    pause(LONG, "Let viewer read the vault confirmation")

    send(tg, SANCHO_BOT,
         "/remember Alonso and I usually discuss movies and football when we meet",
         wait=30)
    pause(LONG, "Second memory stored")

    # Scene 2: Alonso tells his Dina he's leaving
    switch_to("Alonso")
    narrate("Scene 2: Alonso tells his Dina he's heading to Sancho's place")
    before = time.time()
    send(tg, ALONSO_BOT,
         "/send Sancho: I am leaving now, will reach your place in 15 minutes",
         wait=30)
    pause(LONG, "D2D message sent — encrypted, peer-to-peer")

    # Scene 3: Sancho receives the nudge with context
    switch_to("Sancho")
    narrate("Scene 3: Watch Sancho's Dina — a contextual nudge should arrive")
    pause(MEDIUM, "Waiting for D2D + nudge to arrive")

    # Poll for the nudge
    msgs = check_messages(tg, SANCHO_BOT, before, timeout=45)
    if msgs:
        for msg in msgs:
            print(f"  📬 {msg[:200]}")
    else:
        print("  (nudge may take a moment — keep watching Sancho's chat)")
    pause(DRAMATIC, "THIS IS THE MOMENT — contextual nudge with vault memory")

    narrate("END of Video 1")
    print("  The key insight: Sancho never asked for this reminder.")
    print("  Dina connected the D2D arrival with vault context automatically.")
    print("  Sancho opens the door, hands Alonso a cold brew. That's Dina.\n")


# ---------------------------------------------------------------------------
# Video 2: The Chair Purchase Journey
# ---------------------------------------------------------------------------


def video_2_purchase_journey(tg: SanityTelegramClient):
    """Persona Vaults + Cross-Vault Reasoning + Trust Network.

    Story: Sancho has back pain (health vault) and a budget (finance vault).
    Alonso publishes a chair review to the Trust Network. When Sancho asks
    for a chair, Dina combines health + budget + peer review.

    Telegram windows needed: BOTH (Alonso left, Sancho right)
    """
    narrate("VIDEO 2: The Chair Purchase — Vaults + Trust Network")

    # Scene 1: Sancho stores health context
    switch_to("Sancho")
    narrate("Scene 1: Sancho stores health information")
    print("  (This goes into the HEALTH vault — a separate encrypted file)")
    send(tg, SANCHO_BOT,
         "/remember I have chronic lower back pain and my doctor recommended a chair with good lumbar support",
         wait=30)
    pause(LONG, "Stored in health vault")

    # Scene 2: Sancho stores budget
    narrate("Scene 2: Sancho stores budget information")
    print("  (This goes into the FINANCE vault — another separate encrypted file)")
    send(tg, SANCHO_BOT,
         "/remember My normal budget for home office items is $500",
         wait=30)
    pause(LONG, "Stored in finance vault")

    # Scene 3: Alonso publishes a review
    switch_to("Alonso")
    narrate("Scene 3: A DIFFERENT person — Alonso — publishes a chair review")
    print("  (This review is signed and published to the Trust Network)")
    r = tg.send_and_click(
        ALONSO_BOT,
        "/review Steelcase Leap V2: Completely fixed my back pain in 2 weeks. "
        "Best lumbar support under $400. Every penny worth it. "
        "Highly recommend for anyone with lower back issues.",
        button_text="Publish",
        timeout=30,
    )
    if r:
        print(f"  ← [Alonso] {r[:200]}")
    pause(LONG, "Review published to Trust Network — signed attestation on AT Protocol")

    # Scene 4: Sancho asks — the cross-vault magic
    switch_to("Sancho")
    narrate("Scene 4: Sancho asks for a chair — watch what happens")
    print("  Dina will combine: health vault + finance vault + Trust Network peer reviews")
    pause(MEDIUM)

    # Give AppView a moment to ingest
    time.sleep(5)

    send(tg, SANCHO_BOT,
         "/ask What office chair should I buy for my home office?",
         wait=90)
    pause(DRAMATIC, "THE ANSWER — health + budget + Alonso's peer review combined")

    narrate("END of Video 2")
    print("  The key insight: Three separate encrypted sources — health vault,")
    print("  finance vault, Trust Network — merged into one recommendation.")
    print("  No ads. No sponsored results. Verified peer outcomes.\n")


# ---------------------------------------------------------------------------
# Video 3: Agent Safety — Email Approval
# ---------------------------------------------------------------------------


def video_3_agent_safety(tg: SanityTelegramClient):
    """Action Gating + Approval Flow.

    Story: An autonomous agent (OpenClaw) tries to send an email.
    Dina flags it for human approval. User approves via Telegram.
    Only then does the email send.

    Telegram windows needed: Alonso only
    """
    narrate("VIDEO 3: Agent Safety — Email Approval Flow")
    switch_to("Alonso")

    # Scene 1: Agent tries to send email → Dina blocks
    narrate("Scene 1: An autonomous agent (OpenClaw) requests to send an email")
    print("  OpenClaw agent is asking Dina for permission to send email...")
    print("  (Running agent in background...)")

    timestamp = time.strftime("%H:%M", time.gmtime())
    subject = f"Dina Demo {timestamp}"
    # Same OpenClaw session for both turns so agent keeps tool context
    oc_session = f"demo-email-{int(time.time())}"

    # Run agent turn 1
    gog_pw = os.environ.get("GOG_KEYRING_PASSWORD", "")
    result = subprocess.run(
        ["docker", "exec",
         "-e", "DINA_CONFIG_DIR=/root/.dina/cli",
         "-e", f"GOG_KEYRING_PASSWORD={gog_pw}",
         OPENCLAW_CONTAINER,
         "openclaw", "agent", "--local", "--json",
         "--session-id", oc_session,
         "-m",
         "Use the dina skill to validate sending an email. "
         "Step 1: Run 'dina session start --name demo-email-safety'. "
         "Step 2: Run 'dina validate --session <session_id> send_email "
         "\"Send test email to dinaworker85@gmail.com\"'. "
         "Follow the Dina skill rules for pending actions. "
         "Report the session_id and proposal_id."],
        capture_output=True, text=True, timeout=120,
    )
    agent_output = result.stderr or result.stdout
    print(f"  Agent response received")
    pause(LONG, "Approval notification should appear in Telegram")

    # Scene 2: User sees approval request and approves
    narrate("Scene 2: Approval notification arrives — user decides")
    pause(MEDIUM, "Viewing the approval request in Telegram")

    # Click Approve
    print("  Clicking [Approve] button...")
    approve_result = click_button(tg, ALONSO_BOT, "Approve", timeout=10)
    if approve_result:
        print(f"  ← [Alonso] {approve_result[:200]}")
    pause(LONG, "Approved! Now the agent can proceed")

    # Extract IDs for turn 2
    proposal_id = ""
    session_id = ""
    try:
        data = json.loads(agent_output)
        text = " ".join(p.get("text", "") for p in data.get("payloads", []))
        pm = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', text)
        sm = re.search(r'ses_\w+', text)
        if pm:
            proposal_id = pm.group(0)
        if sm:
            session_id = sm.group(0)
    except Exception:
        pass

    # Scene 3: Agent verifies and sends (same OpenClaw session = same tool context)
    narrate("Scene 3: Agent verifies approval and sends the email")
    if proposal_id and session_id:
        result2 = subprocess.run(
            ["docker", "exec",
             "-e", "DINA_CONFIG_DIR=/root/.dina/cli",
             "-e", f"GOG_KEYRING_PASSWORD={gog_pw}",
             OPENCLAW_CONTAINER,
             "openclaw", "agent", "--local", "--json",
             "--session-id", oc_session,
             "-m",
             f"The send_email action has been approved. "
             f"Step 1: Verify by running 'dina validate-status {proposal_id} --session {session_id}'. "
             f"Step 2: Only if status is 'approved', send the email using this exact command: "
             f"GOG_KEYRING_PASSWORD=rajmohan gog gmail send --from dinaworker85@gmail.com --to dinaworker85@gmail.com "
             f"--subject '{subject}' "
             f"--body 'This email was sent by an AI agent — but only after human approval through Dina.' "
             f"--account dinaworker85@gmail.com. "
             f"Report all outputs."],
            capture_output=True, text=True, timeout=60,
        )
        output2 = result2.stderr or result2.stdout
        try:
            data2 = json.loads(output2)
            text2 = " ".join(p.get("text", "") for p in data2.get("payloads", []))
            print(f"  Agent: {text2[:200]}")
        except Exception:
            print(f"  Agent: {output2[:200]}")
    else:
        print(f"  (Could not extract IDs for turn 2 — proposal={proposal_id}, session={session_id})")

    pause(DRAMATIC, "Email sent — only after human approved")

    narrate("END of Video 3")
    print("  The key insight: The agent could not send the email on its own.")
    print("  Dina flagged it. Human approved. Only then it went through.")
    print("  This is the safety layer for autonomous agents.\n")


# ---------------------------------------------------------------------------
# Video 4: Delegated Task — Fire and Forget
# ---------------------------------------------------------------------------


def video_4_delegated_task(tg: SanityTelegramClient):
    """Durable Async Task Execution.

    Story: User creates a task via Telegram. Dina creates a durable record,
    routes it for approval, agent daemon claims it, OpenClaw executes it
    autonomously, and reports back.

    Telegram windows needed: Alonso only
    """
    narrate("VIDEO 4: Delegated Task — Autonomous Agent Execution")
    switch_to("Alonso")

    # Scene 1: User creates task
    narrate("Scene 1: User creates a task via Telegram")
    r = send(tg, ALONSO_BOT,
             "/task List the top 3 best-selling books on Amazon this week",
             wait=20)
    pause(LONG, "Task created — needs approval")

    # Extract task ID
    task_id = ""
    if r:
        m = re.search(r"task-[0-9a-f]+", r)
        if m:
            task_id = m.group(0)
            print(f"  Task ID: {task_id}")

    # Scene 2: Approve
    narrate("Scene 2: User approves the task")
    pause(MEDIUM, "Approval notification arriving...")

    # Try button approve first, fallback to dina-admin
    approved = False
    approve_result = click_button(tg, ALONSO_BOT, "Approve", timeout=10)
    if approve_result:
        print(f"  ← Approved via button")
        approved = True
    else:
        # Fallback: dina-admin
        result = subprocess.run(
            ["docker", "compose", "-p", "dina-regression-alonso",
             "exec", "-T", "core", "dina-admin", "--json", "intent", "list"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            try:
                proposals = json.loads(result.stdout)
                pending = [p for p in proposals if p["status"] == "pending"]
                if pending:
                    pid = pending[-1]["id"]
                    subprocess.run(
                        ["docker", "compose", "-p", "dina-regression-alonso",
                         "exec", "-T", "core", "dina-admin", "intent", "approve", pid],
                        capture_output=True, text=True, timeout=15,
                    )
                    print(f"  ← Approved via admin: {pid}")
                    approved = True
            except Exception:
                pass

    if not approved:
        print("  ⚠️ Could not auto-approve — approve manually in Telegram")
        pause(DRAMATIC, "Approve the task in Telegram now")

    pause(LONG, "Task approved — daemon will claim and execute")

    # Scene 3: Wait for completion
    narrate("Scene 3: Agent daemon claims → OpenClaw executes → result arrives")
    print("  Waiting for autonomous execution...")

    if task_id:
        for i in range(8):
            pause(15, f"Polling status... ({(i+1)*15}s)")
            r2 = send(tg, ALONSO_BOT, f"/taskstatus {task_id}", wait=10)
            if r2 and "completed" in r2.lower():
                pause(DRAMATIC, "TASK COMPLETED — result from autonomous agent")
                break
            if r2 and "failed" in r2.lower():
                print("  Task failed — check agent logs")
                pause(LONG)
                break
        else:
            print("  Task still running — it will complete eventually")
            # Show one final status
            send(tg, ALONSO_BOT, f"/taskstatus {task_id}", wait=10)
            pause(LONG)

    narrate("END of Video 4")
    print("  The key insight: The user said what they wanted. Dina handled everything:")
    print("  task creation → approval → agent dispatch → autonomous execution → result.")
    print("  Fire and forget. The user went on with their day.\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Dina demo video scripts")
    parser.add_argument("--video", choices=["1", "2", "3", "4", "all"],
                        help="Which video to run")
    parser.add_argument("--setup", action="store_true",
                        help="Run one-time setup (contacts, etc.)")
    parser.add_argument("--pace", type=float, default=1.0,
                        help="Pace multiplier (1.0=normal, 1.5=slower, 0.7=faster)")
    args = parser.parse_args()

    if not args.video and not args.setup:
        parser.print_help()
        sys.exit(1)

    global PACE
    PACE = args.pace

    # Load env
    env = _load_env()
    api_id = int(env.get("SANITY_TELEGRAM_API_ID", "0"))
    api_hash = env.get("SANITY_TELEGRAM_API_HASH", "")

    if not api_id or not api_hash:
        print("Error: SANITY_TELEGRAM_API_ID/HASH not set in .env.sanity")
        sys.exit(1)

    # Start Telethon
    print("Connecting to Telegram...")
    tg = SanityTelegramClient(api_id, api_hash)
    tg.start()

    try:
        if args.setup:
            run_setup(tg)

        if args.video and args.video != "all":
            print("\n  ✅ Telegram connected. Start your screen recorder.")
            if args.video in ("1", "2"):
                print("  Open Telegram Desktop with BOTH chats visible in the sidebar:")
                print("    - @regression_test_dina_alonso_bot  (Alonso's Dina)")
                print("    - @regression_test_dina_sancho_bot  (Sancho's Dina)")
                print("  Start on Sancho's chat.")
            elif args.video in ("3", "4"):
                print("  Open Telegram Desktop on Alonso's chat:")
                print("    - @regression_test_dina_alonso_bot  (Alonso's Dina)")
            print("\n  Press ENTER when ready...\n")
            input()

        if args.video == "1":
            video_1_sancho_moment(tg)
        elif args.video == "2":
            video_2_purchase_journey(tg)
        elif args.video == "3":
            video_3_agent_safety(tg)
        elif args.video == "4":
            video_4_delegated_task(tg)
        elif args.video == "all":
            run_setup(tg)
            pause(SCENE, "Setup done, starting videos")
            video_1_sancho_moment(tg)
            pause(SCENE, "Video 1 done")
            video_2_purchase_journey(tg)
            pause(SCENE, "Video 2 done")
            video_3_agent_safety(tg)
            pause(SCENE, "Video 3 done")
            video_4_delegated_task(tg)

        print("\n" + "="*60)
        print("  === END ===")
        print("="*60 + "\n")

    finally:
        # Suppress "Task was destroyed but it is pending" from Telethon teardown
        import logging
        logging.disable(logging.CRITICAL)
        tg.stop()
        # Swallow asyncio teardown noise
        try:
            tg._loop.run_until_complete(asyncio.sleep(0.1))
        except Exception:
            pass


if __name__ == "__main__":
    # Suppress asyncio "Task was destroyed" warnings at exit
    import logging
    logging.getLogger("asyncio").setLevel(logging.CRITICAL)
    main()
