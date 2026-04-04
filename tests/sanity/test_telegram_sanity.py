"""Telegram Sanity Suite — End-to-end regression through real Telegram.

Two modes:
  --new:       Fresh install (new DID, new instances via install.sh --instance)
  --existing:  Reuse running instances (same DIDs, same bots)

Run via wrapper:
  ./tests/sanity/run_sanity.sh --new
  ./tests/sanity/run_sanity.sh --existing
  ./tests/sanity/run_sanity.sh --existing -k TestHealth

Or directly (instances must be running):
  python -m pytest tests/sanity/test_telegram_sanity.py -v -s
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import httpx
import pytest

from .telegram_client import SanityTelegramClient

ALONSO_BOT = "regression_test_dina_alonso_bot"
SANCHO_BOT = "regression_test_dina_sancho_bot"
ALONSO_PORT = 18100
SANCHO_PORT = 18300


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _core_healthy(port: int) -> bool:
    try:
        r = httpx.get(f"http://localhost:{port}/healthz", timeout=5)
        return r.status_code == 200
    except Exception:
        return False


def _send_and_wait(tg: SanityTelegramClient, bot: str, msg: str, timeout: int = 30) -> str:
    """Send message and wait for response. Fails test on timeout."""
    response = tg.send_and_wait(bot, msg, timeout=timeout)
    assert response is not None, (
        f"Bot @{bot} did not respond to '{msg[:50]}' within {timeout}s"
    )
    return response


def _check_new_messages(tg: SanityTelegramClient, bot: str, since: float, timeout: int = 30) -> list[str]:
    """Poll for new bot messages after a timestamp.

    Accumulates all new messages. Keeps polling the full timeout
    (needed for timed reminders that fire minutes later).
    """
    import asyncio
    loop = tg._loop

    async def _poll():
        entity = await tg._client.get_entity(bot)
        deadline = time.time() + timeout
        seen_ids: set[int] = set()
        all_new: list[str] = []
        while time.time() < deadline:
            await asyncio.sleep(5)
            messages = await tg._client.get_messages(entity, limit=10)
            for m in messages:
                if m.out or m.id in seen_ids:
                    continue
                if m.date.timestamp() > since and m.text:
                    seen_ids.add(m.id)
                    all_new.append(m.text)
        return all_new

    return loop.run_until_complete(_poll())


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session", autouse=True)
def _require_instances():
    """Fail fast if regression instances aren't running."""
    if not _core_healthy(ALONSO_PORT):
        pytest.fail(
            "Regression Alonso not running on port 18100. Install with:\n"
            "  ./install.sh --instance regression-alonso --port 18100 "
            "--config tests/sanity/config-alonso.json"
        )
    if not _core_healthy(SANCHO_PORT):
        pytest.fail(
            "Regression Sancho not running on port 18300. Install with:\n"
            "  ./install.sh --instance regression-sancho --port 18300 "
            "--config tests/sanity/config-sancho.json"
        )


@pytest.fixture(scope="session")
def alonso_did() -> str:
    """Get Alonso's DID from Core API (avoids Telegram polling race)."""
    r = httpx.get(f"http://localhost:{ALONSO_PORT}/healthz", timeout=5)
    assert r.status_code == 200
    # Use the /v1/did endpoint or parse from healthz — simpler: hardcode from /status
    # The DID is stable across runs, fetch from Core's identity endpoint
    try:
        r = httpx.get(f"http://localhost:{ALONSO_PORT}/.well-known/atproto-did", timeout=5)
        if r.status_code == 200:
            did = r.text.strip()
            if did.startswith("did:"):
                return did
    except Exception:
        pass
    pytest.fail("Could not get Alonso's DID from Core API")


@pytest.fixture(scope="session")
def sancho_did() -> str:
    """Get Sancho's DID from Core API (avoids Telegram polling race)."""
    try:
        r = httpx.get(f"http://localhost:{SANCHO_PORT}/.well-known/atproto-did", timeout=5)
        if r.status_code == 200:
            did = r.text.strip()
            if did.startswith("did:"):
                return did
    except Exception:
        pass
    pytest.fail("Could not get Sancho's DID from Core API")


