/**
 * Custom error hierarchy — typed errors for specific failure cases.
 *
 * Ported from Python: brain/src/domain/errors.py (10 custom error classes).
 * Enables callers to catch specific error types rather than parsing message strings.
 *
 * Usage:
 *   try { ... }
 *   catch (err) {
 *     if (err instanceof PersonaLockedError) { // handle locked persona }
 *     if (err instanceof ApprovalRequiredError) { // show approval UI }
 *   }
 */

/** Base error for all Dina-specific errors. */
export class DinaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DinaError';
  }
}

/** Persona vault is locked — requires passphrase or approval to access. */
export class PersonaLockedError extends DinaError {
  readonly persona: string;

  constructor(persona: string, message?: string) {
    super(message ?? `Persona "${persona}" is locked`);
    this.name = 'PersonaLockedError';
    this.persona = persona;
  }
}

/** Caller is not authorized for the requested operation. */
export class AuthorizationError extends DinaError {
  constructor(message?: string) {
    super(message ?? 'Not authorized');
    this.name = 'AuthorizationError';
  }
}

/** Operation requires user approval before proceeding. */
export class ApprovalRequiredError extends DinaError {
  readonly approvalId: string;
  readonly persona: string;

  constructor(approvalId: string, persona: string, message?: string) {
    super(message ?? `Approval required for persona "${persona}"`);
    this.name = 'ApprovalRequiredError';
    this.approvalId = approvalId;
    this.persona = persona;
  }
}

/** Core server is unreachable (connection refused, timeout). */
export class CoreUnreachableError extends DinaError {
  constructor(message?: string) {
    super(message ?? 'Core server is unreachable');
    this.name = 'CoreUnreachableError';
  }
}

/** LLM provider error (timeout, rate limit, model error). */
export class LLMError extends DinaError {
  constructor(message?: string) {
    super(message ?? 'LLM provider error');
    this.name = 'LLMError';
  }
}

/** Configuration error (missing API key, invalid setting). */
export class ConfigError extends DinaError {
  constructor(message?: string) {
    super(message ?? 'Configuration error');
    this.name = 'ConfigError';
  }
}

/** PII scrubbing failed (scrub pipeline error). */
export class PIIScrubError extends DinaError {
  constructor(message?: string) {
    super(message ?? 'PII scrubbing failed');
    this.name = 'PIIScrubError';
  }
}

/** Cloud LLM consent not granted for sensitive persona data. */
export class CloudConsentError extends DinaError {
  readonly persona: string;

  constructor(persona: string, message?: string) {
    super(message ?? `Cloud LLM consent required for persona "${persona}"`);
    this.name = 'CloudConsentError';
    this.persona = persona;
  }
}

/** MCP agent delegation error. */
export class MCPError extends DinaError {
  constructor(message?: string) {
    super(message ?? 'MCP delegation error');
    this.name = 'MCPError';
  }
}

/** Item or resource not found. */
export class NotFoundError extends DinaError {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`);
    this.name = 'NotFoundError';
  }
}
