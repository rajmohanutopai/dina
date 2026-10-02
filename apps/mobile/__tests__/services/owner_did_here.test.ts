/**
 * Whose own PeerLens reviews decide first when Ask for quotes sets suppliers
 * aside. The phone uses its booted node; the browser boots none, and used to
 * apply only the network rule — it now uses the Home Node it is connected to
 * as an owner device (`home_did`).
 */

let mockBooted: { did: string } | null = null;
let mockHome: string | null = null;
let mockStatusThrows = false;
jest.mock('../../src/hooks/useNodeBootstrap', () => ({ getBootedNode: () => mockBooted }));
jest.mock('../../src/services/owner_setup_client', () => ({
  getOwnerSetupClient: () => ({
    status: async () => {
      if (mockStatusThrows) throw new Error('not connected');
      return { home_did: mockHome };
    },
  }),
}));

import { ownerDidHere } from '../../src/services/supplier_finder';

beforeEach(() => {
  mockBooted = null;
  mockHome = null;
  mockStatusThrows = false;
});

it('the phone: its booted node', async () => {
  mockBooted = { did: 'did:plc:phone' };
  mockHome = 'did:plc:other';
  expect(await ownerDidHere()).toBe('did:plc:phone');
});

it('the browser: the Home Node it is connected to', async () => {
  mockHome = 'did:plc:homenode';
  expect(await ownerDidHere()).toBe('did:plc:homenode');
});

it('neither known (a browser not connected): none, so only the network rule applies', async () => {
  mockStatusThrows = true;
  expect(await ownerDidHere()).toBeNull();
});