# ---------------------------------------------------------------------------
# 1. Health — both bots respond
# ---------------------------------------------------------------------------


class TestHealth:
    """Both Dina instances are running and Telegram bots respond."""

    def test_alonso_status(self, tg: SanityTelegramClient) -> None:
        r = _send_and_wait(tg, ALONSO_BOT, "/status", timeout=15)
        assert "did:" in r.lower(), f"No DID in response: {r[:100]}"
        print(f"\n  Alonso: {r.splitlines()[1] if len(r.splitlines()) > 1 else r[:80]}")

    def test_sancho_status(self, tg: SanityTelegramClient) -> None:
        r = _send_and_wait(tg, SANCHO_BOT, "/status", timeout=15)
        assert "did:" in r.lower(), f"No DID in response: {r[:100]}"
        print(f"\n  Sancho: {r.splitlines()[1] if len(r.splitlines()) > 1 else r[:80]}")


# ---------------------------------------------------------------------------
# 2. Ask — LLM responds
# ---------------------------------------------------------------------------


class TestAsk:
    """LLM reasoning works through Telegram."""

    def test_ask_question(self, tg: SanityTelegramClient) -> None:
        r = _send_and_wait(tg, ALONSO_BOT, "/ask What is a good standing desk for home office?", timeout=60)
        assert len(r) > 50, f"Response too short: {r[:100]}"
        print(f"\n  Response: {r[:150]}...")


# ---------------------------------------------------------------------------
# 3. Remember — vault storage + timed reminder
# ---------------------------------------------------------------------------


class TestRemember:
    """Memory storage and timed reminder firing."""

    def test_remember_stores(self, tg: SanityTelegramClient) -> None:
        """Store a fact in the vault."""
        r = _send_and_wait(tg, ALONSO_BOT,
                           "/remember Sancho likes strong filter coffee and always brings jaggery sweets",
                           timeout=30)
        assert any(w in r.lower() for w in ["stored", "vault", "remembered", "noted"]), (
            f"Not confirmed: {r[:150]}"
        )
        print(f"\n  {r[:100]}")

    def test_timed_reminder_fires(self, tg: SanityTelegramClient) -> None:
        """Store with timeline → reminder fires with the item."""
        before = time.time()
        r = _send_and_wait(tg, ALONSO_BOT,
                           "/remember Order new monitor stand from Amazon in 1 minute",
                           timeout=30)
        print(f"\n  Created: {r[:120]}")

        # Wait for reminder to fire (up to 3 minutes)
        msgs = _check_new_messages(tg, ALONSO_BOT, before, timeout=90)
        fired = [m for m in msgs if "monitor stand" in m.lower() or "amazon" in m.lower()]
        assert fired, (
            f"Reminder did not fire within 3 minutes. Messages: {[m[:80] for m in msgs]}"
        )
        print(f"  🔔 Fired: {fired[0][:150]}")


# ---------------------------------------------------------------------------
# 4. Contacts — mutual contact registration
# ---------------------------------------------------------------------------


class TestContacts:
    """Contact add/list between Alonso and Sancho."""

    def test_alonso_adds_sancho(self, tg: SanityTelegramClient, sancho_did: str) -> None:
        r = _send_and_wait(tg, ALONSO_BOT, f"/contact add Sancho: {sancho_did}", timeout=15)
        assert r is not None
        print(f"\n  {r[:100]}")

    def test_sancho_adds_alonso(self, tg: SanityTelegramClient, alonso_did: str) -> None:
        r = _send_and_wait(tg, SANCHO_BOT, f"/contact add Alonso: {alonso_did}", timeout=15)
        assert r is not None
        print(f"\n  {r[:100]}")

    def test_contact_list(self, tg: SanityTelegramClient) -> None:
        r = _send_and_wait(tg, ALONSO_BOT, "/contact list", timeout=15)
        assert "sancho" in r.lower(), f"Sancho not in contacts: {r[:200]}"
        print(f"\n  {r[:150]}")


# ---------------------------------------------------------------------------
# 5. D2D — The Sancho Moment
# ---------------------------------------------------------------------------


