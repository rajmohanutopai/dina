/**
 * Brain-server bootstrap composer — template for task 5.1.
 *
 * The brain-server startup wires a chain of primitives:
 *
 *   loadBrainConfig(env)            → BrainConfig
 *   loadServiceKey({keyDir})        → {seed, fingerprint}
 *   createEd25519Signer(seed)       → Ed25519Signer
 *   createCanonicalSigner({...})    → request signer
 *   createBrainPinoLogger({level})  → pino logger
 *   new BrainLogger({emit})         → structured logger
 *   new CommandDispatcher()         → commands
 *   buildUserCommands(ctx).forEach(register)
 *
 * This module does exactly that composition in `bootstrapBrain(opts)`
 * — a single call returns the `BrainBootstrap` struct the Fastify
 * app (task 5.1) consumes. Every sub-step is independently testable
 * via its own primitive; this composer is the recipe.
 *
 * **Strict failure mode**: any step returning an `ok: false` outcome
 * short-circuits into a structured rejection — the caller logs and
 * exits. Fail-closed at boot prevents a half-configured brain from
 * running.
 *
 * **No HTTP yet** — the bootstrap produces everything the server
 * NEEDS at boot, but the Fastify instance is constructed by task
 * 5.1. This module stops at "ready-to-wire".
 *
 * **Injectable boundaries**:
 *   - `env` → defaults to `process.env` (matches `loadBrainConfig`).
 *   - `readFileFn` → defaults to fs/promises for key loading.
 *   - `serviceDid` → callers supply the DID the signer binds to;
 *     brain-server reads it from Core (`/v1/did/*`) but this
 *     primitive keeps Core-awareness out of scope. 5.1 wires the
 *     DID fetch separately.
 */

import {
  BrainLogger,
  type LogEmitFn,
} from './brain_logger';
import {
  type BrainConfig,
  type BrainConfigError,
  type LoadBrainConfigOptions,
  loadBrainConfig,
} from './brain_config';
import {
  createCanonicalSigner,
} from './canonical_signer';
import {
  CommandDispatcher,
} from './command_dispatcher';
import type { CoreClient } from './core_client';
import {
  createEd25519Signer,
  type Ed25519Signer,
} from './ed25519_signer';
import {
  createBrainPinoLogger,
  createPinoSink,
} from './pino_sink';
import {
  type ServiceKeyLoadInput,
  type ServiceKeyLoadOutcome,
  loadServiceKey,
} from './service_key_loader';
import {
  buildUserCommands,
  type UserCommandContext,
} from './user_commands';

export interface BootstrapBrainOptions {
  /** Forwarded to `loadBrainConfig`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Programmatic config overrides. */
  overrides?: LoadBrainConfigOptions['overrides'];
  /** DID the signer binds to. Brain-server discovers this from Core at boot. */
  serviceDid: string;
  /**
   * Directory containing the service-key file. Defaults to
   * `<config.configDir>/keys`.
   */
  keyDir?: string;
  /** Key filename. Defaults to `brain.ed25519`. */
  keyFileName?: string;
  /** Optional CoreClient — some commands (/status, /personas, /search) use it. */
  core?: CoreClient;
  /** Unix ms at boot start — feeds `/status` uptime. */
  bootStartedMs?: number;
  /** Pretty-print logs. Defaults to false. */
  pretty?: boolean;
  /**
   * Optional LogEmitFn for tests — swaps out pino entirely. When
   * absent the bootstrap wires pino as the sink.
   */
  logEmitFn?: LogEmitFn;
  /** Injected key-file reader (tests). */
  readFileFn?: ServiceKeyLoadInput['readFileFn'];
  /** Injected SHA-256 (tests). */
  sha256Fn?: ServiceKeyLoadInput['sha256Fn'];
}

export interface BrainBootstrap {
  config: BrainConfig;
  keyFingerprint: string;
  ed25519Signer: Ed25519Signer;
  canonicalSigner: ReturnType<typeof createCanonicalSigner>;
  pino: ReturnType<typeof createBrainPinoLogger>;
  logger: BrainLogger;
  dispatcher: CommandDispatcher;
}

