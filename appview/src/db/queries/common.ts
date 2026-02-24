import { CONSTANTS } from '@/config/constants.js'

/**
 * Shared pagination helpers for database queries.
 */

export interface PaginationParams {
  /** Maximum number of results to return */
  limit: number
  /** Opaque cursor for keyset pagination */
  cursor?: string
}

export interface PaginatedResult<T> {
  items: T[]
  cursor?: string
}

/**
 * Normalize pagination parameters with safety bounds.
 * Clamps limit to MAX_PAGE_SIZE and defaults to DEFAULT_PAGE_SIZE.
 */
export function buildPagination(params: Partial<PaginationParams>): PaginationParams {
  return {
    limit: Math.min(
      Math.max(params.limit ?? CONSTANTS.DEFAULT_PAGE_SIZE, 1),
      CONSTANTS.MAX_PAGE_SIZE,
    ),
    cursor: params.cursor,
  }
}

/**
 * Encode a cursor value for client consumption.
 * Uses base64url encoding of the raw value.
 */
export function encodeCursor(value: string | number | Date): string {
  const raw = value instanceof Date ? value.toISOString() : String(value)
  return Buffer.from(raw).toString('base64url')
}

/**
 * Decode a cursor value from client input.
 * Returns the raw string or null if the cursor is invalid.
 */
export function decodeCursor(cursor: string): string | null {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf-8')
  } catch {
    return null
  }
}