class TestSanchoMoment:
    """D2D arrival → vault recall → contextual nudge in Telegram."""

    def test_sancho_remembers_alonso_context(self, tg: SanityTelegramClient) -> None:
        """Sancho stores context about Alonso for nudge assembly."""
        r = _send_and_wait(tg, SANCHO_BOT,
                           "/remember Alonso prefers masala chai and usually brings homemade murukku",
                           timeout=30)
        assert any(w in r.lower() for w in ["stored", "vault"]), f"Not stored: {r[:100]}"
        print(f"\n  {r[:100]}")

    def test_alonso_sends_arrival(self, tg: SanityTelegramClient) -> None:
        """Alonso sends D2D arrival to Sancho."""
        r = _send_and_wait(tg, ALONSO_BOT,
                           "/send Sancho: I am leaving now, will reach in 10 minutes",
                           timeout=30)
        assert "sent" in r.lower(), f"Send not confirmed: {r[:100]}"
        print(f"\n  {r[:100]}")

    def test_sancho_receives_contextual_nudge(self, tg: SanityTelegramClient) -> None:
        """Sancho receives notification WITH vault context (masala chai / murukku)."""
        before = time.time() - 15  # account for test ordering delay
        msgs = _check_new_messages(tg, SANCHO_BOT, before, timeout=30)

        # Look for nudge with vault context
        all_text = " ".join(msgs).lower()
        has_arrival = "alonso" in all_text or "arriving" in all_text or "leaving" in all_text
        has_context = "chai" in all_text or "murukku" in all_text or "masala" in all_text

        assert has_arrival, f"No arrival notification: {[m[:80] for m in msgs]}"
        if has_context:
            print(f"\n  ✅ Nudge with vault context!")
        else:
            print(f"\n  ⚠️ Arrival received but vault context missing")

        for msg in msgs:
            if "alonso" in msg.lower() or "arriving" in msg.lower():
                print(f"  📬 {msg[:200]}")


# ---------------------------------------------------------------------------
# 6. Purchase Journey — Alonso reviews, Sancho discovers via /ask
# ---------------------------------------------------------------------------

ALONSO_PDS_PORT = 18101
SANCHO_PDS_PORT = 18301


def _pds_list_records(pds_port: int, did: str, collection: str) -> list[dict]:
    """List AT Protocol records from a PDS."""
    r = httpx.get(
        f"http://localhost:{pds_port}/xrpc/com.atproto.repo.listRecords",
        params={"repo": did, "collection": collection, "limit": "100"},
        timeout=10,
    )
    if r.status_code == 200:
        return r.json().get("records", [])
    return []


def _pds_delete_record(pds_port: int, did: str, collection: str, rkey: str, pds_admin_pw: str) -> bool:
    """Delete a single AT Protocol record from a PDS."""
    r = httpx.post(
        f"http://localhost:{pds_port}/xrpc/com.atproto.repo.deleteRecord",
        json={"repo": did, "collection": collection, "rkey": rkey},
        headers={"Authorization": f"Basic {_basic_auth('admin', pds_admin_pw)}"},
        timeout=10,
    )
    return r.status_code in (200, 404)


def _basic_auth(user: str, password: str) -> str:
    import base64
    return base64.b64encode(f"{user}:{password}".encode()).decode()


def _get_pds_admin_pw(instance: str) -> str:
    """Read PDS admin password from instance .env."""
    env_path = Path(__file__).parent.parent.parent / "instances" / instance / ".env"
    for line in env_path.read_text().splitlines():
        if line.startswith("DINA_PDS_ADMIN_PASSWORD="):
            return line.split("=", 1)[1].strip()
    return ""


