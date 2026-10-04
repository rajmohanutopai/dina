/**
 * Wakes what waits on an inbound task's next visible change (design §7.5):
 * a `SendMessage` that waits for its task to end or ask (A2A
 * `returnImmediately` false). `recordInboundChange`, the one writer of a
 * task's events, signals each change it records.
 *
 * A wake only says "look again": the waiter reads the task afresh, so a
 * change signalled inside a transaction that later rolls back costs one
 * read and nothing else. The signal is per store, so every runtime over
 * the one store shares it.
 */

import type { A2AStore } from './store';

export class InboundChangeSignal {
  private readonly waiting = new Map<number, Set<() => void>>();

  /** Wake everything waiting on the task. */
  notify(opId: number): void {
    const wakers = this.waiting.get(opId);
    if (wakers === undefined) return;
    this.waiting.delete(opId);
    for (const wake of wakers) wake();
  }

  /** Resolves at the task's next signalled change, or after `ms`, whichever comes first. */
  next(opId: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const wakers = this.waiting.get(opId);
        wakers?.delete(wake);
        if (wakers?.size === 0) this.waiting.delete(opId);
        resolve();
      }, ms);
      // Node's timers hold the process open unless unref'd; Hermes' are numbers with no unref.
      (timer as { unref?: () => void }).unref?.();
      let wakers = this.waiting.get(opId);
      if (wakers === undefined) {
        wakers = new Set();
        this.waiting.set(opId, wakers);
      }
      wakers.add(wake);
    });
  }

  /** How many tasks have a waiter now. */
  get size(): number {
    return this.waiting.size;
  }
}

const signals = new WeakMap<A2AStore, InboundChangeSignal>();

/** The store's change signal. */
export function inboundChangeSignal(store: A2AStore): InboundChangeSignal {
  let signal = signals.get(store);
  if (signal === undefined) {
    signal = new InboundChangeSignal();
    signals.set(store, signal);
  }
  return signal;
}
