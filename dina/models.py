"""The Truth Schema — the atomic unit of truth in Dina."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ProductVerdict(BaseModel):
    """A structured verdict extracted from an expert review.

    This is the atomic unit of truth that Dina produces.
    Every field is strictly extracted from the source text — no hallucination allowed.
    """

    product_name: str = Field(description="The name of the product being reviewed.")
    verdict: Literal["BUY", "WAIT", "AVOID"] = Field(
        description="The final recommendation: BUY, WAIT, or AVOID."
    )
    confidence_score: int = Field(
        ge=0,
        le=100,
        description="How confident the verdict is, from 0 (uncertain) to 100 (absolute).",
    )
    pros: list[str] = Field(
        max_length=3,
        description="Up to 3 strengths strictly extracted from the review text.",
    )
    cons: list[str] = Field(
        max_length=3,
        description="Up to 3 weaknesses strictly extracted from the review text.",
    )
    hidden_warnings: list[str] = Field(
        default_factory=list,
        description="Nuanced downsides the reviewer mentioned but didn't highlight.",
    )
    expert_source: str = Field(
        description="The channel name or source of the review."
    )

    # --- v0.3 Identity fields (set by application, not the LLM) ---
    signature_hex: str | None = Field(
        default=None,
        description="Ed25519 signature over canonical verdict JSON (hex-encoded).",
    )
    signer_did: str | None = Field(
        default=None,
        description="did:key of the agent that signed this verdict.",
    )

    # --- v0.4 Vault fields (set by application, not the LLM) ---
    stream_id: str | None = Field(
        default=None,
        description="Ceramic StreamID for the published verdict document.",
    )
