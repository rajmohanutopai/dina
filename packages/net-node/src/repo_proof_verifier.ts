/**
 * The repo-proof verifier for the Node server (RESEARCHER_KERNEL §5.C1): the
 * shared chain (`@dina/home-node`'s `createRepoProofChain`) over the audited
 * AT-Protocol libraries, which this CommonJS package loads at runtime via a
 * real dynamic `import()` — `@atproto/*` are ESM-only. The loads are LAZY (first
 * verify, not construction): boot wires the verifier on every host start, and a
 * dynamic `import()` at construction would run under any CommonJS jest boot
 * test without `--experimental-vm-modules`, where Node aborts the process
 * (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG is fatal, not catchable).
 * Memoized once per process: the modules never change. A load that REJECTS is
 * forgotten, not memoized — the chain reports the failure as transient
 * (`verifier_unavailable`), and a retry that re-awaited the same rejected
 * promise would make that signal a lie for the life of the process.
 */

import {
  createRepoProofChain,
  type AtprotoIdentityModule,
  type AtprotoRepoModule,
  type RepoProofChainDeps,
} from '@dina/home-node/repo_proof_chain';

import type { RepoProofVerifier } from '@dina/protocol';

export type {
  AtprotoIdentityModule,
  AtprotoRepoModule,
  DidDoc,
  DidService,
  DidVerificationMethod,
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
} from '@dina/home-node/repo_proof_chain';

/**
 * `new Function` keeps the `import()` opaque to the CJS transpiler, so it stays
 * a real dynamic import (Node's ESM loader) rather than being rewritten to
 * `require()`. Fixed body — no interpolation, so no injection surface.
 */
const esmImport = new Function('s', 'return import(s)') as <T>(specifier: string) => Promise<T>;

/**
 * One lazily loaded ESM module: memoized on success, retried after a rejection.
 * `load` is injectable so the memo rule is testable without a real `import()`.
 */
export function lazyModule<T>(
  specifier: string,
  load: (specifier: string) => Promise<T> = esmImport,
): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () => {
    if (loading === null) {
      const attempt = load(specifier);
      loading = attempt;
      attempt.catch(() => {
        if (loading === attempt) loading = null;
      });
    }
    return loading;
  };
}

const loadIdentity = lazyModule<AtprotoIdentityModule>('@atproto/identity');
const loadRepo = lazyModule<AtprotoRepoModule>('@atproto/repo');

export type RepoProofVerifierDeps = Omit<RepoProofChainDeps, 'libs'>;

export function createRepoProofVerifier(deps: RepoProofVerifierDeps): RepoProofVerifier {
  return createRepoProofChain({
    ...deps,
    libs: { identity: loadIdentity, repo: loadRepo },
  });
}
