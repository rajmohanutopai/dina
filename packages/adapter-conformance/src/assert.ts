/**
 * Tiny built-in assertion helpers for the conformance kit.
 *
 * Deliberately NOT jest `expect` — the kit must run inside the React Native
 * bundle (the in-app device runner), where jest does not exist. Every helper
 * throws a `ConformanceAssertionError` with a descriptive message on failure;
 * a runner turns those into a red jest `it()` (node) or a rendered FAIL row
 * (device). Pure: no node:* imports, no globals beyond `Uint8Array`.
 */

export class ConformanceAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceAssertionError';
  }
}

/** Render a value compactly for failure messages (bytes-aware). */
function format(value: unknown): string {
  if (value instanceof Uint8Array) {
    const head = Array.from(value.slice(0, 8)).join(',');
    return `Uint8Array(${value.length})[${head}${value.length > 8 ? ',…' : ''}]`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceAssertionError(message);
}

/** Strict equality (`Object.is`) — catches NaN and ±0 correctly. */
export function assertEqual(actual: unknown, expected: unknown, message = 'assertEqual'): void {
  if (!Object.is(actual, expected)) {
    throw new ConformanceAssertionError(
      `${message}: expected ${format(expected)}, got ${format(actual)}`,
    );
  }
}

/**
 * Byte-exact equality for binary values. Also asserts `actual` is genuinely a
 * `Uint8Array` (NOT an `ArrayBuffer`) — the exact blob-coercion divergence the
 * suite exists to catch on op-sqlite.
 */
export function assertBytesEqual(
  actual: unknown,
  expected: Uint8Array,
  message = 'assertBytesEqual',
): void {
  assert(
    actual instanceof Uint8Array,
    `${message}: value is not a Uint8Array (got ${
      actual === null ? 'null' : (actual as { constructor?: { name?: string } })?.constructor?.name ?? typeof actual
    })`,
  );
  const bytes = actual as Uint8Array;
  assertEqual(bytes.length, expected.length, `${message}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (bytes[i] !== expected[i]) {
      throw new ConformanceAssertionError(
        `${message}: byte ${i} expected ${expected[i]}, got ${bytes[i]}`,
      );
    }
  }
}

/** Assert the synchronous `fn` throws; returns the caught error for inspection. */
export function assertThrowsSync(fn: () => unknown, message = 'assertThrowsSync'): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new ConformanceAssertionError(`${message}: expected a throw, but none occurred`);
}

/** Assert the (possibly async) `fn` rejects/throws; returns the caught error. */
export async function assertThrows(
  fn: () => unknown | Promise<unknown>,
  message = 'assertThrows',
): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new ConformanceAssertionError(`${message}: expected a throw, but none occurred`);
}

/** Lower-cased message of any thrown value (for tolerant error-shape checks). */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.toLowerCase();
  return String(err).toLowerCase();
}
