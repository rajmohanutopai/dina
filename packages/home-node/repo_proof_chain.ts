/**
 * Subpath entry `@dina/home-node/repo_proof_chain` — the platform-neutral
 * repo-proof chain (§5.C1) without the shared barrel, so a network adapter
 * (`@dina/net-node`, `@dina/net-expo`) pulls the chain and nothing else.
 */
export {
  createRepoProofChain,
  type AtprotoIdentityModule,
  type AtprotoLibs,
  type AtprotoRepoModule,
  type DidDoc,
  type DidService,
  type DidVerificationMethod,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
  type RepoProofChainDeps,
} from './src/repo_proof_chain';
export { selfCheckRepoProofChain, type RepoProofSelfCheck } from './src/repo_proof_selfcheck';
