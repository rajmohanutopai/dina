/**
 * Agent setup code — the one-paste pairing payload.
 *
 * `dina configure` on the agent host used to walk the user through six
 * prompts, two of which (the MsgBox `wss://` URL and the Home Node
 * `did:plc:…`) had to be transcribed off this phone's screen. The setup
 * code bundles everything the agent needs into ONE shareable string:
 *
 *   dina1:<base64url(JSON, no padding)>
 *
 *   {
 *     "v": 1,
 *     "msgbox_url":  "wss://…/ws",     // relay the agent connects through
 *     "homenode_did": "did:plc:…",      // this node's identity (public)
 *     "transport":   "msgbox",
 *     "device_name": "my-agent",        // suggestion — agent may override
 *     "code":        "ABCDEFGH"         // the pairing code (the only secret)
 *   }
 *
 * Security envelope: identical to reading the pairing number aloud. The
 * code is the only secret in the string (the DID is public identity, the
 * relay URL is well-known), and it keeps the ceremony's protections —
 * 5-minute TTL, single-use, burned after 3 failed attempts, role fixed
 * at initiate. Bundling adds no privilege and extends no lifetime.
 *
 * The Python parser lives in `cli/src/dina_cli/setup_code.py`; both sides
 * pin the same cross-language test vector. Bump the `dina1:` prefix if the
 * payload shape ever changes incompatibly.
 */

export interface AgentSetupPayload {
  msgboxUrl: string;
  homenodeDid: string;
  /** Pairing code minted by `generatePairingCode` — the only secret. */
  code: string;
  /** Suggested agent device name (the agent may override at pair time). */
  deviceName: string;
  transport?: 'msgbox' | 'direct' | 'auto';
}

export const SETUP_CODE_PREFIX = 'dina1:';

// base64url (no padding) — same RN-safe encoder shape as atproto_oauth.ts;
// Hermes has no Buffer/btoa, so encode by hand.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rem > 1 ? bytes[i + 1] : 0;
    const n = (b0 << 16) | (b1 << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (rem > 1) out += B64[(n >> 6) & 63];
  }
  return out;
}

/**
 * Build the `dina1:` setup string. Throws when a required field is
 * missing — a partial setup code that "works" until the pairing step is
 * worse than a loud failure on the phone where the user can retry.
 */
export function buildAgentSetupCode(payload: AgentSetupPayload): string {
  const msgboxUrl = payload.msgboxUrl.trim();
  const homenodeDid = payload.homenodeDid.trim();
  const code = payload.code.trim();
  const deviceName = payload.deviceName.trim();
  if (msgboxUrl === '') throw new Error('agent setup code: msgboxUrl is required');
  if (!homenodeDid.startsWith('did:')) {
    throw new Error('agent setup code: homenodeDid must be a DID');
  }
  if (code === '') throw new Error('agent setup code: pairing code is required');

  // Key order is fixed so the emitted string is deterministic for a given
  // payload (stable test vectors; diffable logs of LENGTH only).
  const json = JSON.stringify({
    v: 1,
    msgbox_url: msgboxUrl,
    homenode_did: homenodeDid,
    transport: payload.transport ?? 'msgbox',
    device_name: deviceName,
    code,
  });
  return SETUP_CODE_PREFIX + b64urlEncode(new TextEncoder().encode(json));
}
