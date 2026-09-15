/**
 * The phone's repo-proof verifier wiring (RESEARCHER_KERNEL §5.C1, C1-mobile).
 * Wires `@dina/net-expo/repo_proof` — the shared chain over the audited
 * AT-Protocol stack, statically imported for Metro — into Core's injection seam
 * (`setRepoProofVerifier`) so the Plugins door opens on the phone.
 *
 * SELF-CHECK BEFORE THE DOOR OPENS. The chain maps a throw inside a library
 * call to a permanent verdict on the release (`record_malformed`,
 * `signature_invalid`): right for a hostile CAR, wrong for a platform fault —
 * a runtime missing a global the library needs would tell the owner a genuine
 * release failed authenticity, with no retry that could ever help. So boot
 * first runs the whole chain over a fixture repo the package ships
 * (`selfCheckRepoProofVerifier`); only a host that passes gets a verifier. A
 * host that fails keeps the door closed — `pluginInstallAvailable()` is false
 * and the screen says installing is off in this build — and the log carries
 * the fault class or code, never a request.
 *
 * FAULT GUARD, still. A throw the self-check did not foresee (a Hermes quirk on
 * one input) becomes a typed, transient `did_resolution_failed` — never a
 * crash and never a trust-on-first-use. Metadata only reaches the log.
 */

import { createRepoProofVerifier, selfCheckRepoProofVerifier } from '@dina/net-expo/repo_proof';
import { repoProofFailure, type RepoProofResult, type RepoProofVerifier } from '@dina/protocol';

/**
 * The verifier for this device, or null when the chain cannot run here. Boot
 * wires the result only when it is non-null.
 */
export async function makeMobileRepoProofVerifier(): Promise<RepoProofVerifier | null> {
  let check: Awaited<ReturnType<typeof selfCheckRepoProofVerifier>>;
  try {
    check = await selfCheckRepoProofVerifier();
  } catch (err) {
    check = { ok: false, fault: err instanceof Error ? err.constructor.name : typeof err };
  }
  if (!check.ok) {
    console.warn('[plugins] repo-proof verifier self-check failed; install door stays closed', check.fault);
    return null;
  }
  const verify = createRepoProofVerifier({ fetch: (url, init) => fetch(url, init) });
  return async (req): Promise<RepoProofResult> => {
    try {
      return await verify(req);
    } catch (err) {
      console.warn(
        '[plugins] repo-proof verifier fault',
        err instanceof Error ? err.constructor.name : typeof err,
      );
      return repoProofFailure('did_resolution_failed', 'the verifier could not run on this device');
    }
  };
}
