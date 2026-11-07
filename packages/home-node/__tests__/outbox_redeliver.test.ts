/**
 * Outbox re-delivery keeps the first send's message id (TODO "Duplicate D2D
 * sends"). Each retry used to mint a fresh id, so a peer whose copy had
 * already arrived took every retry as a new message.
 */

const coreSend = jest.fn<Promise<SendResult>, [Record<string, unknown>]>();

jest.mock('@dina/core/runtime', () => {
  const actual = jest.requireActual('@dina/core/runtime');
  return { ...actual, sendD2D: (req: Record<string, unknown>) => coreSend(req) };
});

import { makeOutboxRedeliver } from '../src/send_d2d';

import type { D2DOutboxRow, SendResult } from '@dina/core';

const PEER = 'did:plc:peer';
const resolver = {
  resolve: async () => ({
    document: {
      verificationMethod: [
        {
          id: `${PEER}#key-1`,
          type: 'Multikey',
          // did:key-style Ed25519 multibase (z + 0xed01 prefix + 32 bytes).
          publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        },
      ],
    },
    messagingService: { endpoint: 'wss://msgbox.test' },
  }),
};

function row(): D2DOutboxRow {
  return {
    id: 'd2d-0123456789abcdef',
    targetDID: PEER,
    messageType: 'coordination.request',
    bodyJson: '{"text":"hi"}',
    idempotencyKey: 'd2d-0123456789abcdef',
    state: 'sending',
    attempts: 1,
    nextAttemptAt: 0,
    lastAttemptAt: null,
    leaseUntil: null,
    expiresAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function result(over: Partial<SendResult>): SendResult {
  return {
    sent: true,
    messageId: 'd2d-0123456789abcdef',
    delivered: false,
    buffered: false,
    queued: false,
    ...over,
  } as SendResult;
}

describe('makeOutboxRedeliver', () => {
  const redeliver = makeOutboxRedeliver({
    senderDID: 'did:plc:me',
    senderPrivateKey: new Uint8Array(32),
    defaultMsgboxEndpoint: 'wss://fallback.test',
    resolver: resolver as never,
  });

  beforeEach(() => coreSend.mockReset());

  it('re-sends under the row id, so every retry carries the same message id', async () => {
    coreSend.mockResolvedValue(result({ delivered: true }));
    await redeliver(row());
    await redeliver(row());
    expect(coreSend).toHaveBeenCalledTimes(2);
    for (const [req] of coreSend.mock.calls) {
      expect(req.messageId).toBe('d2d-0123456789abcdef');
      expect(req.suppressEnqueue).toBe(true);
    }
  });

  it('counts a copy buffered at MsgBox as delivered, so it is not sent again', async () => {
    coreSend.mockResolvedValue(result({ buffered: true }));
    await expect(redeliver(row())).resolves.toEqual({ delivered: true });
  });

  it('reports a failure when neither delivered nor buffered', async () => {
    coreSend.mockResolvedValue(result({ error: 'offline' }));
    await expect(redeliver(row())).resolves.toEqual({ delivered: false, error: 'offline' });
  });
});
