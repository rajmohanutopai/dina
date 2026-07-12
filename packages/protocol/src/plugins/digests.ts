/**
 * The three plugin digests — three digests, three jobs (§8.1):
 *
 *   approved_scope_hash  — gates GRANTS. Changes → re-consent.
 *   behavior_hash        — machine wiring + turn rules + timeouts.
 *                          Gates silent update APPLICATION (§14);
 *                          never gates grants.
 *   presentation_hash    — display_name + description + instructions.
 *                          Gates neither; always SURFACES in Activity.
 *
 * All SHA-256 over canonical JSON: sorted object keys, no insignificant
 * whitespace (JCS-style). Set-like arrays are already deduplicated +
 * sorted by normalize.ts — normalization is the STORED form, so the
 * digest input and the runtime representation are the same bytes.
 *
 * The scope hash is PER CAPABILITY (grants key on
 * `(install_id, capability, approved_scope_hash)`); the install row
 * additionally stores a combined install-level hash over the sorted
 * per-capability digests, so "did anything change" is one comparison.
 *
 * Manifest-level consent fields (execution mode, runtime identity,
 * config_schema) fold into EVERY capability's scope hash: a
 * config_schema or issuer change re-consents the whole install, which
 * is exactly the spec's intent (§8.1: "a new field asking the owner
 * for more input is consent-relevant"; a new issuer is a new party).
 *
 * Hashing is CALLER-INJECTED (`Sha256Fn`) — @dina/protocol is
 * zero-runtime-deps; each runtime supplies its own crypto, the same
 * convention as `verify_record.ts`.
 *
 * Pure functions. Zero runtime deps.
 */

import type { PluginCapabilityDecl, PluginManifest } from './types';

/** Caller-injected SHA-256. Input: UTF-8 bytes. Output: 32-byte digest. */
export type Sha256Fn = (data: Uint8Array) => Uint8Array;

