import { logger } from './logger.js'

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

/**
 * Retry a function with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30_000 } = options

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === maxRetries) throw err

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs)
      logger.warn({ attempt, delay, err }, 'Retrying after error')
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw new Error('Unreachable')
}