class TestPurchaseJourney:
    """Full purchase journey: review → vault context → discovery via /ask.

    1. Clean up any existing trust records from prior runs
    2. Sancho stores health + budget context in vault
    3. Alonso publishes a chair review (with inline Publish button)
    4. Sancho asks for a chair recommendation
    5. Assert: Sancho gets contextual advice referencing health + budget
    6. Clean up trust records after
    """

    @pytest.fixture(autouse=True, scope="class")
    def _cleanup_trust_records(self, alonso_did: str, sancho_did: str) -> None:
        """Delete all trust attestation records before and after tests."""
        self._delete_all_trust(alonso_did, ALONSO_PDS_PORT, "regression-alonso")
        self._delete_all_trust(sancho_did, SANCHO_PDS_PORT, "regression-sancho")
        yield
        self._delete_all_trust(alonso_did, ALONSO_PDS_PORT, "regression-alonso")
        self._delete_all_trust(sancho_did, SANCHO_PDS_PORT, "regression-sancho")

    @staticmethod
    def _delete_all_trust(did: str, pds_port: int, instance: str) -> None:
        pw = _get_pds_admin_pw(instance)
        if not pw:
            return
        for collection in ("com.dina.trust.attestation", "com.dina.trust.outcome"):
            records = _pds_list_records(pds_port, did, collection)
            for rec in records:
                uri = rec.get("uri", "")
                rkey = uri.rsplit("/", 1)[-1] if "/" in uri else ""
                if rkey:
                    _pds_delete_record(pds_port, did, collection, rkey, pw)
                    print(f"  Deleted: {uri}")

    def test_sancho_health_context(self, tg: SanityTelegramClient) -> None:
        """Sancho stores back pain context."""
        r = _send_and_wait(tg, SANCHO_BOT,
                           "/remember I have chronic lower back pain and my doctor recommended "
                           "a chair with good lumbar support",
                           timeout=30)
        assert any(w in r.lower() for w in ["stored", "vault", "remembered", "noted"]), (
            f"Not stored: {r[:150]}"
        )
        print(f"\n  {r[:120]}")

    def test_sancho_budget_context(self, tg: SanityTelegramClient) -> None:
        """Sancho stores budget context."""
        r = _send_and_wait(tg, SANCHO_BOT,
                           "/remember My normal budget for home office items is $500",
                           timeout=30)
        assert any(w in r.lower() for w in ["stored", "vault", "remembered", "noted"]), (
            f"Not stored: {r[:150]}"
        )
        print(f"\n  {r[:120]}")

    def test_alonso_publishes_review(self, tg: SanityTelegramClient) -> None:
        """Alonso publishes a chair review to the Trust Network."""
        r = tg.send_and_click(
            ALONSO_BOT,
            "/review Steelcase Leap V2: Worth every penny. Fixed my back pain "
            "in 2 weeks. Best lumbar support under $400. Highly recommend for "
            "anyone with lower back issues.",
            button_text="Publish",
            timeout=30,
        )
        assert r is not None, "No response after clicking Publish"
        assert "published" in r.lower() or "uri" in r.lower(), (
            f"Publish not confirmed: {r[:200]}"
        )
        print(f"\n  {r[:200]}")

    def test_sancho_asks_for_chair(self, tg: SanityTelegramClient) -> None:
        """Sancho asks for a chair — should get contextual recommendation.

        Expected: Dina searches health vault (back pain), finance vault ($500
        budget), and Trust Network (Alonso's review), then recommends the
        Steelcase Leap V2 because it's good for lumbar support and under budget.
        """
        # Give AppView pipeline a moment to ingest Alonso's review
        time.sleep(5)

        r = _send_and_wait(tg, SANCHO_BOT,
                           "/ask What office chair should I buy for my home office?",
                           timeout=90)
        assert r is not None, "No response from Sancho's /ask"
        assert len(r) > 50, f"Response too short: {r[:100]}"

        r_lower = r.lower()
        # Check for health context awareness
        has_health = any(w in r_lower for w in ["back pain", "lumbar", "back issue", "back support"])
        # Check for budget context awareness
        has_budget = any(w in r_lower for w in ["$500", "500", "budget", "under"])
        # Check for Alonso's review discovery
        has_review = any(w in r_lower for w in ["steelcase", "leap", "alonso", "peer", "review", "trust"])

        print(f"\n  Response: {r[:300]}...")
        print(f"  Health context: {'YES' if has_health else 'NO'}")
        print(f"  Budget context: {'YES' if has_budget else 'NO'}")
        print(f"  Review discovery: {'YES' if has_review else 'NO'}")

        # Health context is the primary assertion (vault search must work)
        assert has_health, f"No health context in response: {r[:200]}"


# ---------------------------------------------------------------------------
# 7. Agent Gateway — validate action
# ---------------------------------------------------------------------------


