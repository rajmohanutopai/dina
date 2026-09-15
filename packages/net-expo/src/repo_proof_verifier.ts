/**
 * The repo-proof verifier for the phone (RESEARCHER_KERNEL §5.C1, C1-mobile):
 * the shared chain (`@dina/home-node`'s `createRepoProofChain`) over the same
 * audited AT-Protocol libraries the server uses, imported STATICALLY so Metro
 * bundles them (Metro has no runtime `import()`). A separate subpath
 * (`@dina/net-expo/repo_proof`), not the adapter's index: the libraries pull
 * Node-flavoured modules that the app shims in `metro.config.js`
 * (`node:timers/promises`, `node:dns/promises`, `@atproto/common`) and need a
 * `Buffer` global (the app's own `src/polyfills.ts` installs it), so only the
 * phone's boot should ever pay for them.
 *
 * What is proven where: the chain is verified offline in `@dina/net-node`'s
 * suite (the same function); this module's own suite runs the chain through
 * these static imports under Node; the Metro bundle is proven by a headless
 * `expo export`; Hermes at runtime is proven ON THE DEVICE by
 * `selfCheckRepoProofVerifier` — the whole chain over a fixture repo — which
 * boot runs before wiring the verifier. A host that fails it keeps its door
 * closed rather than reporting genuine releases as inauthentic.
 */

import * as identity from '@atproto/identity';
import * as repo from '@atproto/repo';

import {
  createRepoProofChain,
  selfCheckRepoProofChain,
  type AtprotoIdentityModule,
  type AtprotoLibs,
  type AtprotoRepoModule,
  type RepoProofChainDeps,
  type RepoProofSelfCheck,
} from '@dina/home-node/repo_proof_chain';

import type { RepoProofVerifier } from '@dina/protocol';

export type {
  DidDoc,
  DidService,
  DidVerificationMethod,
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  RepoProofSelfCheck,
} from '@dina/home-node/repo_proof_chain';

/** The statically bundled libraries, in the thunk shape the chain takes. */
const LIBS: AtprotoLibs = {
  identity: async () => identity as unknown as AtprotoIdentityModule,
  repo: async () => repo as unknown as AtprotoRepoModule,
};

export type RepoProofVerifierDeps = Omit<RepoProofChainDeps, 'libs'>;

export function createRepoProofVerifier(deps: RepoProofVerifierDeps): RepoProofVerifier {
  return createRepoProofChain({ ...deps, libs: LIBS });
}

/**
 * Does the chain RUN here? Verifies the shipped fixture repo end to end (CAR
 * read, commit signature, MST inclusion, `rkey = f(cid)`) through the bundled
 * libraries, offline. Boot wires the verifier only on `ok`.
 */
export function selfCheckRepoProofVerifier(): Promise<RepoProofSelfCheck> {
  return selfCheckRepoProofChain(LIBS);
}
