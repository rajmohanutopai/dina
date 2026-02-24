/**
 * Process items in batches of a given size.
 *
 * @param items  - The full array of items to process.
 * @param batchSize - Maximum items per batch.
 * @param fn - Async callback invoked once per batch with the slice.
 */
export async function batchProcess<T>(
  items: T[],
  batchSize: number,
  fn: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    await fn(batch)
  }
}
