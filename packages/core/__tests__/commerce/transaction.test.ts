/**
 * The commerce transaction coordinator (ARCH-0b / ARCH-0c — WS-0.2b, WS-0.3b).
 *
 * The bug this class exists to make loud: op-sqlite implements transactions
 * with a raw `BEGIN` and cannot nest, so a domain method that opened one while
 * already inside another failed ON MOBILE ONLY — while the reentrant server
 * test runner passed. Two hand-written comments used to warn callers about
 * that, which is the shape of a rule with no enforcement.
 */

import { CommerceTransaction } from '../../src/commerce/transaction';

/** A runner that just calls through, like the server's reentrant one. */
const reentrant = (fn: () => void): void => {
  fn();
};

describe('one boundary at a time', () => {
  it('runs the body inside the runner and returns its value', () => {
    const seen: string[] = [];
    const tx = new CommerceTransaction((fn) => {
      seen.push('begin');
      fn();
      seen.push('commit');
    });
    const result = tx.atomically('admitOrder', () => {
      seen.push('body');
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual(['begin', 'body', 'commit']);
  });

  it('refuses a nested boundary and names BOTH operations', () => {
    const tx = new CommerceTransaction(reentrant);
    expect(() =>
      tx.atomically('admitOrder', () => tx.atomically('decideOrder', () => null)),
    ).toThrow(/decideOrder cannot open a transaction inside admitOrder/);
  });

  it('refuses on a reentrant runner, which is where the bug used to hide', () => {
    // The server's runner calls through, so nesting SUCCEEDS at the SQLite
    // level and the mistake only surfaces on a phone. The coordinator makes
    // it fail here instead.
    const tx = new CommerceTransaction(reentrant);
    let inner = 'not reached';
    try {
      tx.atomically('outer', () => {
        tx.atomically('inner', () => {
          inner = 'reached';
        });
      });
    } catch {
      // expected
    }
    expect(inner).toBe('not reached');
  });

  it('releases the boundary when the body throws', () => {
    // Without the `finally`, one failed operation would make every later one
    // report a nesting error and the node would look deadlocked.
    const tx = new CommerceTransaction(reentrant);
    expect(() =>
      tx.atomically('decideOrder', () => {
        throw new Error('domain refused');
      }),
    ).toThrow('domain refused');
    expect(tx.isOpen).toBe(false);
    expect(tx.atomically('decideOrder', () => 'fine')).toBe('fine');
  });

  it('releases the boundary when the RUNNER throws', () => {
    // A rollback surfaces as a throw from the runner rather than the body,
    // and the coordinator must not stay latched on that path either.
    const tx = new CommerceTransaction(() => {
      throw new Error('rollback');
    });
    expect(() => tx.atomically('signGenesis', () => null)).toThrow('rollback');
    expect(tx.isOpen).toBe(false);
  });

  it('reports whether a boundary is open', () => {
    const tx = new CommerceTransaction(reentrant);
    expect(tx.isOpen).toBe(false);
    tx.atomically('reconcile', () => {
      expect(tx.isOpen).toBe(true);
      return null;
    });
    expect(tx.isOpen).toBe(false);
  });

  it('allows two boundaries in sequence', () => {
    const tx = new CommerceTransaction(reentrant);
    expect(tx.atomically('a', () => 1)).toBe(1);
    expect(tx.atomically('b', () => 2)).toBe(2);
  });

  it('carries an undefined result through rather than inventing one', () => {
    // `undefined` is a legal return for some callers, so it must survive the
    // closure the runner's void callback forces.
    const tx = new CommerceTransaction(reentrant);
    expect(tx.atomically('markEffectStarted', () => undefined)).toBeUndefined();
  });

  it('does not run the body when the runner never calls it', () => {
    // A runner that refuses to begin (a locked database) must not leave the
    // caller believing the body ran.
    let ran = false;
    const tx = new CommerceTransaction(() => {
      /* never invokes the callback */
    });
    const result = tx.atomically('admitOrder', () => {
      ran = true;
      return 'value';
    });
    expect(ran).toBe(false);
    expect(result).toBeUndefined();
    expect(tx.isOpen).toBe(false);
  });
});
