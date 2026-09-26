/**
 * NEGOTIATION_PLAN §4.5 / §4.7 — the tender methods on the owner's in-process
 * client and the clerk's relay client read Core's answers into one shape: an
 * award or a send over a clerk's cap (202) is "waiting for the owner", a
 * typed outcome; a refusal is an error carrying Core's own key.
 */

import {
  InProcessOwnerCommerceClient,
  OwnerCommerceHttpError,
} from '../../src/client/owner-commerce-client';
import { StaffClientError, StaffCoreClient } from '../../src/transport/staff_client';

import type { CoreResponse, CoreRouter } from '../../src/server/router';
import type { RemoteCoreClient } from '../../src/transport/remote_core_client';

const AWARDED = {
  approval_id: 'oap_1',
  purchase_order_id: 'po-1',
  awarded: { supplier_did: 'did:plc:supplierb' },
};
const REPLAYED = {
  replayed: true,
  approval_id: 'oap_1',
  awarded_supplier_did: 'did:plc:supplierb',
};
const SENT = {
  ok: true,
  state: 'submitted_unconfirmed',
  headline: 'Sent. Waiting for the supplier to confirm.',
};
const WAITING = { status: 'pending_approval', task_id: 'staff-escalation-1' };

function staffWith(status: number, body: unknown): { client: StaffCoreClient; calls: string[] } {
  const calls: string[] = [];
  const transport = {
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return { status, body: JSON.stringify(body), headers: {} };
    },
  } as unknown as RemoteCoreClient;
  return { client: new StaffCoreClient(transport), calls };
}

function ownerWith(status: number, body: unknown): InProcessOwnerCommerceClient {
  const router = {
    handle: async (): Promise<CoreResponse> => ({ status, body }),
  } as unknown as CoreRouter;
  return new InProcessOwnerCommerceClient(router, 'cap');
}

describe("the clerk's relay client", () => {
  it('reads an award, a replayed award, and "waiting for the owner"', async () => {
    const fresh = staffWith(200, AWARDED);
    expect(await fresh.client.awardTender({ tenderId: 't1' })).toEqual({
      kind: 'awarded',
      approvalId: 'oap_1',
      supplierDid: 'did:plc:supplierb',
      replayed: false,
    });
    expect(fresh.calls).toEqual(['POST /v1/commerce/trade/tender/award']);
    expect(await staffWith(200, REPLAYED).client.awardTender({ tenderId: 't1' })).toMatchObject({
      kind: 'awarded',
      supplierDid: 'did:plc:supplierb',
      replayed: true,
    });
    expect(await staffWith(202, WAITING).client.awardTender({ tenderId: 't1' })).toEqual({
      kind: 'pending_approval',
      taskId: 'staff-escalation-1',
    });
  });

  it('reads a send and "waiting for the owner"; a refusal carries Core\'s key', async () => {
    expect(await staffWith(200, SENT).client.sendHeldOrder('oap_1')).toEqual({
      kind: 'sent',
      headline: 'Sent. Waiting for the supplier to confirm.',
      state: 'submitted_unconfirmed',
    });
    expect(await staffWith(202, WAITING).client.sendHeldOrder('oap_1')).toMatchObject({
      kind: 'pending_approval',
    });
    await expect(
      staffWith(409, { error: 'counter_in_flight' }).client.awardTender({ tenderId: 't1' }),
    ).rejects.toMatchObject({ errorKey: 'counter_in_flight', status: 409 });
    await expect(
      staffWith(403, { error: 'no_user_presence' }).client.sendHeldOrder('oap_1'),
    ).rejects.toBeInstanceOf(StaffClientError);
  });

  it('asks for the ranking of the named tender, escaped', async () => {
    const { client, calls } = staffWith(200, {
      tender_id: 't 1',
      state: 'ready',
      ranked: [],
      excluded: [],
    });
    await client.tenderRanking('t 1');
    expect(calls).toEqual(['GET /v1/commerce/trade/tender/ranking?tender_id=t%201']);
  });
});

describe("the owner's in-process client", () => {
  it("reads the same shapes, and throws Core's key on a refusal", async () => {
    expect(await ownerWith(200, AWARDED).awardTender({ tenderId: 't1' })).toMatchObject({
      kind: 'awarded',
      approvalId: 'oap_1',
    });
    expect(await ownerWith(200, SENT).sendHeldOrder('oap_1')).toMatchObject({ kind: 'sent' });
    await expect(
      ownerWith(403, { error: 'no_user_presence' }).awardTender({ tenderId: 't1' }),
    ).rejects.toBeInstanceOf(OwnerCommerceHttpError);
    await expect(
      ownerWith(409, { error: 'tender_closed' }).awardTender({ tenderId: 't1' }),
    ).rejects.toMatchObject({
      errorKey: 'tender_closed',
    });
  });
});
