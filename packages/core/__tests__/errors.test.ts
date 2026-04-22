/**
 * Custom error hierarchy tests — typed errors for specific failure cases.
 *
 * Verifies: instanceof chain, error names, custom fields, message formatting.
 */

import {
  DinaError,
  PersonaLockedError,
  AuthorizationError,
  ApprovalRequiredError,
  CoreUnreachableError,
  LLMError,
  ConfigError,
  PIIScrubError,
  CloudConsentError,
  MCPError,
  NotFoundError,
} from '../src/errors';

describe('Custom Error Hierarchy', () => {
  describe('DinaError base class', () => {
    it('is an instance of Error', () => {
      const err = new DinaError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(DinaError);
      expect(err.name).toBe('DinaError');
      expect(err.message).toBe('test');
    });
  });

  describe('PersonaLockedError', () => {
    it('has persona field and correct name', () => {
      const err = new PersonaLockedError('health');
      expect(err).toBeInstanceOf(DinaError);
      expect(err).toBeInstanceOf(PersonaLockedError);
      expect(err.name).toBe('PersonaLockedError');
      expect(err.persona).toBe('health');
      expect(err.message).toContain('health');
      expect(err.message).toContain('locked');
    });

    it('accepts custom message', () => {
      const err = new PersonaLockedError('finance', 'Custom lock message');
      expect(err.message).toBe('Custom lock message');
      expect(err.persona).toBe('finance');
    });
  });

  describe('ApprovalRequiredError', () => {
    it('has approvalId and persona fields', () => {
      const err = new ApprovalRequiredError('apr-123', 'health');
      expect(err).toBeInstanceOf(DinaError);
      expect(err.name).toBe('ApprovalRequiredError');
      expect(err.approvalId).toBe('apr-123');
      expect(err.persona).toBe('health');
    });
  });

  describe('instanceof discrimination in catch blocks', () => {
    it('can distinguish error types', () => {
      const errors: DinaError[] = [
        new PersonaLockedError('health'),
        new AuthorizationError(),
        new ApprovalRequiredError('apr-1', 'finance'),
        new CoreUnreachableError(),
        new LLMError('timeout'),
        new ConfigError('missing key'),
        new PIIScrubError(),
        new CloudConsentError('health'),
        new MCPError(),
        new NotFoundError('vault item', 'vi-abc123'),
      ];

      let personaLocked = 0;
      let authorization = 0;
      let approvalRequired = 0;
      let other = 0;

      for (const err of errors) {
        if (err instanceof PersonaLockedError) personaLocked++;
        else if (err instanceof AuthorizationError) authorization++;
        else if (err instanceof ApprovalRequiredError) approvalRequired++;
        else other++;
      }

      expect(personaLocked).toBe(1);
      expect(authorization).toBe(1);
      expect(approvalRequired).toBe(1);
      expect(other).toBe(7);
    });

    it('all errors are instanceof DinaError', () => {
      const errors = [
        new PersonaLockedError('x'),
        new AuthorizationError(),
        new LLMError(),
        new ConfigError(),
        new PIIScrubError(),
        new CoreUnreachableError(),
        new MCPError(),
        new CloudConsentError('x'),
        new NotFoundError('x', 'y'),
        new ApprovalRequiredError('a', 'b'),
      ];

      for (const err of errors) {
        expect(err).toBeInstanceOf(DinaError);
        expect(err).toBeInstanceOf(Error);
      }
    });
  });

  describe('NotFoundError', () => {
    it('includes resource and id in message', () => {
      const err = new NotFoundError('vault item', 'vi-abc');
      expect(err.message).toContain('vault item');
      expect(err.message).toContain('vi-abc');
      expect(err.message).toContain('not found');
    });
  });

  describe('CloudConsentError', () => {
    it('has persona field', () => {
      const err = new CloudConsentError('health');
      expect(err.persona).toBe('health');
      expect(err.message).toContain('consent');
    });
  });

  describe('error name property', () => {
    it('each error has a unique name', () => {
      const names = [
        new DinaError('').name,
        new PersonaLockedError('').name,
        new AuthorizationError().name,
        new ApprovalRequiredError('', '').name,
        new CoreUnreachableError().name,
        new LLMError().name,
        new ConfigError().name,
        new PIIScrubError().name,
        new CloudConsentError('').name,
        new MCPError().name,
        new NotFoundError('', '').name,
      ];

      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });
  });
});
