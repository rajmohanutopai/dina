import { createHash, randomBytes } from 'crypto'

/**
 * Generate a ULID-like unique ID.
 * Uses timestamp prefix + random suffix for sortability.
 */
export function generateUlid(): string {
  const timestamp = Date.now().toString(36).padStart(10, '0')
  const random = randomBytes(10).toString('hex').slice(0, 16)
  return `${timestamp}${random}`
}

/**
 * Generate a deterministic SHA-256 hash with prefix.
 */
export function deterministicHash(input: string, prefix: string = 'sub'): string {
  const hash = createHash('sha256').update(input).digest('hex').slice(0, 32)
  return `${prefix}_${hash}`
}
