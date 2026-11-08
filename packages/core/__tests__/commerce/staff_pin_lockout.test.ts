/**
 * The PIN lockout counts guesses, not bursts (docs/STATE_MACHINES.md COM-5).
 */

import {
  InMemoryStaffPinRepository,
  STAFF_PIN_MAX_FAILURES,
  setStaffPin,
  verifyStaffPinGated,
} from '../../src/commerce/staff_pins';

const T = 2_000;

async function seeded(): Promise<InMemoryStaffPinRepository> {
  const repo = new InMemoryStaffPinRepository();
  await setStaffPin(repo, 'd', '123456', 1_000);
  return repo;
}

describe('COM-5: concurrent PIN guesses', () => {
  it('a burst locks the device, and the right PIN after it is refused', async () => {
    const repo = await seeded();
    const results = await Promise.all(
      Array.from({ length: STAFF_PIN_MAX_FAILURES + 1 }, (_, i) =>
        verifyStaffPinGated(repo, 'd', `wrong${String(i)}`, T),
      ),
    );
    expect(results.every((r) => !r)).toBe(true);
    expect(repo.getAttempts('d').lockedUntil).toBeGreaterThan(T);
    expect(await verifyStaffPinGated(repo, 'd', '123456', T)).toBe(false);
  }, 60_000);

  it('a guess past the limit never reaches the KDF: at most the limit is tried per lock', async () => {
    const repo = await seeded();
    const read = jest.spyOn(repo, 'get');
    await Promise.all(
      Array.from({ length: STAFF_PIN_MAX_FAILURES * 3 }, (_, i) =>
        verifyStaffPinGated(repo, 'd', `wrong${String(i)}`, T),
      ),
    );
    expect(read).toHaveBeenCalledTimes(STAFF_PIN_MAX_FAILURES);
  }, 60_000);

  it('alone, the owner of the PIN is unaffected: a right PIN clears the count', async () => {
    const repo = await seeded();
    expect(await verifyStaffPinGated(repo, 'd', 'wrong', T)).toBe(false);
    expect(repo.getAttempts('d').failedCount).toBe(1);
    expect(await verifyStaffPinGated(repo, 'd', '123456', T)).toBe(true);
    expect(repo.getAttempts('d')).toEqual({ failedCount: 0, lockedUntil: 0 });
  }, 60_000);

  it('the attempt is on record before the KDF runs, so a crash mid-guess still counts', async () => {
    const repo = await seeded();
    const pending = verifyStaffPinGated(repo, 'd', 'wrong', T);
    expect(repo.getAttempts('d').failedCount).toBe(1);
    await pending;
    expect(repo.getAttempts('d').failedCount).toBe(1);
  }, 60_000);
});
