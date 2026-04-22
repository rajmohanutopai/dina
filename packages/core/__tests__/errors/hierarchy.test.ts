/**
 * T2A.8 — Error type hierarchy and error response format.
 *
 * Category B: contract test. Verifies domain error classes and their
 * mapping to HTTP status codes.
 *
 * Source: core/test/errors_test.go
 */

import {
  NotImplementedError,
  PersonaLockedError,
  NotFoundError,
  ForbiddenError,
  ApprovalRequiredError,
  PIIScrubError,
  CoreUnreachableError,
} from '@dina/test-harness';

describe('Error Type Hierarchy', () => {
  describe('domain error classes', () => {
    it('NotImplementedError includes method name', () => {
      const err = new NotImplementedError('testMethod');
      expect(err.message).toContain('testMethod');
      expect(err.name).toBe('NotImplementedError');
      expect(err).toBeInstanceOf(Error);
    });

    it('PersonaLockedError includes persona name', () => {
      const err = new PersonaLockedError('health');
      expect(err.message).toContain('health');
      expect(err.message).toContain('locked');
      expect(err.name).toBe('PersonaLockedError');
    });

    it('NotFoundError includes resource name', () => {
      const err = new NotFoundError('item-123');
      expect(err.message).toContain('item-123');
      expect(err.name).toBe('NotFoundError');
    });

    it('ForbiddenError includes reason', () => {
      const err = new ForbiddenError('brain-denied action');
      expect(err.message).toContain('brain-denied');
      expect(err.name).toBe('ForbiddenError');
    });

    it('ApprovalRequiredError includes approval ID and persona', () => {
      const err = new ApprovalRequiredError('apr-001', 'health');
      expect(err.message).toContain('health');
      expect(err.approvalId).toBe('apr-001');
      expect(err.name).toBe('ApprovalRequiredError');
    });

    it('PIIScrubError includes reason', () => {
      const err = new PIIScrubError('scrubber unavailable');
      expect(err.message).toContain('scrubber unavailable');
      expect(err.name).toBe('PIIScrubError');
    });

    it('CoreUnreachableError has descriptive message', () => {
      const err = new CoreUnreachableError();
      expect(err.message).toContain('unreachable');
      expect(err.name).toBe('CoreUnreachableError');
    });
  });

  describe('instanceof checks', () => {
    it('all domain errors are instanceof Error', () => {
      expect(new NotImplementedError('x')).toBeInstanceOf(Error);
      expect(new PersonaLockedError('x')).toBeInstanceOf(Error);
      expect(new NotFoundError('x')).toBeInstanceOf(Error);
      expect(new ForbiddenError('x')).toBeInstanceOf(Error);
      expect(new ApprovalRequiredError('a', 'p')).toBeInstanceOf(Error);
      expect(new PIIScrubError('x')).toBeInstanceOf(Error);
      expect(new CoreUnreachableError()).toBeInstanceOf(Error);
    });

    it('errors can be caught by specific type', () => {
      try {
        throw new PersonaLockedError('health');
      } catch (e) {
        expect(e).toBeInstanceOf(PersonaLockedError);
        expect(e).not.toBeInstanceOf(NotFoundError);
      }
    });

    it('ApprovalRequiredError exposes approvalId property', () => {
      const err = new ApprovalRequiredError('apr-099', 'finance');
      expect(err.approvalId).toBe('apr-099');
    });
  });
});
