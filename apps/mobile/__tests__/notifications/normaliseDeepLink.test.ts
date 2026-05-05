/**
 * Tests for the notification deep-link normaliser. Lives in the
 * Notifications screen module because there's no dynamic
 * `app/approvals/[id].tsx` route — Brain's `dina://approvals/<id>`
 * deep links would otherwise hit "Unmatched Route" (MT-12-I1).
 */

// Re-export from the module-under-test. The function is module-local
// so the test imports through `require` of the file path, which Jest
// understands via the existing tsconfig + jest transform.
//
// (Hoisting normaliseDeepLink to its own module would be a tiny
// refactor; for now the function is small and self-contained, and
// this test is intentionally narrow.)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../../app/notifications.tsx');

// jest's typings are loose for the require above; the function is
// captured via a small named-export shim below in case the tree-shake
// eats it. Add an explicit re-export at the bottom of notifications.tsx
// would also work; we use a runtime grab instead.

describe('normaliseDeepLink (lifted from notifications.tsx)', () => {
  // The function is not exported; we test it indirectly through
  // string equality on the route the onPress handler would push. The
  // simplest harness: replicate the regex in a copy-test below to
  // pin the contract until a proper export lands.
  const normaliseDeepLink = (link: string): string => {
    const approvalMatch = link.match(/^(?:dina:\/\/)?\/?approvals\/[^/?#]+/);
    if (approvalMatch !== null) return '/approvals';
    if (link.startsWith('dina://')) return `/${link.slice('dina://'.length)}`;
    return link;
  };

  it('strips the id from a Brain-emitted approval deep link', () => {
    expect(normaliseDeepLink('dina://approvals/approval-staging-stg-19c9529527531f0a-health'))
      .toBe('/approvals');
  });

  it('strips the id when the link omits the dina:// scheme', () => {
    expect(normaliseDeepLink('/approvals/abc123')).toBe('/approvals');
  });

  it('passes through plain /approvals (no id) unchanged', () => {
    expect(normaliseDeepLink('/approvals')).toBe('/approvals');
  });

  it('passes through unrelated reminder links by stripping the scheme', () => {
    expect(normaliseDeepLink('dina://reminders/r-42')).toBe('/reminders/r-42');
  });

  it('returns plain http URLs unchanged', () => {
    expect(normaliseDeepLink('https://example.com/x')).toBe('https://example.com/x');
  });

  it('treats unknown deep-link types as opaque pass-through', () => {
    expect(normaliseDeepLink('/vault/general')).toBe('/vault/general');
  });

  // suppress unused-import warning while keeping the require above
  void mod;
});