export type BootstrapRejection =
  | { stage: 'config'; code: string; detail: Record<string, string> }
  | { stage: 'service_key'; code: string; detail: string }
  | { stage: 'signer'; detail: string };

export type BootstrapOutcome =
  | { ok: true; bootstrap: BrainBootstrap }
  | { ok: false; error: BootstrapRejection };

/**
 * Run the full bootstrap chain. Returns a tagged outcome — never
 * throws. Callers that want to fail-fast can `if (!r.ok) throw ...`.
 */
export async function bootstrapBrain(
  opts: BootstrapBrainOptions,
): Promise<BootstrapOutcome> {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: { stage: 'signer', detail: 'opts required' } };
  }
  if (typeof opts.serviceDid !== 'string' || !opts.serviceDid.startsWith('did:')) {
    return { ok: false, error: { stage: 'signer', detail: 'serviceDid must be a DID' } };
  }

  // 1. Config.
  let config: BrainConfig;
  try {
    const loadOpts: LoadBrainConfigOptions = {};
    if (opts.env) loadOpts.env = opts.env;
    if (opts.overrides) loadOpts.overrides = opts.overrides;
    config = loadBrainConfig(loadOpts);
  } catch (err) {
    const e = err as BrainConfigError;
    return {
      ok: false,
      error: { stage: 'config', code: e.code ?? 'unknown', detail: e.detail ?? { message: String(err) } },
    };
  }

  // 2. Service key — default keyDir is `<configDir>/keys`.
  const keyDir = opts.keyDir ?? `${config.configDir}/keys`;
  const keyLoadInput: ServiceKeyLoadInput = { keyDir };
  if (opts.keyFileName !== undefined) keyLoadInput.fileName = opts.keyFileName;
  if (opts.readFileFn !== undefined) keyLoadInput.readFileFn = opts.readFileFn;
  if (opts.sha256Fn !== undefined) keyLoadInput.sha256Fn = opts.sha256Fn;
  const keyResult: ServiceKeyLoadOutcome = await loadServiceKey(keyLoadInput);
  if (!keyResult.ok) {
    return {
      ok: false,
      error: { stage: 'service_key', code: keyResult.reason, detail: keyResult.detail },
    };
  }

  // 3. Ed25519 signer + canonical request signer.
  let ed25519Signer: Ed25519Signer;
  try {
    ed25519Signer = createEd25519Signer(keyResult.seed);
  } catch (err) {
    return { ok: false, error: { stage: 'signer', detail: extractMessage(err) } };
  }
  let canonicalSigner: ReturnType<typeof createCanonicalSigner>;
  try {
    canonicalSigner = createCanonicalSigner({
      did: opts.serviceDid,
      signer: ed25519Signer,
    });
  } catch (err) {
    return { ok: false, error: { stage: 'signer', detail: extractMessage(err) } };
  }

  // 4. Logging — pino + BrainLogger bridge.
  // BrainLogger is the single source of `service` on every record.
  // Pass `serviceName: null` to pino so it doesn't bind the field at
  // its base — prevents a duplicate `service` key on the wire.
  const pino = createBrainPinoLogger({
    level: config.logLevel,
    pretty: opts.pretty ?? false,
    serviceName: null,
  });
  const logger = new BrainLogger({
    level: config.logLevel === 'fatal' || config.logLevel === 'trace'
      ? 'info'
      : config.logLevel,
    emit: opts.logEmitFn ?? createPinoSink(pino),
    serviceName: 'brain',
  });

  // 5. CommandDispatcher + user commands.
  const dispatcher = new CommandDispatcher();
  const cmdCtx: UserCommandContext = {
    listCommandsFn: () => dispatcher.list('user'),
    serviceKeyFingerprint: keyResult.fingerprint,
  };
  if (opts.core !== undefined) cmdCtx.core = opts.core;
  if (opts.bootStartedMs !== undefined) {
    cmdCtx.bootStartedMsFn = () => opts.bootStartedMs!;
  }
  for (const cmd of buildUserCommands(cmdCtx)) {
    dispatcher.register(cmd);
  }

  return {
    ok: true,
    bootstrap: {
      config,
      keyFingerprint: keyResult.fingerprint,
      ed25519Signer,
      canonicalSigner,
      pino,
      logger,
      dispatcher,
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
