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
  });
  return SETUP_CODE_PREFIX + b64urlEncode(new TextEncoder().encode(json));
}
