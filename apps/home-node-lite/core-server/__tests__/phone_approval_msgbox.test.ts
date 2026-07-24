import { parsePhoneSetupCode } from '../src/approval/phone_approval_msgbox';

describe('phone approval setup code', () => {
  it('parses the existing mobile dina1 format', () => {
    const payload = {
      v: 1,
      msgbox_url: 'wss://test-mailbox.dinakernel.com/ws',
      homenode_did: 'did:plc:phone123',
      transport: 'msgbox',
      device_name: 'Laptop approvals',
      code: 'ABCDEFGH',
    };
    const code = `dina1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    expect(parsePhoneSetupCode(code)).toEqual({
      msgboxURL: payload.msgbox_url,
      phoneDID: payload.homenode_did,
      code: payload.code,
      deviceName: payload.device_name,
    });
  });

  it('rejects insecure relay URLs and malformed fields', () => {
    const bad = Buffer.from(
      JSON.stringify({
        v: 1,
        msgbox_url: 'ws://localhost',
        homenode_did: 'not-a-did',
        code: '',
      }),
    ).toString('base64url');
    expect(() => parsePhoneSetupCode(`dina1:${bad}`)).toThrow(/invalid fields/);
    expect(() => parsePhoneSetupCode('garbage')).toThrow(/dina1/);
  });
});
