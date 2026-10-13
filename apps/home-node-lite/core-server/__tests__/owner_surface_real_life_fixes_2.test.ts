/**
 * REAL_LIFE_FIXES_2 — the owner's own reads and revokes are on the server's
 * owner surface (the web app's owner calls reach them); proposing stays
 * Brain's, and nothing else on these trees is opened.
 */

import { isOwnerSurfacePath } from '../src/server/bind_core_router';

it('opens the export fetch, the settings, and listing or revoking standing replies and budgets', () => {
  expect(isOwnerSurfacePath('/v1/owner-export/exp-abc', 'GET')).toBe(true);
  expect(isOwnerSurfacePath('/v1/settings/owner-timezone', 'PUT')).toBe(true);
  expect(isOwnerSurfacePath('/v1/settings/guard-modes', 'GET')).toBe(true);
  expect(isOwnerSurfacePath('/v1/standing-replies', 'GET')).toBe(true);
  expect(isOwnerSurfacePath('/v1/spend-allowances/allow-1/revoke', 'POST')).toBe(true);
  expect(isOwnerSurfacePath('/v1/standing-replies/standing-1/revoke', 'POST')).toBe(true);
});

it('keeps proposing, preparing and anything else off the owner surface', () => {
  expect(isOwnerSurfacePath('/v1/owner-export/prepare', 'POST')).toBe(false);
  expect(isOwnerSurfacePath('/v1/spend-allowances/propose', 'POST')).toBe(false);
  expect(isOwnerSurfacePath('/v1/standing-replies/propose', 'POST')).toBe(false);
  expect(isOwnerSurfacePath('/v1/owner-export/a/b', 'GET')).toBe(false);
  expect(isOwnerSurfacePath('/v1/settings/other', 'PUT')).toBe(false);
  expect(isOwnerSurfacePath('/v1/spend-allowances', 'POST')).toBe(false);
});
