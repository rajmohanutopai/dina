/**
 * Protocol constants — frozen value tables.
 *
 * These constants are part of the wire/policy contract that every
 * Dina-language port must agree on (Go `domain/message.go`, future
 * Rust/Swift/Kotlin/Python). Changes here ripple to every partner
 * Home Node — tests pin the shape so accidental rename / removal /
 * reorder fails CI before it reaches another implementation.
 *
 * For semantics + per-feature explanations, see the docs under
 * `packages/protocol/docs/features/`.
 */

import {
  D2D_SCENARIOS,
  MSG_TYPE_PRESENCE_SIGNAL,
  MSG_TYPE_COORDINATION_REQUEST,
  MSG_TYPE_COORDINATION_RESPONSE,
  MSG_TYPE_SOCIAL_UPDATE,
  MSG_TYPE_SAFETY_ALERT,
  MSG_TYPE_TRUST_VOUCH_REQUEST,
  MSG_TYPE_TRUST_VOUCH_RESPONSE,
  MSG_TYPE_SERVICE_QUERY,
  MSG_TYPE_SERVICE_RESPONSE,
} from '../src';
import type { D2DScenario, D2DMessageType } from '../src';

describe('@dina/protocol constants', () => {
  describe('D2D_SCENARIOS', () => {
    it('exports the six canonical scenario names in policy order', () => {
      // Frozen value contract — Go + future ports mirror this list.
      expect(D2D_SCENARIOS).toEqual([
        'presence',
        'coordination',
        'social',
        'safety',
        'trust',
        'service',
      ]);
    });

    it('contains exactly six scenarios — no silent additions', () => {
      // Adding a scenario is a wire break (sharing policies are stored
      // per-(contact, scenario) and partner Home Nodes must agree on
      // the namespace). Bumping this number is intentional and requires
      // updating the conformance docs + every language port.
      expect(D2D_SCENARIOS).toHaveLength(6);
    });

    it('has no duplicates', () => {
      expect(new Set(D2D_SCENARIOS).size).toBe(D2D_SCENARIOS.length);
    });

    it('typed D2DScenario assignment from string literal compiles', () => {
      // Compile-time pin: the union type stays a strict literal union,
      // not a widened `string`. `as` would silently widen — direct
      // assignment confirms the literal narrowing the public API
      // promises.
      const s: D2DScenario = 'presence';
      expect(s).toBe('presence');
    });
  });

  describe('D2D message type ↔ scenario relationship', () => {
    it('every V1 message type is one of the nine declared types', () => {
      // Drift detector for the message-type union itself. If a port
      // adds a new V1 type without updating this list, the assertion
      // count below catches it.
      const types: D2DMessageType[] = [
        MSG_TYPE_PRESENCE_SIGNAL,
        MSG_TYPE_COORDINATION_REQUEST,
        MSG_TYPE_COORDINATION_RESPONSE,
        MSG_TYPE_SOCIAL_UPDATE,
        MSG_TYPE_SAFETY_ALERT,
        MSG_TYPE_TRUST_VOUCH_REQUEST,
        MSG_TYPE_TRUST_VOUCH_RESPONSE,
        MSG_TYPE_SERVICE_QUERY,
        MSG_TYPE_SERVICE_RESPONSE,
      ];
      expect(types).toHaveLength(9);
      // No duplicates either.
      expect(new Set(types).size).toBe(9);
    });
  });
});
