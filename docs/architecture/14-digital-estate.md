> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Digital Estate

Configurable transfer of vault data upon owner's death or incapacitation. Uses the same Shamir's Secret Sharing infrastructure as identity recovery — no separate mechanism needed.

### Pre-Configuration

Estate plan stored in Tier 0:

```json
{
    "estate_plan": {
        "trigger": "custodian_threshold",
        "custodian_threshold": 3,
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

### Recovery Process

Post-death recovery is human-initiated, not timer-triggered:

1. Custodians (family, lawyer) who hold SSS shares coordinate — at least `custodian_threshold` (e.g., 3-of-5) must participate
2. Shares are combined to reconstruct the master seed
3. Estate executor derives per-beneficiary persona DEKs from the reconstructed seed
4. Per-beneficiary keys delivered via Dina-to-Dina encrypted channel
5. Remaining non-assigned data destroyed per `default_action` configuration

No Dead Man's Switch — avoiding false activations (vacation, illness, lost phone) and aligning with real-world probate processes. Recovery requires deliberate human coordination, not an automated timer.

### Estate Instructions

Pre-configured instructions in the estate plan guide the executor:
- Which personas to release to which beneficiaries
- Access types: `full_decrypt` (permanent) or `read_only_90_days` (time-limited)
- Default action for unassigned data: `destroy` or `archive`
- Notification list: who to inform when estate mode activates

---
