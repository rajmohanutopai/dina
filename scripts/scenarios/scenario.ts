/**
 * What a scenario is, and the context it runs in (docs/REAL_LIFE_SCENARIOS.md).
 */

import { randomBytes } from 'node:crypto';

import { judge } from './judge';

import type { ChatResult, Dina } from './client';
import type { NodeName } from './fleet';

/**
 * phone: works only in the phone app (skipped here).
 * gap: not built (runs; expected to fail until built).
 * harness: this runner cannot drive it yet (skipped, said why in `reason`).
 */
export type Mark = 'phone' | 'gap' | 'harness';

export interface Scenario {
  /** Catalogue id, e.g. "A1". */
  id: string;
  title: string;
  mark?: Mark;
  /** Why a phone/harness scenario is skipped. */
  reason?: string;
  run(ctx: Ctx): Promise<void>;
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
  kind: 'state' | 'reply' | 'judge';
}

export interface TurnRecord {
  node: string;
  said: string;
  reply: string;
  ms: number;
}

/** Everything a scenario needs: the four Dinas, checks, a judge, a transcript. */
export class Ctx {
  readonly checks: Check[] = [];
  readonly turns: TurnRecord[] = [];
  /** A short tag unique to this scenario run, for threads and markers. */
  readonly tag = randomBytes(3).toString('hex');

  constructor(
    readonly id: string,
    readonly dinas: Record<NodeName, Dina>,
  ) {}

  get alonso(): Dina {
    return this.dinas.alonso;
  }
  get sancho(): Dina {
    return this.dinas.sancho;
  }
  get albert(): Dina {
    return this.dinas.albert;
  }
  get chairmaker(): Dina {
    return this.dinas.chairmaker;
  }

  /** This scenario's own chat thread on a node (a fresh conversation). */
  thread(name = 'main'): string {
    return `sc-${this.id}-${this.tag}-${name}`;
  }

  /** Say something to a Dina in this scenario's thread; records the turn. */
  async say(dina: Dina, text: string, opts: { thread?: string; timeoutMs?: number } = {}): Promise<ChatResult> {
    const t0 = Date.now();
    const r = await dina.chat(text, {
      threadId: opts.thread ?? this.thread(),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    this.turns.push({ node: dina.name, said: text, reply: r.reply, ms: Date.now() - t0 });
    return r;
  }

  check(name: string, pass: boolean, detail = '', kind: Check['kind'] = 'state'): boolean {
    this.checks.push({ name, pass, detail, kind });
    return pass;
  }

  /** A fixed string or pattern in a reply. */
  expectReply(name: string, reply: string, pattern: RegExp | string): boolean {
    const pass = typeof pattern === 'string' ? reply.includes(pattern) : pattern.test(reply);
    return this.check(name, pass, pass ? '' : `reply: ${reply.slice(0, 200)}`, 'reply');
  }

  /** The judge's verdict on one reply against one criterion. */
  async judge(name: string, asked: string, reply: string, criterion: string): Promise<boolean> {
    const v = await judge({ asked, reply, criterion });
    return this.check(name, v.pass, v.reason, 'judge');
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Poll `probe` until it returns a value (or true), up to `ms`. */
  async eventually<T>(probe: () => Promise<T | undefined | false>, ms: number, everyMs = 2_000): Promise<T | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await probe();
      if (v !== undefined && v !== false) return v;
      if (Date.now() > end) return undefined;
      await this.sleep(everyMs);
    }
  }
}

/** A due time `days` ahead at `hour`:00 local, as epoch ms. */
export function dayAt(days: number, hour: number, minute = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}
