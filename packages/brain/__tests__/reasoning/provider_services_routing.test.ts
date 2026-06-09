/**
 * Locks the provider-services routing prompt contract
 * (SERVICES_LAUNCH_ARCHITECTURE.md Part 1, Layer 4): Path 2 must DISCOVER
 * the capability via search_capabilities, NOT guess a capability string,
 * and must return an honest empty-state when discovery finds nothing.
 *
 * This is a wording lock-in — the routing block is load-bearing for the
 * agentic loop's behavior, and a regression to "guess a capability"
 * silently reintroduces Bug 1.
 */

import { describe, it, expect } from '@jest/globals'
import { PROVIDER_SERVICES_ROUTING_BLOCK } from '../../src/reasoning/ask_handler'

describe('PROVIDER_SERVICES_ROUTING_BLOCK', () => {
  it('instructs the model to discover via search_capabilities, not guess', () => {
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toContain('search_capabilities')
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(/do NOT guess a capability/i)
  })

  it('instructs the honest empty-state on no discovery match', () => {
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(/no Dina service for that yet/i)
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(/do NOT invent (a capability|one)/i)
  })

  // Finding #6: search_capabilities returns ALL covered capabilities (no
  // intent ranking at launch), so the prompt MUST warn the model the list
  // is not pre-filtered and to ignore unrelated capabilities — else the
  // LLM could pick a returned-but-irrelevant capability.
  it('warns the list is NOT intent-filtered and to ignore unrelated capabilities', () => {
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(/not pre-filtered/i)
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(/do NOT pick an unrelated capability/i)
  })

  it('still routes "my X" relationships through find_preferred_provider first', () => {
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toContain('find_preferred_provider')
  })

  // PUBLIC_SERVICES_TAXONOMY §3: subject-scoped capabilities are filtered out
  // of generic discovery, so the prompt must (a) route own-record questions
  // ("is my appointment confirmed") through Path 1, (b) tell the model those
  // capabilities are deliberately absent from search_capabilities, and (c)
  // only give the no-service answer after BOTH paths fail — otherwise the
  // old Path-2 example would deterministically dead-end.
  it('routes own-record (subject-scoped) questions via Path 1, not generic discovery', () => {
    // the own-appointment example must sit in Path 1's half, not Path 2's
    const path1 = PROVIDER_SERVICES_ROUTING_BLOCK.split('Path 2:')[0]
    expect(path1).toMatch(/is my appointment confirmed/i)
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(/intentionally absent/i)
  })

  it('requires BOTH paths to fail before the no-service answer (no premature dead-end)', () => {
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(
      /BOTH search_capabilities[\s\S]*AND find_preferred_provider/i,
    )
    expect(PROVIDER_SERVICES_ROUTING_BLOCK).toMatch(/Fall-through works BOTH ways/i)
  })
})
