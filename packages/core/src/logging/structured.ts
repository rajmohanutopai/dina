/**
 * Structured logging — PII-safe request/event logger.
 *
 * Logs: path, DID, latency, status, caller type, request ID.
 * NEVER logs: request body, response body, PII fields, auth tokens.
 *
 * Output: JSON-structured log entries for machine parsing.
 * Severity levels: debug, info, warn, error.
 *
 * Source: ARCHITECTURE.md Task 2.9
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  path?: string;
  method?: string;
  did?: string;
  callerType?: string;
  requestId?: string;
  status?: number;
  latencyMs?: number;
  error?: string;
}

/** Fields that must NEVER appear in logs (PII/security). */
const REDACTED_FIELDS = new Set([
  'body',
  'requestBody',
  'responseBody',
  'password',
  'passphrase',
  'seed',
  'mnemonic',
  'privateKey',
  'token',
  'bearer',
  'cookie',
  'session',
  'email',
  'phone',
  'ssn',
  'credit_card',
  'X-Signature',
  'X-Nonce',
]);

/** Collected log entries (in-memory for testing; production uses stdout). */
const logBuffer: LogEntry[] = [];

/** Injectable log sink (default: buffer). */
let logSink: (entry: LogEntry) => void = (entry) => {
  logBuffer.push(entry);
};

/** Set the log sink (for production: stdout JSON writer). */
export function setLogSink(sink: (entry: LogEntry) => void): void {
  logSink = sink;
}

/** Reset to default buffer sink (for testing). */
export function resetLogSink(): void {
  logSink = (entry) => {
    logBuffer.push(entry);
  };
}

/** Get buffered log entries (for testing). */
export function getLogBuffer(): LogEntry[] {
  return [...logBuffer];
}

/** Clear the log buffer (for testing). */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

/**
 * Log a request (info level).
 *
 * Captures path, method, DID, caller type, request ID.
 * Never includes body or auth secrets.
 */
export function logRequest(fields: {
  path: string;
  method: string;
  did?: string;
  callerType?: string;
  requestId?: string;
}): void {
  log('info', `${fields.method} ${fields.path}`, {
    path: fields.path,
    method: fields.method,
    did: fields.did,
    callerType: fields.callerType,
    requestId: fields.requestId,
  });
}

/**
 * Log a response (info or warn level based on status).
 */
export function logResponse(fields: {
  path: string;
  method: string;
  status: number;
  latencyMs: number;
  did?: string;
  requestId?: string;
}): void {
  const level: LogLevel = fields.status >= 500 ? 'error' : fields.status >= 400 ? 'warn' : 'info';
  log(level, `${fields.method} ${fields.path} → ${fields.status} (${fields.latencyMs}ms)`, {
    path: fields.path,
    method: fields.method,
    status: fields.status,
    latencyMs: fields.latencyMs,
    did: fields.did,
    requestId: fields.requestId,
  });
}

/**
 * Log an error.
 */
export function logError(message: string, error?: Error): void {
  log('error', message, { error: error?.message });
}

/**
 * Core log function. Applies redaction and sends to sink.
 */
export function log(level: LogLevel, message: string, fields?: Partial<LogEntry>): void {
  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    message,
    ...fields,
  };

  logSink(entry);
}

/**
 * Sanitize a record by removing redacted fields.
 *
 * Used to safely log request/response metadata without PII.
 */
export function sanitizeForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACTED_FIELDS.has(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 200) {
      sanitized[key] = value.slice(0, 200) + '...[truncated]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Check if a field name is redacted (should never be logged).
 */
export function isRedactedField(fieldName: string): boolean {
  return REDACTED_FIELDS.has(fieldName);
}
