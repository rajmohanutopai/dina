/**
 * One-paste device setup code shared by mobile and Home Node Lite.
 *
 * The pairing code is the only secret. Relay URL, Home Node DID, transport,
 * and device label are connection metadata.
 */

export interface AgentSetupPayload {
  msgboxUrl: string;
  homenodeDid: string;
  code: string;
  deviceName: string;
  transport?: 'msgbox' | 'direct' | 'auto';
  /**
   * The node's Ed25519 SIGNING public key, hex — PUBLIC connection
   * metadata like the DID itself. Carried so a joining device (the §6
   * staff phone) can seal its very first request without a directory
   * round trip; the Python CLI's parser ignores unknown fields, so this
   * is additive. Absent on codes minted by older builds — consumers
   * fall back to DID resolution.
   */
  nodeSigningPubHex?: string;
}

export const SETUP_CODE_PREFIX = 'dina1:';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  if (i < bytes.length) {
    const remaining = bytes.length - i;
    const b0 = bytes[i];
    const b1 = remaining > 1 ? bytes[i + 1] : 0;
    const n = (b0 << 16) | (b1 << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
    if (remaining > 1) out += B64URL[(n >> 6) & 63];
  }
  return out;
}

export function buildAgentSetupCode(payload: AgentSetupPayload): string {
  const msgboxUrl = payload.msgboxUrl.trim();
  const homenodeDid = payload.homenodeDid.trim();
  const code = payload.code.trim();
  const deviceName = payload.deviceName.trim();
  const transport = payload.transport ?? 'msgbox';

  if (!msgboxUrl.startsWith('ws://') && !msgboxUrl.startsWith('wss://')) {
    throw new Error('agent setup code: msgboxUrl must use ws:// or wss://');
  }
  if (!homenodeDid.startsWith('did:')) {
    throw new Error('agent setup code: homenodeDid must be a DID');
  }
  if (code === '') throw new Error('agent setup code: pairing code is required');
  if (deviceName === '') throw new Error('agent setup code: deviceName is required');
  if (transport !== 'msgbox' && transport !== 'direct' && transport !== 'auto') {
    throw new Error('agent setup code: transport is invalid');
  }

  const json = JSON.stringify({
    v: 1,
    msgbox_url: msgboxUrl,
    homenode_did: homenodeDid,
    transport,
    device_name: deviceName,
    code,
    ...(payload.nodeSigningPubHex === undefined ? {} : { node_pub: payload.nodeSigningPubHex }),
  });
  return SETUP_CODE_PREFIX + b64urlEncode(new TextEncoder().encode(json));
}

function b64urlDecode(text: string): Uint8Array {
  const cleaned = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface ParsedSetupCode {
  msgboxUrl: string;
  homenodeDid: string;
  code: string;
  deviceName: string;
  transport: 'msgbox' | 'direct' | 'auto';
  nodeSigningPubHex: string | null;
}

/** The TS mirror of the CLI's `parse_setup_code` — same refusals. */
export function parseAgentSetupCode(raw: string): ParsedSetupCode {
  const stripped = raw.trim();
  if (!stripped.startsWith(SETUP_CODE_PREFIX)) {
    throw new Error("not a setup code (expected it to start with 'dina1:')");
  }
  const b64 = stripped.slice(SETUP_CODE_PREFIX.length).trim();
  if (b64 === '') throw new Error("setup code is empty after the 'dina1:' prefix");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(b64))) as Record<string, unknown>;
  } catch {
    throw new Error('setup code payload is not valid JSON');
  }
  if (payload.v !== 1) throw new Error(`unsupported setup code version ${String(payload.v)}`);
  const msgboxUrl = typeof payload.msgbox_url === 'string' ? payload.msgbox_url : '';
  if (!msgboxUrl.startsWith('ws://') && !msgboxUrl.startsWith('wss://')) {
    throw new Error('msgbox_url must be a ws:// or wss:// URL');
  }
  const homenodeDid = typeof payload.homenode_did === 'string' ? payload.homenode_did : '';
  if (!homenodeDid.startsWith('did:')) throw new Error('homenode_did must be a DID');
  const code = typeof payload.code === 'string' ? payload.code.trim() : '';
  if (code === '') throw new Error('setup code carries no pairing code');
  const transportRaw = typeof payload.transport === 'string' ? payload.transport : 'msgbox';
  const transport =
    transportRaw === 'direct' || transportRaw === 'auto' ? transportRaw : ('msgbox' as const);
  const nodePub = typeof payload.node_pub === 'string' ? payload.node_pub : '';
  return {
    msgboxUrl,
    homenodeDid,
    code,
    deviceName: typeof payload.device_name === 'string' ? payload.device_name.trim() : '',
    transport,
    nodeSigningPubHex: /^[0-9a-f]{64}$/.test(nodePub) ? nodePub : null,
  };
}
