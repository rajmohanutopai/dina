/**
 * WEB_OWNER_SURFACE_PLAN §3.5 — the web approval inbox reads and decides on
 * Core as the owner device, never through Brain.
 *
 * Pinned: each inbox call is one owner request to the Core route the phone
 * reaches in-process; a browser not connected says where to connect; a
 * refusal carries Core's own reason; every card kind is decidable.
 */

const mockSent: OwnerRequest[] = [];
let mockAnswer: (req: OwnerRequest) => CoreResponse = () => ({ status: 200, body: {} });
const mockDispatcher: OwnerDispatcher = {
  dispatch: async (req) => {
    mockSent.push(req);
    return mockAnswer(req);
  },
};
jest.mock('../../src/services/owner_dispatcher', () => ({
  getOwnerDispatcher: () => mockDispatcher,
}));

import {
  OWNER_DECIDES_ON_THIS_SURFACE,
  OwnerInboxError,
  resolveInboxCoreClient,
} from '../../src/services/inbox_client_resolver.web';

import type { InboxCoreClient } from '../../src/hooks/useServiceInbox';
import type { CoreResponse, OwnerDispatcher, OwnerRequest } from '@dina/core';

const inbox = resolveInboxCoreClient({} as InboxCoreClient);
const task = { id: 'card-1', kind: 'approval', status: 'pending_approval' };

beforeEach(() => {
  mockSent.length = 0;
  mockAnswer = () => ({ status: 200, body: {} });
});

it('every card kind is decidable on this surface', () => {
  expect(OWNER_DECIDES_ON_THIS_SURFACE).toBe(true);
});

it('each call is one owner request to Core’s own route', async () => {
  mockAnswer = (req) => {
    if (req.path === '/v1/workflow/tasks')
      return { status: 200, body: { tasks: [task], count: 1 } };
    if (req.path === '/v1/service/respond') {
      return { status: 200, body: { status: 'sent', task_id: 'card-1' } };
    }
    return { status: 200, body: { task } };
  };
  expect(
    await inbox.listWorkflowTasks({ kind: 'approval', state: 'pending_approval', limit: 50 }),
  ).toEqual([task]);
  expect(await inbox.getWorkflowTask('card-1')).toEqual(task);
  expect(await inbox.approveWorkflowTask('card-1', { scope: 'single' } as never)).toEqual(task);
  expect(await inbox.cancelWorkflowTask('card-1', 'not now')).toEqual(task);
  expect(await inbox.sendServiceRespond('card-1', { status: 'unavailable' } as never)).toEqual({
    status: 'sent',
    taskId: 'card-1',
    alreadyProcessed: false,
  });
  expect(mockSent).toEqual([
    {
      method: 'GET',
      path: '/v1/workflow/tasks',
      query: { kind: 'approval', state: 'pending_approval', limit: '50' },
    },
    { method: 'GET', path: '/v1/workflow/tasks/card-1' },
    { method: 'POST', path: '/v1/workflow/tasks/card-1/approve', body: { scope: 'single' } },
    { method: 'POST', path: '/v1/workflow/tasks/card-1/cancel', body: { reason: 'not now' } },
    {
      method: 'POST',
      path: '/v1/service/respond',
      body: { task_id: 'card-1', response_body: { status: 'unavailable' } },
    },
  ]);
});

it('an id is one path segment, whatever it contains', async () => {
  mockAnswer = () => ({ status: 200, body: { task } });
  await inbox.getWorkflowTask('a/../b');
  expect(mockSent[0].path).toBe('/v1/workflow/tasks/a%2F..%2Fb');
});

it('a card that is gone reads as null', async () => {
  mockAnswer = () => ({ status: 404, body: { error: 'task not found' } });
  expect(await inbox.getWorkflowTask('gone')).toBeNull();
});

it('a browser not connected is told where to connect', async () => {
  mockAnswer = () => ({ status: 401, body: { error: 'owner_device_not_connected' } });
  const failure = inbox.listWorkflowTasks({ kind: 'approval', state: 'pending_approval' });
  await expect(failure).rejects.toBeInstanceOf(OwnerInboxError);
  await expect(failure).rejects.toThrow(/Settings → Owner access/);
});

it('a refusal carries Core’s own reason (the web has no Alert)', async () => {
  mockAnswer = () => ({
    status: 403,
    body: { error: 'no_user_presence', detail: 'enter your passphrase to record a payment' },
  });
  await expect(inbox.approveWorkflowTask('card-1')).rejects.toMatchObject({
    errorKey: 'no_user_presence',
    status: 403,
    message: 'Could not approve: enter your passphrase to record a payment',
  });
});
