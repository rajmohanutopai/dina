/**
 * Domain error types — shared by both real implementations and mocks.
 *
 * These are NOT test-only. Production code should throw these errors
 * from port implementations.
 */

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`not yet implemented: ${method}`);
    this.name = 'NotImplementedError';
  }
}

export class PersonaLockedError extends Error {
  constructor(persona: string) {
    super(`persona locked — DEK not in RAM: ${persona}`);
    this.name = 'PersonaLockedError';
  }
}

export class NotFoundError extends Error {
  constructor(resource: string) {
    super(`not found: ${resource}`);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(reason: string) {
    super(`forbidden: ${reason}`);
    this.name = 'ForbiddenError';
  }
}

export class ApprovalRequiredError extends Error {
  public readonly approvalId: string;
  constructor(approvalId: string, persona: string) {
    super(`approval required for ${persona}`);
    this.name = 'ApprovalRequiredError';
    this.approvalId = approvalId;
  }
}

export class PIIScrubError extends Error {
  constructor(reason: string) {
    super(`PII scrub failed: ${reason}`);
    this.name = 'PIIScrubError';
  }
}

export class CoreUnreachableError extends Error {
  constructor() {
    super('Core is unreachable');
    this.name = 'CoreUnreachableError';
  }
}
