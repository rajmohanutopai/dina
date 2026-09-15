/**
 * Jest stand-in for `@dina/net-expo/repo_proof` (§5.C1-mobile). The real module
 * statically imports the ESM-only `@atproto/*` libraries for Metro, which
 * ts-jest (CommonJS) cannot load. Boot tests only need the SEAM: the self-check
 * passes (the module "runs"), a verifier is wired, and it fails CLOSED like an
 * unreachable publisher — never a pass. Tests of the wiring's own failure paths
 * replace this with `jest.mock(...)` factories.
 */

import { repoProofFailure, type RepoProofVerifier } from '@dina/protocol';

export type RepoProofSelfCheck = { ok: true } | { ok: false; fault: string };

export function createRepoProofVerifier(): RepoProofVerifier {
  return async () => repoProofFailure('did_resolution_failed', 'jest stub: no network');
}

export async function selfCheckRepoProofVerifier(): Promise<RepoProofSelfCheck> {
  return { ok: true };
}
