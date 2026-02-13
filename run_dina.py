"""CLI entry point — run Dina against a YouTube review URL."""

from __future__ import annotations

import sys

from dina.agent import dina_agent
from dina.tools import fetch_youtube_transcript


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python run_dina.py <youtube-url>")
        sys.exit(1)

    url = sys.argv[1]

    print(f"Fetching transcript for: {url}")
    transcript = fetch_youtube_transcript(url)
    print(f"Transcript length: {len(transcript)} chars — analysing with Dina...\n")

    result = dina_agent.run_sync(
        f"Analyse this product review transcript and produce a verdict:\n\n{transcript}"
    )

    print(result.output.model_dump_json(indent=2))


if __name__ == "__main__":
    main()
