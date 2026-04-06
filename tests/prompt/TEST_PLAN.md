# Dina Prompt Tests — Test Plan

> Validates LLM prompt quality by calling the real Gemini API with production prompts.
> Requires `GOOGLE_API_KEY` environment variable.

---

## 1. Persona Classification (100 scenarios)

Tests that the persona classification prompt (`PROMPT_PERSONA_CLASSIFY_SYSTEM` in `brain/src/prompts.py`) correctly routes 100 realistic user inputs to the right vault.

### 1.1 General (social, personal, preferences, hobbies)

25 scenarios covering: friend preferences, family facts, hobbies, pets, recipes, travel, social plans.

### 1.2 Health (medical, conditions, doctors, prescriptions)

20 scenarios covering: chronic conditions, blood pressure, medications, allergies, doctor visits, dental, therapy, vaccinations.

### 1.3 Work (professional, meetings, projects, deadlines)

15 scenarios covering: standups, deadlines, performance reviews, onboarding, presentations, certifications.

### 1.4 Finance (money, banking, taxes, insurance)

15 scenarios covering: bank accounts, insurance, IRA, property tax, budgets, mortgage, credit cards, student loans.

### 1.5 Tricky Edge Cases

25 scenarios covering: doctor at lunch (general), green smoothies (general), gym membership (finance), pet health (general), friend's medical situation (general), keto diet (general), medical diet (health), work expense (work), shopping intent (general), sleep tracker (health), hospital bill (finance), subscriptions (finance).
