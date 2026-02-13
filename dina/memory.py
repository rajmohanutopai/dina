"""The Memory — Dina's persistent verdict store backed by ChromaDB."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import chromadb
from chromadb.utils.embedding_functions import OllamaEmbeddingFunction

from dina.models import ProductVerdict

_DEFAULT_PERSIST_DIR = Path.home() / ".dina" / "memory"


class VerdictMemory:
    """Semantic vector store for product verdicts.

    Stores verdict summaries as embeddings via ChromaDB + Ollama's
    ``nomic-embed-text`` model so Dina can recall past analyses.
    """

    def __init__(self, persist_dir: Path | None = None) -> None:
        persist_dir = persist_dir or _DEFAULT_PERSIST_DIR
        persist_dir.mkdir(parents=True, exist_ok=True)

        self._client = chromadb.PersistentClient(path=str(persist_dir))
        ef = OllamaEmbeddingFunction(
            model_name="nomic-embed-text",
            url="http://localhost:11434/api/embeddings",
        )
        self._collection = self._client.get_or_create_collection(
            "dina_verdicts",
            embedding_function=ef,
        )

    def store(self, verdict: ProductVerdict, url: str, video_id: str) -> None:
        """Store a verdict, upserting by video ID (no duplicates)."""
        pros = ", ".join(verdict.pros) if verdict.pros else "none"
        cons = ", ".join(verdict.cons) if verdict.cons else "none"
        warnings = ", ".join(verdict.hidden_warnings) if verdict.hidden_warnings else "none"

        document = (
            f"{verdict.product_name}: {verdict.verdict} ({verdict.confidence_score}/100). "
            f"Pros: {pros}. Cons: {cons}. Warnings: {warnings}. "
            f"Source: {verdict.expert_source}."
        )

        self._collection.upsert(
            ids=[video_id],
            documents=[document],
            metadatas=[
                {
                    "product_name": verdict.product_name,
                    "verdict": verdict.verdict,
                    "confidence_score": verdict.confidence_score,
                    "expert_source": verdict.expert_source,
                    "youtube_url": url,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            ],
        )

    def search(self, query: str, n_results: int = 5) -> list[dict]:
        """Semantic search over stored verdicts."""
        if self._collection.count() == 0:
            return []

        n_results = min(n_results, self._collection.count())
        results = self._collection.query(query_texts=[query], n_results=n_results)

        out: list[dict] = []
        for i in range(len(results["ids"][0])):
            out.append(
                {
                    "id": results["ids"][0][i],
                    "document": results["documents"][0][i],
                    "metadata": results["metadatas"][0][i],
                    "distance": results["distances"][0][i] if results.get("distances") else None,
                }
            )
        return out

    def list_recent(self, n: int = 10) -> list[dict]:
        """Return the most recent *n* verdicts, newest first."""
        total = self._collection.count()
        if total == 0:
            return []

        all_results = self._collection.get(include=["documents", "metadatas"])

        items: list[dict] = []
        for i in range(len(all_results["ids"])):
            items.append(
                {
                    "id": all_results["ids"][i],
                    "document": all_results["documents"][i],
                    "metadata": all_results["metadatas"][i],
                }
            )

        items.sort(key=lambda x: x["metadata"].get("timestamp", ""), reverse=True)
        return items[:n]

    @property
    def count(self) -> int:
        """Number of verdicts stored."""
        return self._collection.count()
