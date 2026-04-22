/**
 * Node role preference — persisted across app launches.
 *
 * Default is `'requester'` (a private device that queries other nodes but
 * doesn't advertise capabilities). The Service Sharing screen can elevate
 * to `'provider'` / `'both'` once the user has configured a service
 * profile and understood that they'll be publishing to AppView.
 *
 * Split from `ServiceConfig` because the config stores capability metadata
 * + policies, while "am I a provider at all" is a coarser gate that
 * bootstrap.ts needs BEFORE it decides whether to instantiate a
 * ServicePublisher or register inbound handlers.
 */

import * as Keychain from 'react-native-keychain';
import type { NodeRole } from './bootstrap';

const SERVICE = 'dina.node_role';
const USERNAME = 'dina_node_role';
const DEFAULT_ROLE: NodeRole = 'requester';

const VALID_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>(['requester', 'provider', 'both']);

export async function loadRolePreference(): Promise<NodeRole> {
  const row = await Keychain.getGenericPassword({ service: SERVICE });
  if (!row) return DEFAULT_ROLE;
  const candidate = row.password as NodeRole;
  return VALID_ROLES.has(candidate) ? candidate : DEFAULT_ROLE;
}

export async function saveRolePreference(role: NodeRole): Promise<void> {
  if (!VALID_ROLES.has(role)) {
    throw new Error(`saveRolePreference: invalid role "${role}"`);
  }
  await Keychain.setGenericPassword(USERNAME, role, { service: SERVICE });
}
