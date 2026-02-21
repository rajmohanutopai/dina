"""The Brain — Dina's reasoning core powered by a local or cloud LLM.

Agents are defined without a default model; the model is passed at
runtime via ``run_sync(model=...)`` so that :mod:`dina.providers` can
route tasks to the appropriate light or heavy model.
"""

from __future__ import annotations

from pydantic_ai import Agent

from dina.models import ProductVerdict

VERDICT_SYSTEM_PROMPT = (
    "You are Dina. You are a skeptical, fiduciary agent protecting the user's wallet. "
    "You do not trust ads. You strip away marketing fluff and look for the raw engineering "
    "truth in the provided text.\n\n"
    "Given the transcript of a product review, extract a structured verdict. "
    "Every field must be grounded in the text — do not invent information. "
    "If the reviewer is clearly positive, verdict is BUY. "
    "If they suggest waiting for a next generation or price drop, verdict is WAIT. "
    "If they warn against purchase, verdict is AVOID."
)

CHAT_SYSTEM_PROMPT = (
    "You are Dina, a personal purchasing advisor with a memory of past product verdicts. "
    "You are skeptical, fiduciary, and loyal only to the user. "
    "You will be given the user's question along with relevant context from your memory. "
    "Reference specific verdicts when relevant. "
    "If you don't have enough context, say so honestly."
)

verdict_agent = Agent(
    output_type=ProductVerdict,
    instructions=VERDICT_SYSTEM_PROMPT,
)

chat_agent = Agent(
    output_type=str,
    instructions=CHAT_SYSTEM_PROMPT,
)

# Backward-compat alias so run_dina.py keeps working unchanged.
dina_agent = verdict_agent

# Keep old constant name accessible for anything referencing it.
SYSTEM_PROMPT = VERDICT_SYSTEM_PROMPT