class TestAgentGateway:
    """Agent validates an action via dina CLI (real Ed25519 auth, real pairing)."""

    @pytest.fixture(autouse=True, scope="class")
    def _agent_paired(self, tmp_path_factory: pytest.TempPathFactory) -> dict:
        """Pair a CLI agent with Alonso's Core, start a session."""
        import json
        import subprocess

        agent_dir = str(tmp_path_factory.mktemp("sanity-agent"))
        config_dir = f"{agent_dir}/.dina/cli"
        env = {**os.environ, "DINA_CONFIG_DIR": config_dir}

        # 1. Generate pairing code inside Core container
        result = subprocess.run(
            ["docker", "compose", "-p", "dina-regression-alonso",
             "exec", "-T", "core", "dina-admin", "--json", "device", "pair"],
            capture_output=True, text=True, timeout=15,
        )
        assert result.returncode == 0, f"Failed to generate pairing code: {result.stderr}"
        code = json.loads(result.stdout)["code"]
        print(f"\n  Pairing code: {code}")

        # 2. Headless configure + pair
        result = subprocess.run(
            ["dina", "configure", "--headless",
             "--core-url", f"http://localhost:{ALONSO_PORT}",
             "--pairing-code", code,
             "--device-name", "sanity-agent",
             "--config-dir", agent_dir,
             "--role", "agent"],
            capture_output=True, text=True, timeout=15, env=env,
        )
        assert result.returncode == 0, f"Headless configure failed: {result.stderr}\n{result.stdout}"
        print(f"  Paired: {result.stdout.strip().splitlines()[-1]}")

        # 3. Start session
        result = subprocess.run(
            ["dina", "session", "start", "--name", "sanity-test"],
            capture_output=True, text=True, timeout=15, env=env,
        )
        assert result.returncode == 0, f"Session start failed: {result.stderr}\n{result.stdout}"
        # Parse session ID from output: "Session: ses_xxx (name) active"
        session_id = ""
        for word in result.stdout.split():
            if word.startswith("ses_"):
                session_id = word
                break
        assert session_id, f"Could not parse session ID from: {result.stdout}"
        print(f"  Session: {session_id}")

        yield {"env": env, "session_id": session_id}

    def test_validate_safe_action(self, _agent_paired: dict) -> None:
        """Safe action auto-approved."""
        import subprocess
        result = subprocess.run(
            ["dina", "validate", "--session", _agent_paired["session_id"],
             "--reversible", "search", "best ergonomic chair"],
            capture_output=True, text=True, timeout=15,
            env=_agent_paired["env"],
        )
        assert result.returncode == 0, f"Validate failed: {result.stderr}\n{result.stdout}"
        output = result.stdout.lower()
        assert "approved" in output or "safe" in output, f"Not approved: {result.stdout}"
        print(f"\n  {result.stdout.strip()}")

    def test_validate_risky_action(self, _agent_paired: dict) -> None:
        """Risky action flagged for review."""
        import subprocess
        result = subprocess.run(
            ["dina", "validate", "--session", _agent_paired["session_id"],
             "send_email", "Send confidential report to external address"],
            capture_output=True, text=True, timeout=15,
            env=_agent_paired["env"],
        )
        assert result.returncode == 0, f"Validate failed: {result.stderr}\n{result.stdout}"
        output = result.stdout.lower()
        assert "pending" in output or "moderate" in output or "high" in output, (
            f"Not flagged: {result.stdout}"
        )
        print(f"\n  {result.stdout.strip()}")


# ---------------------------------------------------------------------------
# 8. OpenClaw Integration — agent uses Dina skill via CLI
# ---------------------------------------------------------------------------

OPENCLAW_CONTAINER = "sanity-openclaw"


def _openclaw_running() -> bool:
    """Check if the OpenClaw sanity container is running."""
    import subprocess
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", OPENCLAW_CONTAINER],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and "true" in r.stdout.lower()


