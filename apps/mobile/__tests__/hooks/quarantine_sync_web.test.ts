/**
 * The web chat finds quarantined messages by asking Core. It mounts before the
 * browser is connected as the owner, so its first look can get a 401, and a
 * stranger can write while the page is open. Found by the MRS-05 browser suite.
 */

import { getThread, resetThreads } from '@dina/brain/chat';

import { QUARANTINE_POLL_MS, syncQuarantineCards } from '../../src/hooks/quarantine_sync.web';
import { brainFetch } from '../../src/services/web_runtime';

jest.mock('../../src/services/web_runtime', () => ({ brainFetch: jest.fn() }));

const fetchMock = brainFetch as jest.Mock;

const answer = (status: number, ids: string[] = []) => ({
  ok: status === 200,
  status,
  json: async () => ({
    messages: ids.map((id) => ({
      id,
      senderDID: 'did:plc:stranger',
      messageType: 'coordination.request',
      body: '',
      receivedAt: 1,
    })),
  }),
});

const cards = (): string[] =>
  getThread('main').flatMap((m) => {
    const lc = m.metadata?.lifecycle as { quarantineId?: string } | undefined;
    return lc?.quarantineId !== undefined ? [lc.quarantineId] : [];
  });

describe('web quarantine sync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock.mockReset();
    resetThreads();
  });
  afterEach(() => jest.useRealTimers());

  it('a card appears once the browser connects, without a reload', async () => {
    fetchMock.mockResolvedValueOnce(answer(401)).mockResolvedValue(answer(200, ['q-1']));
    const stop = syncQuarantineCards('main');
    await jest.advanceTimersByTimeAsync(0);
    expect(cards()).toEqual([]);

    await jest.advanceTimersByTimeAsync(QUARANTINE_POLL_MS);
    expect(cards()).toEqual(['q-1']);
    stop();
  });

  it('a message arriving while the chat is open shows, and only once', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(200, ['q-1']))
      .mockResolvedValue(answer(200, ['q-1', 'q-2']));
    const stop = syncQuarantineCards('main');
    await jest.advanceTimersByTimeAsync(QUARANTINE_POLL_MS * 3);
    expect(cards()).toEqual(['q-1', 'q-2']);
    stop();
  });

  it('stops looking when the chat closes', async () => {
    fetchMock.mockResolvedValue(answer(200));
    const stop = syncQuarantineCards('main');
    await jest.advanceTimersByTimeAsync(0);
    const before = fetchMock.mock.calls.length;
    stop();
    await jest.advanceTimersByTimeAsync(QUARANTINE_POLL_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('a peer thread never asks', async () => {
    const stop = syncQuarantineCards('did:plc:peer');
    await jest.advanceTimersByTimeAsync(QUARANTINE_POLL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    stop();
  });
});
