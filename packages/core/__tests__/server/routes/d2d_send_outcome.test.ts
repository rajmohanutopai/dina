/**
 * COMMITMENT_KERNEL §15 step 6 — a host's sender result, as Core judges it:
 * a message that went nowhere (sent, but neither delivered, buffered nor
 * queued) is passed on as such, never counted as sent.
 */

import { sendOutcomeOf } from '../../../src/server/routes/d2d_msg';

describe('sendOutcomeOf', () => {
  it('passes on what the sender reports', () => {
    expect(
      sendOutcomeOf({
        sent: true,
        messageId: 'm1',
        delivered: false,
        buffered: false,
        queued: false,
      }),
    ).toEqual({ messageId: 'm1', delivered: false, buffered: false, queued: false });
    expect(
      sendOutcomeOf({ messageId: 'm2', delivered: false, buffered: false, queued: true })?.queued,
    ).toBe(true);
  });
  it('says nothing for a result that reports nothing', () => {
    expect(sendOutcomeOf(undefined)).toBeUndefined();
    expect(sendOutcomeOf({ ok: true })).toBeUndefined();
  });
});