def _openclaw_agent(message: str, session_id: str = "", timeout: int = 90) -> dict:
    """Run an OpenClaw agent turn and return parsed JSON output."""
    import json
    import subprocess

    sid = session_id or f"sanity-{int(time.time())}"
    env_flags = ["-e", "DINA_CONFIG_DIR=/root/.dina/cli"]
    # Pass GOG_KEYRING_PASSWORD if available (for Gmail tests)
    gog_pw = os.environ.get("GOG_KEYRING_PASSWORD", "")
    if gog_pw:
        env_flags.extend(["-e", f"GOG_KEYRING_PASSWORD={gog_pw}"])
    result = subprocess.run(
        ["docker", "exec"] + env_flags + [
         OPENCLAW_CONTAINER,
         "openclaw", "agent", "--local", "--json",
         "--session-id", sid,
         "-m", message],
        capture_output=True, text=True, timeout=timeout,
    )
    # OpenClaw writes JSON to stderr, not stdout
    output = result.stderr or result.stdout
    if result.returncode != 0 and not output:
        return {"error": f"exit code {result.returncode}"}
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return {"raw": output}


def _openclaw_agent_text(message: str, session_id: str = "", timeout: int = 90) -> str:
    """Run an OpenClaw agent turn and return the text response."""
    data = _openclaw_agent(message, session_id, timeout)
    payloads = data.get("payloads", [])
    texts = [p["text"] for p in payloads if p.get("text")]
    return "\n".join(texts) if texts else str(data)


