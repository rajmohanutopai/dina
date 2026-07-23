/**
 * Item 2 — single-use bootstrap enrolment capability (§8, DPD-005 / F-03).
 *
 * On a genuine first boot, Core mints ONE single-use pairing code (role
 * `agent`) and hands it to the plugin that spawned it, over a process-bound
 * handoff — an inherited file descriptor — NOT a 0600 file. A 0600 file loses
 * to a same-UID race (another process running as you could read + redeem it);
 * the inherited fd is only visible to the verified parent/child pair (§8).
 *
 * The code is enrolment AUTHORITY, so it is never logged. The plugin redeems
 * it via `/v1/pair/complete` with its own public key to register as an `agent`
 * device (the `coding` agent_scope is stamped at redemption once item 6b lands;
 * role `agent` is the current authority level).
 *
 * Honest residual (§16): the handoff defends against UNRELATED co-resident
 * processes. A same-UID process that has ALREADY compromised the plugin cannot
 * be fully defeated on one machine — that limit is stated, not hidden.
 */

import * as fs from 'node:fs';

import { generatePairingCode } from '@dina/core';

/** Env var naming the inherited write-end fd the plugin passed on spawn. */
export const HANDOFF_FD_ENV = 'DINA_BOOTSTRAP_HANDOFF_FD';

/** Default device label for the enrolling coding plugin. */
export const DEFAULT_BOOTSTRAP_DEVICE_NAME = 'coding-plugin';

/**
 * A one-shot, write-then-close delivery channel to the parent process. The
 * real implementation writes to an inherited fd; tests inject a fake that
 * captures what was written.
 */
export interface BootstrapHandoff {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface DeliverBootstrapOptions {
  /** True only on a genuine first install (identity.kind === 'generated'). */
  firstBoot: boolean;
  /** The process-bound delivery channel, or null when none was inherited. */
  handoff: BootstrapHandoff | null;
  /** Injectable mint fn — defaults to the ceremony's `generatePairingCode`. */
  generate?: typeof generatePairingCode;
  /** Device label for the enrolling plugin. */
  deviceName?: string;
}

export interface DeliverBootstrapResult {
  /** Whether a capability was minted and handed off. */
  delivered: boolean;
  /** Why nothing was delivered (metadata; safe to log). */
  reason?: 'not_first_boot' | 'no_handoff_channel';
  /** Expiry of the delivered code (metadata; the code itself is never returned/logged). */
  expiresAt?: number;
}

/**
 * Mint + deliver the single-use bootstrap enrolment capability. Idempotent by
 * construction: only a genuine first boot mints, and the code is single-use
 * (the ceremony marks it consumed on redemption). The plaintext code is written
 * ONLY to the handoff — never returned to the caller and never logged.
 */
export async function deliverBootstrapCapability(
  opts: DeliverBootstrapOptions,
): Promise<DeliverBootstrapResult> {
  if (!opts.firstBoot) return { delivered: false, reason: 'not_first_boot' };
  if (opts.handoff === null) return { delivered: false, reason: 'no_handoff_channel' };

  const generate = opts.generate ?? generatePairingCode;
  // Item C — the bootstrap capability enrols a CODING agent (Claude Code /
  // Codex), so stamp `agent_scope='coding'` at initiate. It travels through the
  // pairing intent to registration, and Core later derives `req.agentScope`
  // from the device record — this is what unlocks the coding tool façades.
  const { code, expiresAt } = generate({
    role: 'agent',
    scope: 'coding',
    deviceName: opts.deviceName ?? DEFAULT_BOOTSTRAP_DEVICE_NAME,
  });

  try {
    // The code is enrolment authority — it goes to the inherited fd only.
    await opts.handoff.write(`${JSON.stringify({ code, expiresAt })}\n`);
  } finally {
    // Always close the channel so the plugin's read() unblocks even if the
    // write failed part-way.
    await opts.handoff.close();
  }
  return { delivered: true, expiresAt };
}

/**
 * Resolve the process-bound handoff from the inherited fd named in
 * `DINA_BOOTSTRAP_HANDOFF_FD`. Returns null when the env var is absent or
 * invalid — a boot NOT spawned by an enrolling plugin (dev / standalone), where
 * no first-agent enrolment is expected and devices pair via the normal
 * admin/owner flow instead. The parent (plugin) opened the write end and passed
 * the fd number on spawn.
 */
export function resolveHandoffFromEnv(env: NodeJS.ProcessEnv): BootstrapHandoff | null {
  const raw = (env[HANDOFF_FD_ENV] ?? '').trim();
  if (raw === '') return null;
  const fd = Number(raw);
  // Reject non-integers and the standard streams (0/1/2 are never a private
  // handoff channel — refuse to write a secret to stdin/stdout/stderr).
  if (!Number.isInteger(fd) || fd < 3) return null;

  const stream = fs.createWriteStream('', { fd, autoClose: true });
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        stream.write(data, (err) => (err ? reject(err) : resolve()));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(() => resolve());
      }),
  };
}
