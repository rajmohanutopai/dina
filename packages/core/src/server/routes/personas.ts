/**
 * Persona-list route — read-only HTTP surface that publishes Core's
 * persona registry to out-of-process brains (home-node-lite). Mobile
 * has direct access to `listPersonas()` because Brain lives in the
 * same process; lite has to round-trip through HTTP.
 *
 *   GET /v1/personas — returns
 *       [{ name, tier, isOpen }] for every persona currently in the
 *       registry. Sorted alphabetically by name for stable output.
 *
 * Auth: `/v1/personas` already sits in the brain/admin/device allowlist
 * (see `auth/authz.ts`); signed auth is applied by the router.
 */
import { listPersonas } from '../../persona/service';

import { PERSONAS_LIST } from './paths';

import type { PersonaState } from '../../persona/service';
import type { CoreResponse, CoreRouter } from '../router';

export interface PersonasRouteOptions {
  /** Persona-list resolver. Defaults to `listPersonas()` — tests inject their own. */
  resolveList?: () => PersonaState[];
}

export function makePersonasHandlers(options: PersonasRouteOptions = {}): {
  list: () => Promise<CoreResponse>;
} {
  const resolveList = options.resolveList ?? listPersonas;
  return { list: () => handleList(resolveList) };
}

export function registerPersonasRoutes(
  router: CoreRouter,
  options: PersonasRouteOptions = {},
): void {
  const { list } = makePersonasHandlers(options);
  router.get(PERSONAS_LIST, list);
}

async function handleList(resolveList: () => PersonaState[]): Promise<CoreResponse> {
  const personas = [...resolveList()]
    .map((p) => ({ name: p.name, tier: p.tier, isOpen: p.isOpen }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { status: 200, body: { personas } };
}
