/**
 * DID document `assertionMethod` resolution (TN-AUTH-001).
 *
 * Per Trust Network V1 plan §3.5.2, namespace keys register as
 * `assertionMethod` verification methods on the user's published DID
 * document. AppView's signature gate (TN-AUTH-002) and the mobile
 * verifier both need to translate a record's `namespace` field into
 * the underlying public-key bytes — that translation runs through
 * `assertionMethod`.
 *
 * Per W3C DID Core §5.3.2, an `assertionMethod` entry is either:
 *   - a string reference into `verificationMethod[]` (fragment-only,
 *     e.g. `#namespace_0`, OR fully-qualified, e.g.
 *     `did:plc:xxxx#namespace_0`); OR
 *   - an embedded `VerificationMethod` object.
 *
 * Both forms are supported here. Dina's PLC ops produce only the
 * string-reference form (see plan §3.5.2 example), but federated
 * trust queries can land DID documents from other implementations
 * that embed inline VMs, and the resolver should accept what the
 * spec allows.
 *
 * Resolver semantics:
 *   - Missing / empty `assertionMethod` → `[]`.
 *   - String references resolved via case-sensitive id match on
 *     `verificationMethod[i].id`. Fragment-only refs (e.g.
 *     `#namespace_0`) are expanded against `doc.id` before match.
 *   - Dangling string references (no matching VM) are silently
 *     skipped — the resolver returns what it CAN resolve. Strict
 *     validation is the verifier's concern; a single dangling
 *     entry shouldn't blind the caller to the rest.
 *   - Inline VMs are returned as-is (identity preserved — the
 *     caller's `===` check survives a round-trip).
 *   - Duplicate entries are returned as-is (the spec permits them
 *     and dedupe is the caller's concern; tests pin the no-silent-
 *     dedupe contract).
 *   - Non-string / non-object entries are silently skipped (defensive
 *     against malformed wire input).
 *
 * Pure function. Zero runtime deps.
 */

import type { DIDDocument, VerificationMethod } from '../types/plc_document';

/**
 * Resolve all verification methods registered under
 * `doc.assertionMethod` to their `VerificationMethod` form.
 *
 * @param doc The DID document to resolve from. Mutated by neither
 *   this call nor the returned array.
 * @returns A fresh array of resolved verification methods. The order
 *   matches the input `assertionMethod` order (with skipped entries
 *   removed). Entries are NOT cloned — inline VMs and resolved string
 *   references both yield the same `VerificationMethod` object the
 *   document already carried, so `===` identity survives.
 */
export function resolveAssertionMethods(doc: DIDDocument): VerificationMethod[] {
  const entries = doc.assertionMethod;
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const vmById = indexVerificationMethodsById(doc.verificationMethod);
  const out: VerificationMethod[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      const resolved = resolveStringReference(entry, doc.id, vmById);
      if (resolved !== null) out.push(resolved);
      continue;
    }
    if (isVerificationMethodLike(entry)) {
      out.push(entry);
    }
    // Anything else (number / null / array / unstructured object) is
    // silently skipped — the surrounding wire layer's validator is
    // the right place to surface schema errors.
  }

  return out;
}

/**
 * Resolve a single `assertionMethod` reference (e.g. `#namespace_0` or
 * `did:plc:xxxx#namespace_0`) to its verification method, if present.
 *
 * Convenience over `resolveAssertionMethods` for the common AppView
 * case: a record carries `namespace: "namespace_1"` and the verifier
 * needs the matching key. This wrapper lets the caller pass either the
 * bare fragment (without `#`) or any of the W3C-permitted reference
 * forms.
 *
 * @param doc The author's DID document.
 * @param fragmentOrRef Either a bare fragment (`namespace_0`), a
 *   fragment-with-hash (`#namespace_0`), or a fully-qualified DID URL
 *   (`did:plc:xxxx#namespace_0`). All three are accepted to spare
 *   callers a normalisation step.
 * @returns The matching verification method or `null` if not present
 *   in `assertionMethod` (or referenced but dangling).
 */
export function resolveAssertionMethod(
  doc: DIDDocument,
  fragmentOrRef: string,
): VerificationMethod | null {
  if (typeof fragmentOrRef !== 'string' || fragmentOrRef.length === 0) return null;

  const targetIds = expandReferenceForms(fragmentOrRef, doc.id);
  const candidates = resolveAssertionMethods(doc);
  for (const vm of candidates) {
    if (targetIds.has(vm.id)) return vm;
  }
  return null;
}

// ─── Internal ─────────────────────────────────────────────────────────────

function indexVerificationMethodsById(
  vms: VerificationMethod[] | undefined,
): Map<string, VerificationMethod> {
  const ix = new Map<string, VerificationMethod>();
  if (!Array.isArray(vms)) return ix;
  for (const vm of vms) {
    if (isVerificationMethodLike(vm)) ix.set(vm.id, vm);
  }
  return ix;
}

function resolveStringReference(
  ref: string,
  docId: string,
  vmById: Map<string, VerificationMethod>,
): VerificationMethod | null {
  // Try the exact form first — handles fully-qualified ids.
  const exact = vmById.get(ref);
  if (exact !== undefined) return exact;

  // Fragment-only references: expand against `doc.id`.
  if (ref.startsWith('#') && typeof docId === 'string' && docId.length > 0) {
    const expanded = vmById.get(`${docId}${ref}`);
    if (expanded !== undefined) return expanded;
  }
  return null;
}

function expandReferenceForms(input: string, docId: string): Set<string> {
  // Normalise the various permitted reference shapes into a single
  // candidate-set the caller can match against `vm.id`. Three input
  // shapes per the function docstring:
  //   - bare fragment ("namespace_0")           — synthesise both # and ${docId}#
  //   - fragment-with-hash ("#namespace_0")     — synthesise ${docId}#
  //   - fully-qualified ("did:plc:xxxx#name_0") — only itself
  const forms = new Set<string>();
  forms.add(input);
  const hasDocId = typeof docId === 'string' && docId.length > 0;
  if (input.startsWith('#')) {
    if (hasDocId) forms.add(`${docId}${input}`);
  } else if (!input.includes('#')) {
    forms.add(`#${input}`);
    if (hasDocId) forms.add(`${docId}#${input}`);
  }
  return forms;
}

function isVerificationMethodLike(v: unknown): v is VerificationMethod {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.type === 'Multikey' &&
    typeof r.controller === 'string' &&
    typeof r.publicKeyMultibase === 'string'
  );
}
