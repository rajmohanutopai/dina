/**
 * Extension-operation registry + invocation gate
 * (COMMERCE_PROCUREMENT_PLUGIN_ARCHITECTURE.md §3.4).
 *
 * Core brokers domain operations WITHOUT becoming domain-aware: a
 * shipped, audited adapter registers `{ operation_name, params/result
 * schema + digest, adapter_version, required_feature, action_class }`
 * at boot. Registration is CODE-SHIPPED, never data-driven, and two
 * adapters cannot claim one name.
 *
 * Registration creates ZERO authority. An install may invoke an
 * operation only when the CONSENTED capability declares it in its
 * manifest `host_operations` list (part of the scope hash — widening
 * re-consents). The gate order is pinned by the spec's conformance
 * requirement (§25.2):
 *
 *   1. undeclared operation  -> denied BEFORE validation — before the
 *      registry is even consulted, before any params parse;
 *   2. unregistered operation -> denied (declared but the node ships
 *      no such adapter);
 *   3. otherwise             -> allowed; the CALLER then validates
 *      params against the registered schema and routes effectful
 *      operations through the canonical action plane (approval /
 *      standing grant / execution permit). `required_feature`
 *      expresses compatibility only; it never substitutes for
 *      authority.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import type { PluginCapabilityDecl } from '@dina/protocol';

export type ExtensionActionClass = 'read' | 'quote' | 'write' | 'booking' | 'payment' | 'agentic';

export interface ExtensionOperationDef {
  /** Stable typed name, e.g. `commerce.appview_search`. */
  operationName: string;
  paramsSchema: unknown;
  resultSchema: unknown;
  adapterVersion: string;
  /** Compatibility gate at install time (e.g. `commerce-host-ops-v1`). */
  requiredFeature: string;
  actionClass: ExtensionActionClass;
}

/** A registered operation with its pinned schema digests — the digests
 *  are recorded into every proposal/result workflow event so a later
 *  adapter update cannot silently reinterpret recorded history. */
export interface RegisteredExtensionOperation extends ExtensionOperationDef {
  paramsSchemaDigest: string;
  resultSchemaDigest: string;
}

export type HostOperationGateResult =
  | { allowed: true; operation: RegisteredExtensionOperation }
  | { allowed: false; code: 'operation_not_declared' | 'operation_unregistered'; error: string };

const OPERATION_NAME_SHAPE = /^[a-z0-9_.:-]+$/;

function schemaDigest(schema: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(schema ?? null))));
}

export class ExtensionOperationRegistry {
  private readonly operations = new Map<string, RegisteredExtensionOperation>();

  /** Boot-time, code-shipped registration. Throws on a duplicate name
   *  — two adapters cannot claim one operation. */
  register(def: ExtensionOperationDef): RegisteredExtensionOperation {
    if (
      typeof def.operationName !== 'string' ||
      def.operationName.length === 0 ||
      def.operationName.length > 128 ||
      !OPERATION_NAME_SHAPE.test(def.operationName)
    ) {
      throw new Error(`extension ops: invalid operation name "${def.operationName}"`);
    }
    if (this.operations.has(def.operationName)) {
      throw new Error(
        `extension ops: "${def.operationName}" is already registered — two adapters cannot claim one name (§3.4)`,
      );
    }
    const registered: RegisteredExtensionOperation = {
      ...def,
      paramsSchemaDigest: schemaDigest(def.paramsSchema),
      resultSchemaDigest: schemaDigest(def.resultSchema),
    };
    this.operations.set(def.operationName, registered);
    return registered;
  }

  get(operationName: string): RegisteredExtensionOperation | undefined {
    return this.operations.get(operationName);
  }

  list(): RegisteredExtensionOperation[] {
    return [...this.operations.values()];
  }
}

/**
 * The §3.4 invocation gate. `capability` is the CONSENTED capability
 * declaration from the install's pinned manifest — never the runner's
 * claim payload. Deny-before-validation: an undeclared operation is
 * refused without consulting the registry or touching params.
 */
export function checkHostOperationInvocation(
  capability: Pick<PluginCapabilityDecl, 'id' | 'host_operations'>,
  operationName: string,
  registry: ExtensionOperationRegistry,
): HostOperationGateResult {
  const declared = capability.host_operations ?? [];
  if (!declared.includes(operationName)) {
    return {
      allowed: false,
      code: 'operation_not_declared',
      error: `extension ops: "${operationName}" is not in capability "${capability.id}"'s consented host_operations — denied before validation (§3.4)`,
    };
  }
  const operation = registry.get(operationName);
  if (!operation) {
    return {
      allowed: false,
      code: 'operation_unregistered',
      error: `extension ops: "${operationName}" is declared but this node ships no such adapter`,
    };
  }
  return { allowed: true, operation };
}

let registry: ExtensionOperationRegistry | null = null;

export function setExtensionOperationRegistry(value: ExtensionOperationRegistry | null): void {
  registry = value;
}

export function getExtensionOperationRegistry(): ExtensionOperationRegistry | null {
  return registry;
}
