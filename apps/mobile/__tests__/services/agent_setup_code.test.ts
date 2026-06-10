/**
 * Agent setup code builder — the TS half of the cross-language contract.
 *
 * PINNED_VECTOR is byte-identical in cli/tests/test_setup_code.py; if the
 * payload shape or encoding changes, BOTH pins must move together (and the
 * `dina1:` prefix bumps on incompatible change).
 */

import { buildAgentSetupCode, SETUP_CODE_PREFIX } from '../../src/services/agent_setup_code';

const PINNED_VECTOR =
  'dina1:eyJ2IjoxLCJtc2dib3hfdXJsIjoid3NzOi8vdGVzdC1tYWlsYm94LmRpbmFrZXJuZWwuY29tL3dzIiwiaG9tZW5vZGVfZGlkIjoiZGlkOnBsYzpzNm1icDdycWc2ZGluYXRlc3R3aWU1dSIsInRyYW5zcG9ydCI6Im1zZ2JveCIsImRldmljZV9uYW1lIjoib3BlbmNsYXctYWdlbnQiLCJjb2RlIjoiQUJDRDJFRkcifQ';

const VECTOR_INPUT = {
  msgboxUrl: 'wss://test-mailbox.dinakernel.com/ws',
  homenodeDid: 'did:plc:s6mbp7rqg6dinatestwie5u',
  deviceName: 'openclaw-agent',
  code: 'ABCD2EFG',
};

describe('buildAgentSetupCode', () => {
  it('emits the pinned cross-language vector byte-for-byte', () => {
    expect(buildAgentSetupCode(VECTOR_INPUT)).toBe(PINNED_VECTOR);
  });

  it('round-trips through base64url decode to the expected payload', () => {
    const built = buildAgentSetupCode(VECTOR_INPUT);
    const b64 = built.slice(SETUP_CODE_PREFIX.length);
    const decoded = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(decoded).toEqual({
      v: 1,
      msgbox_url: VECTOR_INPUT.msgboxUrl,
      homenode_did: VECTOR_INPUT.homenodeDid,
      transport: 'msgbox',
      device_name: VECTOR_INPUT.deviceName,
      code: VECTOR_INPUT.code,
    });
  });

  it('handles multi-byte UTF-8 device names (non-ASCII survives the hand-rolled encoder)', () => {
    const built = buildAgentSetupCode({ ...VECTOR_INPUT, deviceName: 'café-агент-代理' });
    const decoded = JSON.parse(
      Buffer.from(built.slice(SETUP_CODE_PREFIX.length), 'base64url').toString('utf8'),
    ) as { device_name: string };
    expect(decoded.device_name).toBe('café-агент-代理');
  });

  it('rejects missing required fields loudly', () => {
    expect(() => buildAgentSetupCode({ ...VECTOR_INPUT, msgboxUrl: ' ' })).toThrow(/msgboxUrl/);
    expect(() => buildAgentSetupCode({ ...VECTOR_INPUT, homenodeDid: 'plc:nope' })).toThrow(/DID/);
    expect(() => buildAgentSetupCode({ ...VECTOR_INPUT, code: '' })).toThrow(/pairing code/);
  });
});
