> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Digital Estate

Configurable transfer of vault data upon owner's death or incapacitation.

### Pre-Configuration

Estate plan stored in Tier 0:

```json
{
    "estate_plan": {
        "trigger": "dead_mans_switch",
        "switch_interval_days": 90,
        "beneficiaries": [
            {
                "name": "Daughter",
                "dina_did": "did:plc:...",
                "receives": ["/persona/social", "/persona/health"],
                "access_type": "full_decrypt"
            },
            {
                "name": "Spouse",
                "dina_did": "did:plc:...",
                "receives": ["/persona/financial", "/persona/citizen"],
                "access_type": "full_decrypt"
            },
            {
                "name": "Colleague",
                "dina_did": "did:plc:...",
                "receives": ["/persona/professional"],
                "access_type": "read_only_90_days"
            }
        ],
        "default_action": "destroy"
    }
}
```

### Dead Man's Switch

Every N days (configurable, default 90), Dina asks: "Still here?" If the user doesn't respond after 3 attempts over 2 weeks:

1. Dina enters "estate mode"
2. Sends notification to designated beneficiaries
3. Generates per-beneficiary decryption keys (derived from root, limited to specified personas)
4. Delivers keys via Dina-to-Dina encrypted channel
5. Destroys remaining data per configuration

### Alternative Triggers
- Manual trigger by next-of-kin with physical recovery phrase + death certificate verification
- Multiple-beneficiary threshold (e.g., 2 of 3 beneficiaries attest to death)

---

