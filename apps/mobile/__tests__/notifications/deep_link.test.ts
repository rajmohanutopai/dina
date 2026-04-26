/**
 * Push-tap deep-link handler (task 5.68 / 5.70 layer 5).
 */

import { handleNotificationTap } from '../../src/notifications/deep_link';

describe('handleNotificationTap', () => {
  let pushed: string[];
  let marked: string[];
  const deps = {
    routerPush: (p: string): void => {
      pushed.push(p);
    },
    markRead: (id: string): boolean => {
      marked.push(id);
      return true;
    },
  };

  beforeEach(() => {
    pushed = [];
    marked = [];
  });

  it('marks the inbox entry read AND routes to deepLink when both present', () => {
    const result = handleNotificationTap(
      { inboxId: 'nt-1', deepLink: 'dina://approvals/abc' },
      deps,
    );
    expect(result).toEqual({ marked: true, navigated: true });
    expect(marked).toEqual(['nt-1']);
    expect(pushed).toEqual(['dina://approvals/abc']);
  });

  it('only marks read when deepLink missing', () => {
    const result = handleNotificationTap({ inboxId: 'nt-2' }, deps);
    expect(result).toEqual({ marked: true, navigated: false });
    expect(pushed).toEqual([]);
  });

  it('only navigates when inboxId missing', () => {
    const result = handleNotificationTap({ deepLink: 'dina://chat/main' }, deps);
    expect(result).toEqual({ marked: false, navigated: true });
    expect(marked).toEqual([]);
    expect(pushed).toEqual(['dina://chat/main']);
  });

  it('is a no-op for empty / null / undefined data', () => {
    expect(handleNotificationTap(null, deps)).toEqual({ marked: false, navigated: false });
    expect(handleNotificationTap(undefined, deps)).toEqual({ marked: false, navigated: false });
    expect(handleNotificationTap({}, deps)).toEqual({ marked: false, navigated: false });
    expect(pushed).toEqual([]);
    expect(marked).toEqual([]);
  });

  it('ignores non-string inboxId / deepLink defensively', () => {
    const result = handleNotificationTap(
      { inboxId: 42, deepLink: { not: 'a string' } },
      deps,
    );
    expect(result).toEqual({ marked: false, navigated: false });
  });

  it('ignores empty-string deepLink', () => {
    const result = handleNotificationTap({ deepLink: '' }, deps);
    expect(result).toEqual({ marked: false, navigated: false });
  });
});
