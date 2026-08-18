/**
 * Client↔route parity smoke: every InProcessOwnerCommerceClient method
 * must land on a REGISTERED route. The router answers an unknown path
 * with `no route for …` — so each method is driven against a router
 * with the commerce routes registered and NO runtime, and the failure
 * it produces must be anything BUT route absence. A renamed route or a
 * client typo fails here before a phone ever dials it.
 */

import {
  InProcessOwnerCommerceClient,
  OwnerCommerceHttpError,
} from '../../src/client/owner-commerce-client';
import { installCommerceRuntime } from '../../src/commerce/runtime';
import { CoreRouter } from '../../src/server/router';
import { registerCommerceRoutes } from '../../src/server/routes/commerce';

const OWNER_CAP = 'test-owner-capability-secret';

let client: InProcessOwnerCommerceClient;

beforeEach(() => {
  const router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
  installCommerceRuntime(null); // every handler must answer 503, never 404
  client = new InProcessOwnerCommerceClient(router, OWNER_CAP);
});

afterEach(() => installCommerceRuntime(null));

/** Call it; the route must exist whatever else goes wrong. */
async function expectRouted(call: () => Promise<unknown>, name: string): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (err instanceof OwnerCommerceHttpError) {
      expect({ name, message: err.message }).not.toMatchObject({
        name,
        message: expect.stringContaining('no route for'),
      });
      return;
    }
    throw err;
  }
}

const B64 = 'aGVsbG8=';
const HEX = 'a'.repeat(64);

const CALLS: [string, () => Promise<unknown>][] = [
  ['listDrafts', () => client.listDrafts('main')],
  ['photoCapture', () => client.photoCapture('main', [B64])],
  ['photoExtract', () => client.photoExtract({ catalogId: 'main', draftId: 'd', authorizationId: 'a' })],
  ['repair', () => client.repair({ draftId: 'd', row: 0, column: 'name', value: 'x' })],
  ['accept', () => client.accept('d', ['name'])],
  ['edit', () => client.edit({ draftId: 'd', field: 'name', value: 'x' })],
  ['provePresence', () => client.provePresence('pass')],
  ['confirm', () => client.confirm('d')],
  ['prepare', () => client.prepare('d')],
  ['approve', () => client.approve('d', HEX)],
  ['publish', () => client.publish('d')],
  ['erase', () => client.erase('d')],
  ['photoPage', () => client.photoPage('art-1')],
  ['orderPhotoCapture', () => client.orderPhotoCapture([B64])],
  ['orderPhotoExtract', () => client.orderPhotoExtract({ draftId: 'd', authorizationId: 'a' })],
  ['orderDrafts', () => client.orderDrafts()],
  ['orderDraft', () => client.orderDraft('d')],
  ['orderRepairLine', () => client.orderRepairLine({ draftId: 'd', lineId: 'l', field: 'quantity', value: '1' })],
  ['orderResolveLine', () => client.orderResolveLine({ draftId: 'd', lineId: 'l', resolution: { kind: 'unresolved' } as never })],
  ['orderDeferLine', () => client.orderDeferLine('d', 'l')],
  ['orderAcceptFields', () => client.orderAcceptFields('d', [{ lineId: 'l', field: 'quantity' }])],
  ['orderRequirement', () => client.orderRequirement({ draftId: 'd', key: 'r1', action: 'accept' })],
  ['orderConfirm', () => client.orderConfirm('d')],
  ['orderReopen', () => client.orderReopen('d', 'c')],
  ['orderAbandon', () => client.orderAbandon('d')],
  ['orderRequestQuote', () => client.orderRequestQuote({ draftId: 'd', supplierDid: 'did:x', projection: {} })],
  ['orderApprove', () => client.orderApprove({ draftId: 'd', conversationId: 'c', quoteId: 'q', projection: {} })],
  ['orderSubmit', () => client.orderSubmit({ draftId: 'd', conversationId: 'c' })],
  ['tradeInbox', () => client.tradeInbox()],
  ['tradeStatement', () => client.tradeStatement('did:x', 'INR')],
  ['tradeStatement+role', () => client.tradeStatement('did:x', 'INR', 'supplier')],
  ['issueDeliveryNote', () => client.issueDeliveryNote({ counterpartyDid: 'did:x', purchaseOrderId: 'po', supplierOrderId: 'so', lines: [] })],
  ['issueDeliveryReceipt', () => client.issueDeliveryReceipt({ deliveryNoteDigest: HEX, lines: [] })],
  ['issuePaymentNote', () => client.issuePaymentNote({ supplierDid: 'did:x', amount: { currency: 'INR', minor_units: '1' }, method: 'cash' })],
  ['acknowledgePayment', () => client.acknowledgePayment({ paymentNoteDigest: HEX, kind: 'received', amountReceived: { currency: 'INR', minor_units: '1' } })],
  ['booksExport', () => client.booksExport('INR')],
  ['mintInvite', () => client.mintInvite({ direction: 'you_supply_me', serviceRkeys: ['self'] })],
  ['redeemInvite', () => client.redeemInvite({ code: 'dinainvite1:x', serviceRkeys: ['self'] })],
  ['sendInvite', () => client.sendInvite({ nonce: 'f'.repeat(32), toDid: 'did:x' })],
  ['listInvites', () => client.listInvites()],
  ['acceptHeldInvite', () => client.acceptHeldInvite({ nonce: 'f'.repeat(32), serviceRkeys: ['self'] })],
  ['createStaffGrant', () => client.createStaffGrant({ deviceDid: 'did:x', scope: 'commerce_confirm', installs: 'both', pin: '4321' })],
  ['listStaffGrants', () => client.listStaffGrants('did:x')],
  ['revokeStaffGrants', () => client.revokeStaffGrants('did:x')],
];

describe('every client method reaches a registered route', () => {
  it.each(CALLS)('%s', async (name, call) => {
    await expectRouted(call, name);
  });
});
