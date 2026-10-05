/** The value, or a test failure naming what was missing. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`test: missing ${what}`);
  return value;
}
