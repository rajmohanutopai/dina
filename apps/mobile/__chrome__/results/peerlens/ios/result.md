# Scenario: PeerLens — iOS driver (`idb`)

**Date:** 2026-05-25 · iPhone 17 Pro sim · `com.dinakernel.mobile` (Alonso,
fresh identity from the ask/remember session) · AppView = test-appview.dinakernel.com.

## Result: PASS

| Step | Action | Outcome | Pass |
|---|---|---|---|
| MT-20 tab loads | Open PeerLens tab | Header + search bar + "Your network is quiet" empty feed; no AppView/network error | ✅ |
| MT-21 search | Search "ergonomic" | Reaches test-appview → "No results / Nothing found … write the first review" + "Review 'ergonomic'" CTA | ✅ |
| write review | Tap write → Product, sentiment **Positive**, headline "Great ergonomic chair" → **Publish** | Published to AppView | ✅ |
| publish round-trip | (auto) returns to search | Subject now appears: **"ergonomic · Product · NEW · 1 review · ⭐ 1 friend · 'Great ergonomic chair' · did:plc:aiidvb…nryi · self · trust"** | ✅ |

The previously-empty search now returns the just-written review — confirming
the full §3.8 contribution loop: write → sign → publish to the PeerLens
AppView → indexed → retrievable by search across the network.

## Artefacts
`01_peerlens_home.png` … `09_published.png` in this directory.
Key: `03_search_results.png` (empty → CTA), `09_published.png` (indexed review).
