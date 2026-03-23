# Dina PII Detection Architecture (V2 Design Spec)

> **Status:** Design specification for V2. V1 implements Layers 0–1 + allow-list only.
> NER (Layer 3) and LLM adjudicator (Layer 4) are deferred to V2.
>
> **Author:** Rajmohan (product spec), Claude (implementation plan)
> **Date:** 2026-03-23

This document defines the full PII detection architecture for Dina.
See the user's complete design spec in the conversation history for
the full text including:

- Layer 0: Source Format (schema/field-level rules)
- Layer 1: Deterministic Pattern Recognizers (Presidio, no NER)
- Layer 2: Dictionary Allow-List / Deny-List
- Layer 3: Contextual NER (GLiNER / SpanMarker, local only)
- Layer 4: LLM Adjudicator (privacy gateway pattern)
- Policy-Specific Transforms (pseudonymize/mask/hash/sanitize/strict/partial)
- Confidence Banding (high ≥0.85 auto-redact, medium 0.40–0.85 adjudicate, low <0.40 ignore)
- EU/UK Deployment Extension
- Threat Model
- Evaluation and Calibration Loop

## V1 Implementation (Current)

| Layer | Status | What it does |
|-------|--------|-------------|
| 0 | Not implemented | Schema/field-level rules |
| 1 | **Implemented** | Presidio pattern recognizers (email, phone, SSN, credit card, gov IDs) + Core Go regex |
| 2 | **Implemented** | Allow-list (`brain/config/pii_allowlist.yaml`) — medical, financial, immigration, technical, food terms |
| 3 | Not implemented | GLiNER local NER (deferred — spaCy disabled due to false positives) |
| 4 | Not implemented | LLM adjudicator via privacy gateway |

### V1 Known Gap

Names and addresses in free text are NOT detected. This is an accepted
trade-off. Pattern-based PII (phones, emails, SSNs, credit cards, gov IDs)
is caught with zero false positives. The allow-list eliminates false
positives from pattern recognizers (B12, biryani, etc.).

### V1 Token Format

Opaque tokens: `[PERSON_1]`, `[ORG_1]`, `[LOC_1]`, `[PHONE_1]`, `[EMAIL_1]`.
No Faker names. Exact-match rehydration. Bare tokens (LLM strips brackets)
also matched.

## V2 Roadmap

1. Layer 0: Schema/field-level rules for structured API inputs
2. Layer 3: GLiNER (~300M params, local) for contextual NER
3. Layer 4: LLM adjudicator with privacy gateway (pre-masked context)
4. Confidence banding between Layer 3 and Layer 4
5. Policy-specific transforms per destination
6. Evaluation corpus and calibration loop
