> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 5: Bot Interface

How Dina talks to external bots.

### Query Sanitization

When Dina needs external intelligence, she constructs a sanitized query:

```
User asks: "Should I buy the Aeron chair? I have back problems and I sit 10 hours a day"

Dina knows (from Vault):
  - User's budget range (from financial persona)
  - User's past chair purchases and outcomes
  - User's back issue history (from health persona)

What Dina sends externally (to OpenClaw in Phase 1, to specialist bots in Phase 2+):
  "Best ergonomic office chair for long sitting hours (10+/day),
   lumbar support critical, budget under ₹80,000"

What Dina does NOT send:
  - User's name, identity, DID
  - Specific medical diagnosis
  - Financial details
  - Any persona data
```

### Bot Communication Protocol

Bots register with the Trust Network and expose a standard API:

```
POST /query
{
    "query": "Best ergonomic office chair, lumbar support, budget under 80000 INR",
    "requester_trust_ring": 2,        // anonymous — just the ring level
    "response_format": "structured",   // or "natural_language"
    "max_sources": 5
}

Response:
{
    "recommendations": [
        {
            "product": "Herman Miller Aeron",
            "score": 92,
            "sources": [
                {
                    "type": "expert",
                    "id": "rtings_review_2025",
                    "weight": 0.6,
                    "creator_name": "RTINGS.com",
                    "source_url": "https://rtings.com/chairs/reviews/herman-miller/aeron",
                    "deep_link": "https://rtings.com/chairs/reviews/herman-miller/aeron#lumbar",
                    "deep_link_context": "See lumbar support stress test at this section"
                },
                {"type": "outcome", "sample_size": 4200, "still_using_1yr": 0.89}
            ],
            "cons": ["price_high", "limited_tilt_range"],
            "confidence": 0.87
        }
    ],
    "bot_signature": "...",           // cryptographic signature for verification
    "bot_did": "did:plc:..."           // bot's identity in Trust Network
}
```

**Attribution is mandatory in the protocol.** Every expert source in a bot response MUST include `creator_name`, `source_url`, and where possible `deep_link` + `deep_link_context`.

Dina's default presentation uses the **Deep Link pattern**: drive traffic to the original source rather than extracting and replacing the expert's work. Bots that strip attribution receive a trust penalty.
```

### Bot Trust Scoring

Every bot interaction feeds back into the Bot Trust Registry:

```
Bot Trust = f(
    response_accuracy,     // did outcomes match recommendations?
    response_time,         // latency
    uptime,               // availability
    user_ratings,         // explicit thumbs up/down from users
    consistency,          // does it give different answers to similar queries?
    age,                  // how long has this bot been operating?
    peer_endorsements     // other bots or experts vouch for it
)
```

Dina tracks bot scores locally. If a bot's accuracy drops below a threshold, Dina automatically routes to the next-best bot. No manual intervention.

### Bot Discovery

How does Dina find bots in the first place?

- **Phase 1:** No bot registry needed. Brain delegates research to OpenClaw (web search). Users can configure preferred specialist bots manually.
- **Phase 2:** Decentralized bot registry on the Trust Network. Bots self-register, and their trust score determines visibility.
- **Phase 3:** Bot-to-bot recommendations. "This query is outside my domain. Try the Medical Bot at did:plc:..."

---

