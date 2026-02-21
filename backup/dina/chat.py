"""The Voice — Dina's interactive conversational REPL."""

from __future__ import annotations

import json

from dina.agent import chat_agent, verdict_agent
from dina.did_key import derive_did_key, produce_did_document
from dina.identity import DinaIdentity
from dina.memory import VerdictMemory
from dina.providers import providers
from dina.signing import sign_verdict, verify_verdict_signature
from dina.tools import extract_video_id, fetch_youtube_transcript, is_youtube_url
from dina.vault import CeramicVault


def _make_banner(vault: CeramicVault | None = None) -> str:
    """Build the REPL banner with provider info."""
    lines = [
        "  Dina v0.4 — The Memory",
        "  Your skeptical purchasing advisor. Local-first. No ads. No tracking.",
    ]
    for status_line in providers.status_lines:
        lines.append(f"  {status_line}")
    if vault:
        for status_line in vault.status_lines:
            lines.append(f"  {status_line}")
    lines.append("  Paste a YouTube review URL or ask me anything about past verdicts.")
    lines.append(
        "  Commands: /quit  /history  /search <query>  /identity  /verify <video_id>  /vault"
    )
    return "\n".join(lines) + "\n"


def _handle_url(
    url: str,
    memory: VerdictMemory,
    identity: DinaIdentity,
    vault: CeramicVault | None = None,
) -> None:
    """Analyse a YouTube review, sign the verdict, and store it."""
    video_id = extract_video_id(url)

    if providers.can_analyze_video:
        from pydantic_ai import VideoUrl

        print(f"Analysing video natively: {url}")
        video = VideoUrl(url=url)
        result = verdict_agent.run_sync(
            [video, "Analyze this product review video and produce a verdict."],
            model=providers.verdict_model,
        )
    else:
        print(f"Fetching transcript for: {url}")
        transcript = fetch_youtube_transcript(url)
        print(f"Transcript length: {len(transcript)} chars — analysing with Dina...\n")
        result = verdict_agent.run_sync(
            f"Analyse this product review transcript and produce a verdict:\n\n{transcript}",
            model=providers.verdict_model,
        )

    verdict = result.output

    # Sign the verdict
    sig_hex, did = sign_verdict(verdict, identity)
    verdict.signature_hex = sig_hex
    verdict.signer_did = did

    memory.store(verdict, url, video_id)
    print(verdict.model_dump_json(indent=2))
    print(f"\n  Stored in memory. ({memory.count} verdict(s) total)")
    print(f"  Signed by: {did}")

    # Dual-write to Ceramic vault
    if vault:
        stream_id = vault.publish(verdict, video_id, url)
        if stream_id:
            memory.update_stream_id(video_id, stream_id)
            print(f"  Published to Ceramic: {stream_id}")
        elif vault.enabled:
            print("  Warning: Ceramic publish failed — verdict saved locally only.")


def _handle_history(memory: VerdictMemory) -> None:
    """Print the most recent verdicts."""
    items = memory.list_recent(10)
    if not items:
        print("  No verdicts stored yet. Paste a YouTube review URL to get started.")
        return

    for i, item in enumerate(items, 1):
        meta = item["metadata"]
        signed = " [SIGNED]" if meta.get("signature_hex") else ""
        ceramic = " [CERAMIC]" if meta.get("stream_id") else ""
        print(
            f"  {i}. {meta['product_name']} — {meta['verdict']} "
            f"({meta['confidence_score']}/100) — {meta['expert_source']}{signed}{ceramic}"
        )
        print(f"     {meta['youtube_url']}")


def _handle_search(query: str, memory: VerdictMemory) -> None:
    """Semantic search over stored verdicts."""
    results = memory.search(query, n_results=5)
    if not results:
        print("  No results found.")
        return

    for i, item in enumerate(results, 1):
        meta = item["metadata"]
        print(
            f"  {i}. {meta['product_name']} — {meta['verdict']} "
            f"({meta['confidence_score']}/100) — {meta['expert_source']}"
        )
        print(f"     {item['document']}")


def _handle_identity(identity: DinaIdentity) -> None:
    """Print the DID Document for Dina's identity."""
    doc = produce_did_document(identity)
    print(json.dumps(doc.model_dump(by_alias=True), indent=2))


def _handle_verify(video_id: str, memory: VerdictMemory, identity: DinaIdentity) -> None:
    """Verify the Ed25519 signature on a stored verdict."""
    item = memory.get_by_video_id(video_id)
    if not item:
        print(f"  No verdict found for video ID: {video_id}")
        return

    meta = item["metadata"]
    sig_hex = meta.get("signature_hex")
    signer_did = meta.get("signer_did")

    if not sig_hex:
        print("  This verdict was stored before signing was enabled (no signature).")
        return

    canonical_json = meta.get("verdict_canonical")
    if not canonical_json:
        print("  Cannot verify: canonical JSON not stored (legacy verdict).")
        return

    try:
        valid = verify_verdict_signature(canonical_json, sig_hex, identity)
        if valid:
            print(f"  VERIFIED: Signature is valid. Signer: {signer_did}")
        else:
            print(f"  INVALID: Signature verification failed! Claimed signer: {signer_did}")
    except Exception as e:
        print(f"  Verification error: {e}")


def _handle_vault(vault: CeramicVault | None) -> None:
    """Print vault status."""
    if vault is None or not vault.enabled:
        print("  Vault: disabled (set DINA_CERAMIC_URL to enable)")
        return
    for line in vault.status_lines:
        print(f"  {line}")


def _handle_chat(query: str, memory: VerdictMemory) -> None:
    """RAG query — search memory for context, then ask the chat agent."""
    context_items = memory.search(query, n_results=5)

    if context_items:
        context_block = "\n".join(
            f"- {item['document']}" for item in context_items
        )
        prompt = (
            f"User question: {query}\n\n"
            f"Relevant verdicts from your memory:\n{context_block}"
        )
    else:
        prompt = (
            f"User question: {query}\n\n"
            f"You have no stored verdicts yet. Let the user know."
        )

    result = chat_agent.run_sync(prompt, model=providers.chat_model)
    print(f"\n  {result.output}\n")


def repl() -> None:
    """Launch the Dina interactive REPL."""
    identity = DinaIdentity()
    memory = VerdictMemory()
    vault = CeramicVault(identity)
    did = derive_did_key(identity)

    print(_make_banner(vault))
    print(f"  Identity: {did}\n")

    while True:
        try:
            user_input = input("dina> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n  Goodbye.")
            break

        if not user_input:
            continue

        # --- Command routing ---
        if user_input.startswith("/"):
            cmd = user_input.split(maxsplit=1)
            command = cmd[0].lower()

            if command == "/quit":
                print("  Goodbye.")
                break
            elif command == "/history":
                _handle_history(memory)
            elif command == "/search":
                if len(cmd) < 2:
                    print("  Usage: /search <query>")
                else:
                    _handle_search(cmd[1], memory)
            elif command == "/identity":
                _handle_identity(identity)
            elif command == "/verify":
                if len(cmd) < 2:
                    print("  Usage: /verify <video_id>")
                else:
                    _handle_verify(cmd[1].strip(), memory, identity)
            elif command == "/vault":
                _handle_vault(vault)
            else:
                print(f"  Unknown command: {command}")
                print(
                    "  Commands: /quit  /history  /search <query>  "
                    "/identity  /verify <video_id>  /vault"
                )

        elif is_youtube_url(user_input):
            _handle_url(user_input, memory, identity, vault)

        else:
            _handle_chat(user_input, memory)
