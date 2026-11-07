/**
 * The buyer's status question names the capability the way the supplier's
 * listing declares it (TODO #5). A bare `order_status` was refused by the
 * listing check before it reached the supplier.
 */

import {
  makeServiceQueryStatusAsk,
  ORDER_STATUS_WIRE_CAPABILITY,
} from '../../src/commerce/buyer_status';
import { SUPPLIER_LISTING_BINDINGS } from '../../src/commerce/supplier_listing';

describe('makeServiceQueryStatusAsk', () => {
  it('asks under a capability the supplier listing declares', async () => {
    const dispatch = jest.fn(async () => ({ sent: true }));
    const ask = makeServiceQueryStatusAsk({ dispatch });
    await ask({
      supplierDid: 'did:plc:supplier',
      serviceRkey: 'bakery',
      purchaseOrderId: 'po_1',
      sinceSequence: '2',
    });
    const body = (dispatch.mock.calls[0] as unknown as [{ body: Record<string, unknown> }])[0].body;
    expect(body.capability).toBe(ORDER_STATUS_WIRE_CAPABILITY);
    expect(SUPPLIER_LISTING_BINDINGS.map((b) => b.wire)).toContain(body.capability);
    expect(body).toMatchObject({
      query_id: 'po_1',
      params: { purchase_order_id: 'po_1', since_sequence: '2' },
      service_uri: 'at://did:plc:supplier/com.dinakernel.service.profile/bakery',
    });
  });

  it('reports not sent when a gate refuses', async () => {
    const ask = makeServiceQueryStatusAsk({
      dispatch: async () => ({ sent: false, deniedAt: 'contact' }),
    });
    await expect(
      ask({ supplierDid: 'did:plc:s', serviceRkey: 'r', purchaseOrderId: 'po_2' }),
    ).resolves.toEqual({ sent: false });
  });
});
