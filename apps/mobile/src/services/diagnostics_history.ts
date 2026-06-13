/**
 * Diagnostics history — a small, persisted ring of recent boots'
 * degradations + runtime warnings.
 *
 * The live channels (boot_service degradations, runtime_warnings) are
 * in-memory and per-boot, so a PAST boot's "limited mode · N" is otherwise
 * unrecoverable once the app relaunches — you can't tell what degraded, and
 * neither can a user filing a bug report. This persists the last N boot
 * snapshots so the Admin → Diagnostics screen can show history.
 *
 * Storage: the keychain abstraction the rest of the app's small settings use
 * (model_overrides, active_provider). The data is NON-secret — degradation
 * codes/messages only, never vault content or PII (the boot logger already
 * guarantees that). Best-effort: a write failure must never block boot.
 */

import * as Keychain from './keychain';

const SERVICE = 'dina.diag.history';
const USERNAME = 'dina_diag';
const MAX_RECORDS = 12;

export interface DiagEntry {
  code: string;
  message: string;
}

export interface BootDiagRecord {
  /** ms since epoch when the boot reached `ready`. */
  at: number;
  degradations: DiagEntry[];
  warnings: DiagEntry[];
}

function safeParse(raw: string): BootDiagRecord[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as BootDiagRecord[]) : [];
  } catch {
    return [];
  }
}

/** Newest-first list of recent boot snapshots. */
export async function getBootHistory(): Promise<BootDiagRecord[]> {
  const row = await Keychain.getGenericPassword({ service: SERVICE });
  return row === false ? [] : safeParse(row.password);
}

/**
 * Append a boot snapshot (newest first, capped at MAX_RECORDS). Accepts the
 * structural `{code, message}` shape so callers can pass `BootDegradation[]`
 * and `RuntimeWarning[]` directly. `now` is injectable for tests.
 */
export async function recordBoot(
  degradations: readonly DiagEntry[],
  warnings: readonly DiagEntry[],
  now: () => number = Date.now,
): Promise<void> {
  try {
    const prev = await getBootHistory();
    const record: BootDiagRecord = {
      at: now(),
      degradations: degradations.map((d) => ({ code: d.code, message: d.message })),
      warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
    };
    const next = [record, ...prev].slice(0, MAX_RECORDS);
    await Keychain.setGenericPassword(USERNAME, JSON.stringify(next), {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  } catch {
    /* best-effort diagnostics; never block or crash boot */
  }
}

/** Clear the persisted history (Admin action). */
export async function clearBootHistory(): Promise<void> {
  try {
    await Keychain.resetGenericPassword({ service: SERVICE });
  } catch {
    /* ignore */
  }
}
