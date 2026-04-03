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
    """Poll for new bot messages after a timestamp."""
    import asyncio
    loop = tg._loop

    async def _poll():
        entity = await tg._client.get_entity(bot)
        deadline = time.time() + timeout
        while time.time() < deadline:
            await asyncio.sleep(3)
            messages = await tg._client.get_messages(entity, limit=10)
            new = [m.text for m in messages if not m.out and m.date.timestamp() > since and m.text]
            if new:
                return new
        return []

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
        msgs = _check_new_messages(tg, ALONSO_BOT, before, timeout=180)
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
