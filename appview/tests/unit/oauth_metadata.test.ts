/**
 * OAuth client-metadata (Login with Bluesky) — scope + grant contract.
 *
 * Login with Bluesky is IDENTITY-ONLY: prove control of the DID, link it
 * read-only. These tests pin that the served client-metadata never widens
 * to broad PDS access (`transition:generic`) or ongoing access
 * (`refresh_token`) — a regression there silently contradicts the
 * "No other access required" promise.
 */
import { describe, it, expect } from 'vitest'
import { buildOAuthClientMetadata } from '@/web/oauth_metadata.js'

describe('OAuth client metadata', () => {
  it('requests identity-only scope, NEVER transition:generic', () => {
    const m = buildOAuthClientMetadata('test-appview.dinakernel.com')
    expect(m.scope).toBe('atproto')
    expect(m.scope).not.toContain('transition')
  })

  it('does not request a refresh_token grant (one-shot identity exchange)', () => {
    const m = buildOAuthClientMetadata('appview.dinakernel.com')
    expect(m.grant_types).toEqual(['authorization_code'])
    expect(m.grant_types).not.toContain('refresh_token')
    expect(m.response_types).toEqual(['code'])
  })

  it('derives client_id + reverse-domain native redirect from the host', () => {
    const m = buildOAuthClientMetadata('test-appview.dinakernel.com')
    expect(m.client_id).toBe('https://test-appview.dinakernel.com/oauth/client-metadata.json')
    expect(m.redirect_uris).toEqual(['com.dinakernel.test-appview:/oauth/callback'])
    expect(m.application_type).toBe('native')
    expect(m.token_endpoint_auth_method).toBe('none')
    expect(m.dpop_bound_access_tokens).toBe(true)
  })
})
