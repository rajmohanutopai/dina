/**
 * ATProto OAuth client-metadata document (Login with Bluesky).
 *
 * Pulled into its own pure, side-effect-free module so it's unit-testable
 * without importing the web server (which listens on a port at import time).
 *
 * `client_id` MUST equal the URL this doc is fetched from, so it's derived
 * from the request Host — one route serves both test-appview and appview.
 * The native redirect scheme is the host in reverse-domain order (atproto
 * OAuth native-client rule), e.g.
 *   test-appview.dinakernel.com → com.dinakernel.test-appview:/oauth/callback.
 *
 * SECURITY / privacy: this is an IDENTITY-ONLY login. A one-shot
 * `authorization_code` exchange proves the user controls the Bluesky DID
 * (token `sub`), which Dina links read-only — Dina never reads or writes
 * their PDS. So: no `refresh_token` grant (no ongoing access), and
 * `scope: 'atproto'` NOT `transition:generic` (which grants broad,
 * app-password-like PDS access and would contradict the "No other access
 * required" promise). See https://atproto.com/specs/oauth and
 * https://atproto.com/guides/permission-sets.
 */
export interface OAuthClientMetadata {
  client_id: string
  client_name: string
  client_uri: string
  application_type: 'native'
  dpop_bound_access_tokens: boolean
  grant_types: string[]
  response_types: string[]
  scope: string
  token_endpoint_auth_method: 'none'
  redirect_uris: string[]
}

/** Build the client-metadata document for the given request Host. */
export function buildOAuthClientMetadata(host: string): OAuthClientMetadata {
  const reverseScheme = host.split(':')[0].split('.').reverse().join('.')
  const clientId = `https://${host}/oauth/client-metadata.json`
  return {
    client_id: clientId,
    client_name: 'Dina',
    client_uri: `https://${host}`,
    application_type: 'native',
    dpop_bound_access_tokens: true,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'atproto',
    token_endpoint_auth_method: 'none',
    redirect_uris: [`${reverseScheme}:/oauth/callback`],
  }
}