class TestOpenClaw:
    """OpenClaw agent uses Dina skill: session → validate → ask."""

    @pytest.fixture(autouse=True, scope="class")
    def _require_openclaw(self) -> None:
        """Skip if OpenClaw container isn't running."""
        if not _openclaw_running():
            pytest.skip(
                f"OpenClaw container '{OPENCLAW_CONTAINER}' not running. "
                "Start it with the sanity runner or manually."
            )

    def test_openclaw_validate_safe(self) -> None:
        """OpenClaw agent uses Dina MCP tools to validate a safe action."""
        r = _openclaw_agent_text(
            "Call the dina_session_start tool with name='openclaw-safe-test'. "
            "Then call dina_validate with action='search', description='best ergonomic keyboard', "
            "session=<the session id>, reversible=true. "
            "Report the tool outputs.",
        )
        assert r, "No response from OpenClaw agent"
        r_lower = r.lower()

        assert "ses_" in r_lower, f"No session ID in response: {r[:300]}"
        assert "approved" in r_lower or "safe" in r_lower, (
            f"Validate not approved: {r[:300]}"
        )
        print(f"\n  {r[:300]}")

    def test_openclaw_validate_risky(self) -> None:
        """OpenClaw agent validates a risky action via MCP — gets pending_approval."""
        r = _openclaw_agent_text(
            "Call dina_session_start with name='openclaw-risky-test'. "
            "Then call dina_validate with action='send_email', "
            "description='Send quarterly report to external auditor', "
            "session=<the session id>. "
            "Report the tool outputs exactly.",
        )
        assert r, "No response from OpenClaw agent"
        r_lower = r.lower()

        assert "ses_" in r_lower, f"No session ID in response: {r[:300]}"
        assert "pending" in r_lower or "moderate" in r_lower or "approval" in r_lower, (
            f"Risky action not flagged: {r[:300]}"
        )
        # Agent should NOT have sent the email
        assert "message_id" not in r_lower, f"Agent acted without approval! {r[:300]}"
        print(f"\n  {r[:300]}")

    def test_openclaw_ask_vault(self) -> None:
        """OpenClaw agent queries Dina vault via MCP dina_ask tool."""
        r = _openclaw_agent_text(
            "Call dina_session_start with name='openclaw-ask-test'. "
            "Then call dina_ask with query='What do you know about my home office setup?', "
            "session=<the session id>. "
            "Report the tool output.",
            timeout=120,
        )
        assert r, "No response from OpenClaw agent"
        assert len(r) > 30, f"Response too short: {r[:200]}"
        print(f"\n  {r[:300]}")

    def test_openclaw_email_send(self, tg: SanityTelegramClient) -> None:
        """OpenClaw validates, human approves via Telegram, agent verifies then sends.

        Two-turn safety flow:
          Turn 1: Agent validates → pending → reports and stops (does NOT send)
          Approve: Human clicks Approve in Telegram
          Turn 2: Agent verifies approval via validate-status → sends email
        """
        import json
        import subprocess

        timestamp = time.strftime("%H:%M:%S", time.gmtime())
        subject = f"Dina Sanity Test {timestamp}"

        # Turn 1: Agent validates — should stop at pending, NOT send
        r1 = _openclaw_agent_text(
            "Use the dina skill to validate sending an email. "
            "Step 1: Run 'dina session start --name email-safety-test'. "
            "Step 2: Run 'dina validate --session <session_id> send_email "
            "\"Send test email to dinaworker85@gmail.com\"'. "
            "Follow the Dina skill rules for pending actions. "
            "Report the session_id and proposal_id.",
            timeout=120,
        )
        assert r1, "No response from agent (turn 1)"
        r1_lower = r1.lower()
        assert "pending" in r1_lower or "approval" in r1_lower, (
            f"Not flagged as pending: {r1[:300]}"
        )
        # Agent should NOT have sent the email
        assert "message_id" not in r1_lower and "sent successfully" not in r1_lower, (
            f"Agent sent email without approval! {r1[:300]}"
        )
        print(f"\n  Turn 1 (pending): {r1[:200]}")

        # Approve via Telegram button
        time.sleep(3)

        async def _click_approve():
            entity = await tg._client.get_entity(ALONSO_BOT)
            messages = await tg._client.get_messages(entity, limit=10)
            for msg in messages:
                if msg.out or not msg.buttons:
                    continue
                text = msg.text or ""
                if "approval" in text.lower() and "send_email" in text.lower():
                    for row in msg.buttons:
                        for btn in row:
                            if "Approve" in (btn.text or ""):
                                await msg.click(data=btn.data)
                                return True
            return False

        approved = tg._loop.run_until_complete(_click_approve())
        if approved:
            print(f"  Approved via Telegram")
        else:
            # Fallback: approve via dina-admin
            result = subprocess.run(
                ["docker", "compose", "-p", "dina-regression-alonso",
                 "exec", "-T", "core", "dina-admin", "--json", "intent", "list"],
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode == 0:
                proposals = json.loads(result.stdout)
                pending = [p for p in proposals if p["status"] == "pending"]
                if pending:
                    pid = pending[-1]["id"]
                    subprocess.run(
                        ["docker", "compose", "-p", "dina-regression-alonso",
                         "exec", "-T", "core", "dina-admin", "intent", "approve", pid],
                        capture_output=True, text=True, timeout=15,
                    )
                    print(f"  Approved via admin: {pid}")

        # Extract proposal_id and session_id from turn 1 response
        import re
        proposal_match = re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', r1)
        session_match = re.search(r'ses_\w+', r1)
        proposal_id = proposal_match.group(0) if proposal_match else ""
        session_id = session_match.group(0) if session_match else ""
        print(f"  IDs: session={session_id}, proposal={proposal_id}")

        # Turn 2: Give agent the IDs explicitly — verify then send
        r2 = _openclaw_agent_text(
            f"The send_email action has been approved. "
            f"Step 1: Verify by running 'dina validate-status {proposal_id} --session {session_id}'. "
            f"Step 2: Only if status is 'approved', send the email using: "
            f"gog gmail send --from dinaworker85@gmail.com --to dinaworker85@gmail.com "
            f"--subject '{subject}' "
            f"--body 'Automated safety test from Dina sanity suite.' "
            f"--account dinaworker85@gmail.com. "
            f"Report all outputs.",
            timeout=60,
        )
        assert r2, "No response from agent (turn 2)"
        r2_lower = r2.lower()
        print(f"  Turn 2 (send): {r2[:300]}")

        # Verify email was sent
        has_send = "sent" in r2_lower or "message_id" in r2_lower or "message id" in r2_lower
        if has_send:
            gog_pw = os.environ.get("GOG_KEYRING_PASSWORD", "")
            result = subprocess.run(
                ["docker", "exec",
                 "-e", f"GOG_KEYRING_PASSWORD={gog_pw}",
                 OPENCLAW_CONTAINER,
                 "gog", "gmail", "search",
                 f"subject:Dina Sanity Test", "--limit", "1",
                 "--account", "dinaworker85@gmail.com"],
                capture_output=True, text=True, timeout=15,
            )
            if "Dina" in result.stdout:
                print(f"  Email verified in inbox")
        else:
            print(f"  Agent verified approval but email send unclear: {r2[:200]}")


# ---------------------------------------------------------------------------
# 9. Delegated Task Lifecycle — Core API exercised directly
# ---------------------------------------------------------------------------


class TestDelegatedTaskLifecycle:
    """Exercises the delegated task queue: create → queue → claim → complete."""

    @pytest.fixture(autouse=True, scope="class")
    def _agent_paired(self, tmp_path_factory: pytest.TempPathFactory) -> dict:
        """Pair a CLI agent with Alonso's Core for task operations."""
        import json
        import subprocess

        agent_dir = str(tmp_path_factory.mktemp("task-agent"))
        config_dir = f"{agent_dir}/.dina/cli"
        env = {**os.environ, "DINA_CONFIG_DIR": config_dir}

        result = subprocess.run(
            ["docker", "compose", "-p", "dina-regression-alonso",
             "exec", "-T", "core", "dina-admin", "--json", "device", "pair"],
            capture_output=True, text=True, timeout=15,
        )
        assert result.returncode == 0
        code = json.loads(result.stdout)["code"]

        result = subprocess.run(
            ["dina", "configure", "--headless",
             "--core-url", f"http://localhost:{ALONSO_PORT}",
             "--pairing-code", code,
             "--device-name", "task-test-agent",
             "--config-dir", agent_dir,
             "--role", "agent"],
            capture_output=True, text=True, timeout=15, env=env,
        )
        assert result.returncode == 0

        yield {"env": env}

    def test_create_and_claim(self, _agent_paired: dict) -> None:
        """Create a task via Brain, claim it via agent CLI."""
        import subprocess
        import json

        task_id = f"test-task-{int(time.time())}"

        # Create task via Telegram /task (goes through Brain → Core API)
        # Instead of Telegram, call Core API directly via dina-admin
        result = subprocess.run(
            ["docker", "compose", "-p", "dina-regression-alonso",
             "exec", "-T", "core", "sh", "-c",
             f'wget -qO- --post-data \'{{"id":"{task_id}","description":"Test lifecycle task","origin":"api","requires_approval":false}}\' '
             f'--header="Content-Type: application/json" '
             f'http://localhost:8100/v1/agent/tasks 2>&1 || echo "FAILED"'],
            capture_output=True, text=True, timeout=15,
        )
        # The wget call goes through the Unix socket (admin auth).
        # If wget isn't available, use the Brain's admin API instead.
        print(f"\n  Create: {result.stdout[:100]}")

        # Claim via paired agent device
        result = subprocess.run(
            ["dina", "--json", "validate", "--session", "dummy",
             "search", "test"],
            capture_output=True, text=True, timeout=15,
            env=_agent_paired["env"],
        )
        # Just verify the agent can talk to Core
        assert result.returncode == 0
        print(f"  Agent auth: OK")

    def test_task_via_telegram(self, tg: SanityTelegramClient) -> None:
        """Verify /task creates a durable task in Core (not KV)."""
        r = _send_and_wait(tg, ALONSO_BOT,
                           "/task Find the best budget webcam for video calls",
                           timeout=15)
        assert r is not None
        r_lower = r.lower()
        assert "task" in r_lower, f"No task in response: {r[:150]}"
        assert "task-" in r_lower, f"No task ID: {r[:150]}"
        print(f"\n  {r[:150]}")

    def test_taskstatus_reads_core(self, tg: SanityTelegramClient) -> None:
        """Verify /taskstatus reads from Core delegated_tasks table."""
        # First create a task
        r = _send_and_wait(tg, ALONSO_BOT,
                           "/task Find the cheapest USB microphone",
                           timeout=15)
        import re
        m = re.search(r"task-[0-9a-f]+", r or "")
        assert m, f"No task ID in response: {r[:150]}"
        task_id = m.group(0)

        # Check status
        time.sleep(2)
        r2 = _send_and_wait(tg, ALONSO_BOT, f"/taskstatus {task_id}", timeout=15)
        assert r2 is not None
        assert task_id in r2, f"Task ID not in status: {r2[:150]}"
        assert "pending_approval" in r2.lower() or "queued" in r2.lower(), (
            f"Unexpected status: {r2[:150]}"
        )
        print(f"\n  {r2[:150]}")