export interface PluginDigests {
  /** capability id → approved_scope_hash (hex). */
  readonly perCapability: Readonly<Record<string, string>>;
  /** Combined hash over sorted per-capability scope hashes (hex). */
  readonly installScopeHash: string;
  /** Machine wiring + turn rules + timeouts, all capabilities (hex). */
  readonly behaviorHash: string;
  /** Names, descriptions, instructions (hex). */
  readonly presentationHash: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON (JCS-style: RFC 8785's core rules for the JSON subset
// we emit — object keys sorted by code unit, no whitespace, standard
// JSON number serialization; we additionally REJECT non-finite numbers
// and undefined instead of coercing, because a digest input that needed
// coercion is a bug upstream).
// ---------------------------------------------------------------------------

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function utf8Bytes(s: string): Uint8Array {
  // TextEncoder exists in Node ≥ 11, browsers, React Native (Hermes),
  // and workers — the runtime-agnostic encode.
  return new TextEncoder().encode(s);
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function digestOf(value: unknown, sha256: Sha256Fn): string {
  return hex(sha256(utf8Bytes(canonicalJson(value))));
}

// ---------------------------------------------------------------------------
// approved_scope_hash — §8.1 "In the hash" field list, verbatim.
// ---------------------------------------------------------------------------

/**
 * The §8.1 consent-relevant projection for one capability. Exported so
 * tests (and other implementations) can assert the exact field set —
 * the hash IS the re-consent boundary, so its contents are a launch
 * gate, not an open decision.
 */
export function scopeHashInput(
  manifest: PluginManifest,
  cap: PluginCapabilityDecl,
): Record<string, unknown> {
  const runtime = manifest.execution.runtime;
  return {
    // Capability identity + classes.
    execution_mode: manifest.execution.mode,
    capability_id: cap.id,
    // Audit D9: interaction is consent-relevant — a query→session flip
    // reusing an existing machine would otherwise re-scope (add a peer
    // + stateful moves) without changing the hash.
    interaction: cap.interaction,
    action_class: cap.action_class,
    privacy_class: cap.privacy_class,
    // Which lanes the capability may serve (§9) + retry contract (§9.1).
    kinds: cap.kinds ?? [],
    effects_idempotency: cap.effects?.idempotency ?? null,
    // Wire shape.
    params_schema: cap.params_schema ?? null,
    result_schema: cap.result_schema ?? null,
    // Egress ceiling.
    data_scope: cap.data_scope ?? null,
    // Runtime identity: domains, endpoint, issuer, pinned artifacts —
    // a new issuer or artifact is a different party/code receiving the
    // owner's data (§8.1).
    network_domains: cap.network_domains ?? [],
    hosted_endpoint: runtime?.hosted_endpoint ?? null,
    runtime_issuer: runtime?.issuer ?? null,
    runtime_artifacts: runtime?.artifacts ?? null,
    // Audit D9: self-host source identity (npm/docker) is who/what runs
    // the owner's data — swapping it without re-consent is a party change.
    runtime_self_host: runtime?.self_host ?? null,
    // Owner-input surface.
    config_schema: manifest.config_schema ?? null,
    // Routing consent (verbatim in the re-consent diff, §6).
    intent_phrases: cap.intent_phrases ?? [],
    // Machine INTERFACE (move types + schemas) — not the wiring.
    machine_moves: cap.machine?.moves ?? null,
    ops_used: cap.ops_used ?? [],
    verify_budget: cap.verify_budget ?? 0,
  };
}

/**
 * behavior_hash input — everything machine-behavioral that consent
 * excludes (§8.1): transitions, turn rules, timeouts (`move_sec`,
 * `session_ttl_sec` — pressure- and spam-relevant). Keyed per
 * capability, hashed together.
 */
export function behaviorHashInput(manifest: PluginManifest): Record<string, unknown> {
  const perCap: Record<string, unknown> = {};
  for (const cap of manifest.capabilities) {
    perCap[cap.id] = {
      transitions: cap.machine?.transitions ?? [],
      turn: cap.machine?.turn ?? null,
      initial: cap.machine?.initial ?? null,
      states: cap.machine?.states ?? [],
      terminal: cap.machine?.terminal ?? [],
      timeouts: cap.machine?.timeouts ?? null,
    };
  }
  return perCap;
}

/**
 * presentation_hash input (§8.1): display_name, description, and the
 * plugin-authored `instructions`. Never gates grants or application;
 * a change always surfaces in Activity (§14).
 */
export function presentationHashInput(manifest: PluginManifest): Record<string, unknown> {
  const instructions: Record<string, unknown> = {};
  for (const cap of manifest.capabilities) {
    instructions[cap.id] = {
      display_name: cap.display_name,
      instructions: cap.instructions ?? null,
      // Audit D9: the card spec re-frames the owner-facing render; a
      // silent card rewrite must at least SURFACE in Activity (§14), so
      // it belongs in the presentation hash.
      card: cap.card ?? null,
    };
  }
  return {
    display_name: manifest.display_name,
    short_description: manifest.short_description ?? null,
    // Round-5 #9: icon / homepage / source_url are the phishing-relevant
    // branding + outbound links the owner reads to decide who they trust. An
    // update that swaps the icon or redirects the homepage/source to a lookalike
    // site must produce a presentation-change receipt in Activity — so they
    // belong in the presentation digest. (icon is an opaque blob ref — its
    // JSON form participates in the hash; AppView validates the blob itself.)
    icon: manifest.icon ?? null,
    homepage: manifest.homepage ?? null,
    source_url: manifest.source_url ?? null,
    capabilities: instructions,
  };
}

/**
 * Compute all plugin digests for a NORMALIZED manifest. Callers must
 * normalize first (normalize.ts) — hashing an un-normalized manifest
 * would let `["tool","provider"]` vs `["provider","tool"]` manufacture
 * a re-consent (§8.1).
 */
export function computePluginDigests(manifest: PluginManifest, sha256: Sha256Fn): PluginDigests {
  const perCapability: Record<string, string> = {};
  for (const cap of manifest.capabilities) {
    perCapability[cap.id] = digestOf(scopeHashInput(manifest, cap), sha256);
  }
  // Install-level hash: sorted (capability id, hash) pairs so the
  // combined digest is order-independent and collision-scoped.
  const combined = Object.entries(perCapability).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    perCapability,
    installScopeHash: digestOf(combined, sha256),
    behaviorHash: digestOf(behaviorHashInput(manifest), sha256),
    presentationHash: digestOf(presentationHashInput(manifest), sha256),
  };
}
