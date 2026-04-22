/**
 * Core API contract — request/response schemas, JSON wire format, error
 * response structure.
 *
 * Defines the expected shape of Core HTTP API responses for contract tests.
 * These must match the server's apicontract_test.go behavior exactly.
 *
 * Source: core/test/apicontract_test.go
 */

export interface APIErrorResponse {
  error: string;
  message?: string;
  detail?: string;
}

export interface APIListResponse<T> {
  items: T[];
  total?: number;
  cursor?: string;
}

/**
 * Validate an API error response matches the expected structure.
 * Must have an `error` string field.
 */
export function isValidErrorResponse(body: unknown): body is APIErrorResponse {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.error !== 'string') return false;
  if (obj.error.length === 0) return false;
  // message and detail are optional strings
  if (obj.message !== undefined && typeof obj.message !== 'string') return false;
  if (obj.detail !== undefined && typeof obj.detail !== 'string') return false;
  return true;
}

/**
 * Validate a list response has the expected structure.
 * Must have an `items` array. `total` and `cursor` are optional.
 */
export function isValidListResponse(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.items)) return false;
  if (obj.total !== undefined && typeof obj.total !== 'number') return false;
  if (obj.cursor !== undefined && typeof obj.cursor !== 'string') return false;
  return true;
}

/**
 * Get the expected Content-Type for all API responses.
 * Always application/json for Core API.
 */
export function expectedContentType(): string {
  return 'application/json';
}

/**
 * Validate that unknown routes return 404 with proper error body.
 */
export function isValid404Response(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  if (!isValidErrorResponse(body)) return false;
  // Error message should indicate "not found"
  const errorBody = body as APIErrorResponse;
  return errorBody.error.toLowerCase().includes('not found');
}
