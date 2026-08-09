/**
 * The §3.4 operation REGISTRATIONS, code-shipped (WS-11.2).
 *
 * Both boots built an `ExtensionOperationRegistry`, registered three executors
 * on the dispatcher, and registered NOTHING in the registry. The two halves
 * answer different questions and only one of them was wired:
 *
 *   - the DISPATCHER says what this node can DO;
 *   - the REGISTRY says what a capability may DECLARE, and pins the schemas a
 *     proposal is validated against and a result verified against.
 *
 * With an empty registry, `checkHostOperationInvocation` refuses every
 * operation `operation_unregistered` before it reaches an executor — so the
 * executors were unreachable and the whole §3.4 lane was closed from the
 * declaration side. Invisible again, for the usual reason: a node that refuses
 * every brokered operation looks exactly like a node nobody asked.
 *
 * REGISTRATION IS CODE-SHIPPED, NEVER DATA-DRIVEN (§3.4), which is why this
 * lives in Core rather than being read from a manifest: a pack that could
 * register its own privileged operation would be granting itself authority by
 * declaring it.
 *
 * AND REGISTRATION CREATES ZERO AUTHORITY. An install may invoke one of these
 * only when a CONSENTED capability names it in `host_operations`; this file
 * just makes the name mean something.
 */

import type { ExtensionOperationRegistry } from './extension_ops';

/** Stable names, matching the executors both boots register. */
export const HOST_OPERATION_D2D_SEND = 'd2d_send';
export const HOST_OPERATION_PUBLICATION_CANDIDATE = 'publication_candidate';
export const HOST_OPERATION_CONNECTOR_BROKER = 'connector_broker';

/**
 * Schemas describe what the EXECUTOR reads, and nothing else. Every field an
 * executor refuses as authority-shaped (`from_did`, `supplier_did`,
 * `install_id`) is deliberately absent AND `additionalProperties: false`, so
 * such a proposal is refused at validation rather than reaching the executor's
 * own guard. The guard stays as the second line: a schema is a contract, not
 * an enforcement point, and the executors are reachable from other callers.
 */
const D2D_SEND_PARAMS = {
  type: 'object',
  properties: {
    to_did: { type: 'string', minLength: 1 },
    body: {},
  },
  required: ['to_did', 'body'],
  additionalProperties: false,
} as const;

const PUBLICATION_CANDIDATE_PARAMS = {
  type: 'object',
  properties: { candidate: { type: 'object' } },
  required: ['candidate'],
  additionalProperties: false,
} as const;

const CONNECTOR_BROKER_PARAMS = {
  type: 'object',
  properties: {
    resource: { type: 'string', minLength: 1 },
    operation: { type: 'string', minLength: 1 },
    operation_params: { type: 'object' },
  },
  required: ['resource', 'operation'],
  additionalProperties: false,
} as const;

/**
 * Register the operations this build ships.
 *
 * ACTION CLASSES ARE THE POLICY, and they are the fail-closed reading:
 *
 *   - `publication_candidate` is `read`, because it VALIDATES and does not
 *     publish. Publication is the owner's commercial act on their own route;
 *     classing this as `write` would card an operation that changes nothing.
 *   - `d2d_send` is `write`. It puts bytes on the wire under the node's own
 *     identity, to a counterparty, and cannot be taken back.
 *   - `connector_broker` is `write` too, and for a stronger reason: the same
 *     operation name can submit a purchase order to an ERP. Classing it by
 *     the weakest thing it might do would let the strongest through silently.
 *
 * `payment` is never used here. §8's floor table BLOCKS that class at every
 * trust ring, and none of these three is a settlement.
 */
export function registerCommerceHostOperations(registry: ExtensionOperationRegistry): void {
  registry.register({
    operationName: HOST_OPERATION_D2D_SEND,
    paramsSchema: D2D_SEND_PARAMS,
    resultSchema: {
      type: 'object',
      properties: { sent_to: { type: 'string' } },
      required: ['sent_to'],
    },
    adapterVersion: '1.0.0',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'write',
  });
  registry.register({
    operationName: HOST_OPERATION_PUBLICATION_CANDIDATE,
    paramsSchema: PUBLICATION_CANDIDATE_PARAMS,
    resultSchema: {
      type: 'object',
      properties: { validated: { type: 'boolean' }, supplier_did: { type: 'string' } },
      required: ['validated', 'supplier_did'],
    },
    adapterVersion: '1.0.0',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'read',
  });
  registry.register({
    operationName: HOST_OPERATION_CONNECTOR_BROKER,
    // The broker's own result is opaque to Core by design (§8.3): it performs
    // a typed operation on somebody else's system and hands back what that
    // system said. Pinning a shape here would make Core the authority on an
    // external contract it does not own.
    paramsSchema: CONNECTOR_BROKER_PARAMS,
    resultSchema: {},
    adapterVersion: '1.0.0',
    requiredFeature: 'commerce-host-ops-v1',
    actionClass: 'write',
  });
}
