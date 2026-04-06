"""Prompt-level tests for persona classification.

Calls the real LLM with the actual production prompt and validates that
100 realistic user inputs are routed to the correct vault.

Requires:
  GOOGLE_API_KEY env var (uses Gemini — same model as production)

Run:
  GOOGLE_API_KEY=... pytest tests/prompt/test_persona_classification.py -v
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

# Add brain/src to path so we can import prompts directly
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "brain" / "src"))

from prompts import PROMPT_PERSONA_CLASSIFY_SYSTEM  # noqa: E402

# ---------------------------------------------------------------------------
# LLM caller — minimal, no framework dependency
# ---------------------------------------------------------------------------

GEMINI_API_KEY = os.environ.get("GOOGLE_API_KEY", "")

# Available personas (matches a typical Dina installation)
AVAILABLE_PERSONAS = [
    {"name": "general", "tier": "default", "description": "General personal information, social contacts, hobbies, preferences, family, friends"},
    {"name": "health", "tier": "sensitive", "description": "Medical records, doctor visits, prescriptions, diagnoses, health conditions"},
    {"name": "work", "tier": "standard", "description": "Professional tasks, meetings, projects, colleagues, career"},
    {"name": "finance", "tier": "sensitive", "description": "Bank accounts, investments, taxes, insurance, bills, budgets, salaries"},
]


def classify(text: str) -> str:
    """Call Gemini with the persona classification prompt. Returns persona name."""
    import httpx

    item_context = json.dumps({
        "today": "2026-04-06",
        "available_personas": AVAILABLE_PERSONAS,
        "item_type": "note",
        "source": "telegram",
        "sender": "owner",
        "summary": text[:200],
        "body_preview": text[:300],
    }, indent=2)

    payload = {
        "system_instruction": {"parts": [{"text": PROMPT_PERSONA_CLASSIFY_SYSTEM}]},
        "contents": [
            {"role": "user", "parts": [{"text": item_context}]},
        ],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 256,
            "responseMimeType": "application/json",
        },
    }

    model = os.environ.get("GEMINI_CLASSIFY_MODEL", "gemini-2.5-flash")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"

    r = httpx.post(url, json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()

    content = data["candidates"][0]["content"]["parts"][0]["text"]
    result = json.loads(content)
    return result.get("primary", "unknown")


# ---------------------------------------------------------------------------
# 100 test scenarios
# ---------------------------------------------------------------------------

# Format: (input_text, expected_persona)
SCENARIOS = [
    # ── GENERAL: Social facts, friends, family, preferences ──────────
    ("Alonso likes cold brew coffee extra strong", "general"),
    ("My neighbor Sarah makes the best apple pie on the block", "general"),
    ("Sancho's favorite movie is The Shawshank Redemption", "general"),
    ("We usually watch football together on Sunday afternoons", "general"),
    ("My dog Max loves playing fetch at the park every morning", "general"),
    ("Emma's birthday is March 15 and she loves dinosaurs", "general"),
    ("The best pizza in town is at Joe's on 5th Avenue", "general"),
    ("I promised to help Mike move apartments next Saturday", "general"),
    ("My mom's lasagna recipe uses three kinds of cheese", "general"),
    ("I met Sancho at college in 2015, we were roommates", "general"),
    ("My sister just got engaged to Tom, wedding is in October", "general"),
    ("Dave prefers window seats on flights and always books aisle", "general"),
    ("My kids love going to the aquarium on rainy weekends", "general"),
    ("Sancho is vegetarian and allergic to tree nuts", "general"),
    ("My favorite coffee shop is Blue Bottle on Market Street", "general"),
    ("We adopted a cat named Luna from the shelter last month", "general"),
    ("My dad's 70th birthday party is at the Italian restaurant downtown", "general"),
    ("I usually run 3 miles every morning before work", "general"),
    ("The book club meets every second Thursday at Maria's house", "general"),
    ("When friends visit, I usually order from the Thai place nearby", "general"),
    ("My niece is learning piano and has a recital on May 10", "general"),
    ("I prefer to fly Delta when traveling to the East Coast", "general"),
    ("Our anniversary is June 22, we always go to that French bistro", "general"),
    ("Sancho brings banana bread whenever he visits", "general"),
    ("My neighbor lent me their lawnmower, need to return it", "general"),

    # ── HEALTH: Medical, conditions, doctors, prescriptions ──────────
    ("I have chronic lower back pain and need lumbar support", "health"),
    ("My blood pressure was 130/85 at last checkup", "health"),
    ("I take 10mg of lisinopril every morning for hypertension", "health"),
    ("Allergic to penicillin — discovered during surgery in 2019", "health"),
    ("Dr. Martinez said my cholesterol is borderline high", "health"),
    ("I need to schedule a dental cleaning before end of June", "health"),
    ("My daughter has a peanut allergy — always carry an EpiPen", "health"),
    ("MRI results show a herniated disc at L4-L5", "health"),
    ("I was diagnosed with Type 2 diabetes last year", "health"),
    ("My therapist recommended cognitive behavioral therapy sessions", "health"),
    ("I get migraines about twice a month, usually triggered by stress", "health"),
    ("Physical therapy appointment every Tuesday at 3pm", "health"),
    ("My optometrist said I need new glasses, prescription changed", "health"),
    ("I had my flu shot on October 15 at CVS", "health"),
    ("My doctor recommended I reduce sodium intake to under 2000mg", "health"),
    ("Annual physical is scheduled for November 3 with Dr. Chen", "health"),
    ("I'm on a waiting list for an orthopedic specialist", "health"),
    ("My son has asthma and uses an albuterol inhaler", "health"),
    ("Bloodwork came back normal except for low vitamin D", "health"),
    ("I need to refill my Metformin prescription this week", "health"),

    # ── WORK: Professional, meetings, projects, deadlines ────────────
    ("Team standup is at 9am every Monday, Wednesday, Friday", "work"),
    ("Q3 project deadline is September 30, need to finish the API migration", "work"),
    ("My manager Dave wants the performance review draft by Friday", "work"),
    ("The new intern starts on Monday, I need to prepare onboarding docs", "work"),
    ("Client presentation for Acme Corp is next Thursday at 2pm", "work"),
    ("Need to submit the quarterly expense report by end of month", "work"),
    ("One-on-one with my skip-level manager is every other Friday", "work"),
    ("The Jenkins pipeline has been failing on the staging branch", "work"),
    ("Team offsite is planned for the third week of August in Denver", "work"),
    ("I'm mentoring two junior engineers this quarter", "work"),
    ("Sprint retrospective is tomorrow at 4pm in Conference Room B", "work"),
    ("The product launch is scheduled for Q4, marketing needs assets by Sept 15", "work"),
    ("My work laptop is a 2024 MacBook Pro with 32GB RAM", "work"),
    ("I need to complete the compliance training module before Friday", "work"),
    ("My team lead Sarah is on parental leave until September", "work"),

    # ── FINANCE: Money, banking, taxes, insurance ────────────────────
    ("My checking account at Chase ends in 4521", "finance"),
    ("Car insurance renewal is due August 15, currently $180/month", "finance"),
    ("I contributed $6500 to my Roth IRA this year", "finance"),
    ("Property tax bill is $4200, due December 1", "finance"),
    ("My monthly budget for groceries is around $600", "finance"),
    ("Mortgage payment is $2100/month, 30-year fixed at 6.5%", "finance"),
    ("I owe $3200 on my Visa credit card, due on the 15th", "finance"),
    ("My 401k balance is around $180,000, mostly in index funds", "finance"),
    ("Auto loan has 18 months remaining, $450/month payment", "finance"),
    ("I need to file estimated taxes for Q2 by June 15", "finance"),
    ("Home insurance covers up to $500,000 with a $1000 deductible", "finance"),
    ("I transferred $5000 from savings to checking last week", "finance"),
    ("My annual salary is $125,000 before taxes", "finance"),
    ("Student loan balance is $28,000 at 4.5% interest", "finance"),
    ("I set aside $500/month for my kids' 529 college savings plan", "finance"),

    # ── TRICKY EDGE CASES ────────────────────────────────────────────
    # Social context with medical professional
    ("Meeting Dr. Williams for lunch at the Italian place on Tuesday", "general"),
    # Lifestyle choice, not medical
    ("I drink green smoothies every morning before my run", "general"),
    # Financial transaction for a health service
    ("My gym membership at Planet Fitness costs $25/month", "finance"),
    # Work event with food (social at work)
    ("The office holiday party is December 20, I signed up to bring dessert", "work"),
    # Pet health — could go health but it's about a pet, not the user
    ("Max needs his rabies booster shot next month at the vet", "general"),
    # Friend's medical situation — social concern, not user's health
    ("Sancho's mom is recovering from hip surgery, doing much better", "general"),
    # Diet preference vs medical diet
    ("I'm trying the keto diet to lose some weight this summer", "general"),
    # Medical diet prescribed by doctor
    ("My doctor put me on a low-sodium diet after the heart scare", "health"),
    # Work expense
    ("I spent $450 on the team dinner, need to expense it", "work"),
    # Shopping plan — not finance (it's a purchase intent, not financial data)
    ("I want to buy a new standing desk for my home office", "general"),
    # Cooking hobby, not health
    ("I've been learning to make sourdough bread, my starter is 3 weeks old", "general"),
    # Travel plan
    ("We're planning a road trip to Yellowstone in August", "general"),
    # Work tool, not personal
    ("My work email is john.smith@acme.com", "work"),
    # Insurance — finance
    ("I need to compare health insurance plans during open enrollment", "finance"),
    # Emotional fact about a person — general
    ("My grandmother passed away last March, I miss her a lot", "general"),
    # Sleep tracking — health
    ("My sleep tracker shows I'm only averaging 5.5 hours per night", "health"),
    # Home improvement — general
    ("We need to repaint the living room, thinking about sage green", "general"),
    # Medical bill — finance (it's about the money, not the condition)
    ("The hospital bill for my ER visit was $4,800 after insurance", "finance"),
    # Hobby equipment
    ("My fishing rod broke last weekend, need to get a new one", "general"),
    # Work certification
    ("I need to renew my AWS certification before it expires in November", "work"),
    # Subscription — finance
    ("Netflix raised their price to $22.99/month, considering canceling", "finance"),
    # Friend's work — general (it's about a friend, not your work)
    ("Sancho just got promoted to VP of Engineering at his company", "general"),
    # Vaccine appointment — health
    ("COVID booster appointment is scheduled for next Wednesday at 2pm", "health"),
    # Gift budget — this is about spending/money
    ("I set a $200 budget for holiday gifts this year", "finance"),
    # Volunteering — general
    ("I signed up to volunteer at the food bank every other Saturday", "general"),
]

assert len(SCENARIOS) == 100, f"Expected 100 scenarios, got {len(SCENARIOS)}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module", autouse=True)
def _require_api_key():
    if not GEMINI_API_KEY:
        pytest.skip("GOOGLE_API_KEY not set — skipping prompt tests")


# TRACE: {"suite": "PROMPT", "case": "0001-0100", "section": "01", "sectionName": "Persona Classification", "subsection": "01", "scenario": "parametrized", "title": "persona_classification_100_scenarios"}
@pytest.mark.parametrize(
    "text,expected",
    SCENARIOS,
    ids=[f"{i+1:03d}_{exp}_{text[:40]}" for i, (text, exp) in enumerate(SCENARIOS)],
)
def test_persona_classification(text: str, expected: str):
    """Validate that the persona classification prompt routes correctly."""
    got = classify(text)
    assert got == expected, f"Expected '{expected}', got '{got}' for: {text}"
