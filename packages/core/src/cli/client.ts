/**
 * CLI client utilities — connection errors, auth errors, signing headers,
 * body extraction.
 *
 * Source: cli/tests/test_client.py (portable parts)
 */

/** Required Ed25519 signing headers. */
const REQUIRED_SIGNING_HEADERS = ['X-DID', 'X-Timestamp', 'X-Nonce', 'X-Signature'];

/** Retryable error patterns. */
const RETRYABLE_PATTERNS = [
  /ECONNREFUSED/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /ENETUNREACH/i,
];

/** Handle connection error to Dina Core. */
export function handleConnectionError(error: Error): { retryable: boolean; message: string } {
  const msg = error.message || '';
  const retryable = RETRYABLE_PATTERNS.some((p) => p.test(msg));

  if (/ECONNREFUSED/i.test(msg)) {
    return { retryable: true, message: 'Cannot connect to Dina Core — is it running?' };
  }
  if (/timeout/i.test(msg)) {
    return { retryable: true, message: 'Connection to Dina Core timed out — will retry' };
  }

  return { retryable, message: `Connection error: ${msg}` };
}

/** Handle 401 authentication failure. */
export function handleAuthError(): { message: string; action: string } {
  return {
    message: 'Authentication failed (401) — your device key may not be paired',
    action: 'Run `dina pair` to register this device with your Dina node',
  };
}

/** Verify that signed request headers are present. */
export function hasSigningHeaders(headers: Record<string, string>): boolean {
  return REQUIRED_SIGNING_HEADERS.every((h) => h in headers && headers[h].length > 0);
}

/** Verify Core client does NOT use Authorization: Bearer header. */
export function hasNoBearerHeader(headers: Record<string, string>): boolean {
  const authHeader = headers['Authorization'] || headers['authorization'];
  if (!authHeader) return true;
  return !authHeader.startsWith('Bearer ');
}

/** Extract body from request: JSON serialization with compact separators. */
export function extractBody(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}
