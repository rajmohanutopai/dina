"""The Voice — Dina's interactive conversational REPL."""

from __future__ import annotations

from dina.agent import chat_agent, verdict_agent
from dina.memory import VerdictMemory
from dina.tools import extract_video_id, fetch_youtube_transcript, is_youtube_url

_BANNER = """\
  Dina v0.2 — The Voice
  Your skeptical purchasing advisor. Local-first. No ads. No tracking.
  Paste a YouTube review URL or ask me anything about past verdicts.
  Commands: /quit  /history  /search <query>
"""


def _handle_url(url: str, memory: VerdictMemory) -> None:
    """Analyse a YouTube review and store the verdict."""
    video_id = extract_video_id(url)
    print(f"Fetching transcript for: {url}")
    transcript = fetch_youtube_transcript(url)
    print(f"Transcript length: {len(transcript)} chars — analysing with Dina...\n")

    result = verdict_agent.run_sync(
        f"Analyse this product review transcript and produce a verdict:\n\n{transcript}"
    )
    verdict = result.output

    memory.store(verdict, url, video_id)
    print(verdict.model_dump_json(indent=2))
    print(f"\n  Stored in memory. ({memory.count} verdict(s) total)")


def _handle_history(memory: VerdictMemory) -> None:
    """Print the most recent verdicts."""
    items = memory.list_recent(10)
    if not items:
        print("  No verdicts stored yet. Paste a YouTube review URL to get started.")
        return

    for i, item in enumerate(items, 1):
        meta = item["metadata"]
        print(
            f"  {i}. {meta['product_name']} — {meta['verdict']} "
            f"({meta['confidence_score']}/100) — {meta['expert_source']}"
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

    result = chat_agent.run_sync(prompt)
    print(f"\n  {result.output}\n")


def repl() -> None:
    """Launch the Dina interactive REPL."""
    memory = VerdictMemory()
    print(_BANNER)

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
            else:
                print(f"  Unknown command: {command}")
                print("  Commands: /quit  /history  /search <query>")

        elif is_youtube_url(user_input):
            _handle_url(user_input, memory)

        else:
            _handle_chat(user_input, memory)
