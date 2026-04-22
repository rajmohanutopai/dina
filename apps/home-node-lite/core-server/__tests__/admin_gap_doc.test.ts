/**
 * Task 5.57 — Admin API surface audit (ADMIN_GAP.md) contract tests.
 *
 * The audit file at `apps/home-node-lite/brain-server/ADMIN_GAP.md`
 * tracks what admin surfaces each primitive exposes vs. what's
 * missing. This test enforces the contract that:
 *
 *   1. The file exists.
 *   2. Every primitive module in `core-server/src/brain/` that has
 *      an admin-facing audit row appears in the file.
 *   3. The file has the expected top-level structure (summary +
 *      per-surface breakdown).
 *
 * When a new primitive with admin surface is added, update
 * `TRACKED_PRIMITIVES` below AND append a row to ADMIN_GAP.md.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ADMIN_GAP_PATH = resolve(
  __dirname,
  '..',
  '..',
  'brain-server',
  'ADMIN_GAP.md',
);

/**
 * Primitive files the audit MUST reference. Adding a new primitive
 * that has admin surfaces means adding it here + in ADMIN_GAP.md.
 */
const TRACKED_PRIMITIVES = [
  'ask_registry.ts',
  'guardian_loop.ts',
  'scratchpad.ts',
  'persona_registry.ts',
  'persona_selector.ts',
  'capabilities_registry.ts',
  'notify_dispatcher.ts',
  'trust_score_resolver.ts',
  'trust_decision.ts',
  'brain_metrics.ts',
  'config_reloader.ts',
  'llm_provider.ts',
  'token_ledger.ts',
  'tool_registry.ts',
  'brain_loop_registry.ts',
  'command_dispatcher.ts',
  'crash_recovery.ts',
  'domain_classifier.ts',
  'intent_classifier.ts',
] as const;

/**
 * Headings every ADMIN_GAP.md must have — pins the document shape so
 * a well-intentioned rewrite doesn't accidentally drop the
 * per-surface breakdown.
 */
const REQUIRED_HEADINGS = [
  '# Brain-server admin API surface — gap audit',
  '## Summary',
  '## Per-surface breakdown',
  '## Missing primitives (no primitive yet)',
  '## HTTP route wiring status — blocked on 5.1',
  '## Process',
];

describe('ADMIN_GAP.md contract (task 5.57)', () => {
  it('file exists at the expected path', () => {
    expect(existsSync(ADMIN_GAP_PATH)).toBe(true);
  });

  describe('structural headings', () => {
    const contents = existsSync(ADMIN_GAP_PATH)
      ? readFileSync(ADMIN_GAP_PATH, 'utf-8')
      : '';

    it.each(REQUIRED_HEADINGS)('contains heading "%s"', (heading) => {
      expect(contents).toContain(heading);
    });
  });

  describe('tracked primitives coverage', () => {
    const contents = existsSync(ADMIN_GAP_PATH)
      ? readFileSync(ADMIN_GAP_PATH, 'utf-8')
      : '';

    it.each(TRACKED_PRIMITIVES)(
      '%s is referenced in the audit file',
      (primitive) => {
        // We look for the primitive filename in the doc's code spans.
        // The audit references each primitive's source file path.
        expect(contents).toContain(primitive);
      },
    );
  });

  describe('documents missing primitives', () => {
    const contents = existsSync(ADMIN_GAP_PATH)
      ? readFileSync(ADMIN_GAP_PATH, 'utf-8')
      : '';

    it('lists at least one gap in the "Missing primitives" section', () => {
      const missingSection = contents.split('## Missing primitives (no primitive yet)')[1] ?? '';
      // A non-empty missing section has at least one ### subheading.
      const subheadings = missingSection.match(/^### /gm);
      expect(subheadings?.length ?? 0).toBeGreaterThan(0);
    });
  });

  describe('route-prefix convention documented', () => {
    const contents = existsSync(ADMIN_GAP_PATH)
      ? readFileSync(ADMIN_GAP_PATH, 'utf-8')
      : '';

    it('mentions /admin/* route prefix', () => {
      expect(contents).toContain('/admin/');
    });

    it('mentions CLIENT_TOKEN auth pattern', () => {
      expect(contents).toContain('CLIENT_TOKEN');
    });
  });
});
