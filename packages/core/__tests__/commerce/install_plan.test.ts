/**
 * WS-7.1 — the Commerce Pack install journey (§18.1, FR-P1).
 *
 * One sentence in the spec is the whole item: "Both" creates two
 * installs/consent decisions, not one superset install. That is a safety rule
 * rather than a UX preference — a superset install gives one consent record
 * authority over both sides of a trade, so revoking selling would revoke
 * buying, and a compromised supplier runner would carry buyer authority.
 */

import {
  planCommerceInstall,
  roleIsInstalled,
  type InstallChoice,
} from '../../src/commerce/install_plan';
import {
  BUYER_REFERENCE_MANIFEST,
  SUPPLIER_REFERENCE_MANIFEST,
} from '../../src/commerce/reference_manifests';

describe('turning a choice into installs', () => {
  it.each([
    ['buy', ['buyer']],
    ['sell', ['supplier']],
    ['both', ['buyer', 'supplier']],
  ] as [InstallChoice, string[]][])('%s installs %p', (choice, roles) => {
    const plan = planCommerceInstall(choice);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(JSON.stringify(plan.findings));
    expect(plan.installs.map((i) => i.role)).toEqual(roles);
  });

  it('gives "both" TWO consent decisions, never one', () => {
    // The sentence §18.1 is explicit about. One consent covering two installs
    // is the superset install wearing a different shape.
    const plan = planCommerceInstall('both');
    if (!plan.ok) throw new Error(JSON.stringify(plan.findings));
    expect(new Set(plan.installs.map((i) => i.consentLabel)).size).toBe(2);
  });

  it('gives each role its own manifest', () => {
    // Two roles sharing a manifest means one capability set and, in practice,
    // one consent decision.
    const plan = planCommerceInstall('both');
    if (!plan.ok) throw new Error(JSON.stringify(plan.findings));
    const ids = plan.installs.map((i) => i.manifest.plugin_id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(BUYER_REFERENCE_MANIFEST.plugin_id);
    expect(ids).toContain(SUPPLIER_REFERENCE_MANIFEST.plugin_id);
  });

  it('keeps the two capability sets disjoint', () => {
    // Checked rather than assumed: the manifests are DATA a pack author edits,
    // and an overlap is exactly the change that would silently give a buyer
    // install a supplier's authority. If this ever fails, the manifests moved.
    const buyer = new Set(BUYER_REFERENCE_MANIFEST.capabilities.map((c) => c.id));
    const overlap = SUPPLIER_REFERENCE_MANIFEST.capabilities
      .map((c) => c.id)
      .filter((id) => buyer.has(id));
    expect(overlap).toEqual([]);
    expect(planCommerceInstall('both').ok).toBe(true);
  });
});

describe('reading back which roles a node has', () => {
  it('answers per role, never "any commerce install"', () => {
    // The read side of the same rule. "May this node sell?" answered from the
    // presence of ANY commerce install is precisely the shortcut a superset
    // install would have made correct.
    const buyerOnly = [{ pluginId: BUYER_REFERENCE_MANIFEST.plugin_id }];
    expect(roleIsInstalled(buyerOnly, 'buyer')).toBe(true);
    expect(roleIsInstalled(buyerOnly, 'supplier')).toBe(false);
  });

  it('answers false for a node with no commerce at all', () => {
    expect(roleIsInstalled([], 'buyer')).toBe(false);
    expect(roleIsInstalled([{ pluginId: 'com.example.something' }], 'supplier')).toBe(false);
  });

  it('answers true for both once both are installed', () => {
    const plan = planCommerceInstall('both');
    if (!plan.ok) throw new Error(JSON.stringify(plan.findings));
    const active = plan.installs.map((i) => ({ pluginId: i.manifest.plugin_id }));
    expect(roleIsInstalled(active, 'buyer')).toBe(true);
    expect(roleIsInstalled(active, 'supplier')).toBe(true);
  });
});
