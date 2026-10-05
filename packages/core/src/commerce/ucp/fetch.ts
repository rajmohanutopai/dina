/**
 * UCP's outbound port (UCP plan §3.3): Core decides what may be fetched and
 * how much may come back; the host owns the socket. Each host installs its
 * `PolicySocket` (servers: `@dina/net-socket-node`; the phone: the DinaNet
 * native module through `@dina/net-expo/policy_socket`). A host that installs
 * none makes no UCP calls.
 *
 * `ucpFetch` runs the shared URL check (https, no credentials, no literal IP),
 * then the socket under a Core-held deadline, then narrows what came back at
 * once: the rest of Core sees only the allow-listed headers, and a signature
 * verifier sees only the header fields its `Signature-Input` covers. Raw
 * headers never leave this module.
 */

import { checkOutboundUrl } from '@dina/a2a';
import {
  narrowHeaders,
  selectSignedHeaders,
  type AllowedResponseHeader,
  type PolicySocket,
  type PolicySocketRequest,
  type PolicyTransportError,
  type SignedHeaderSelection,
} from '@dina/net-policy';
import { parseDictionary, SfParseError } from '@dina/ucp';

/** `no_identity`: a signed call whose signer went away (a sealed phone); nothing was sent. */
export type UcpFetchError = PolicyTransportError | 'url_refused' | 'unavailable' | 'no_identity';

export type UcpFetchResult =
  | {
      ok: true;
      status: number;
      /** The exact bytes received, for `Content-Digest`. */
      bodyBytes: Uint8Array;
      headers: Partial<Record<AllowedResponseHeader, string>>;
      /**
       * For an answer that carries `Signature` or `Signature-Input` (as
       * received, before any header was dropped for size): the fields its
       * signatures cover, or why they could not be collected (a verifier then
       * refuses the signature). Absent only when the answer is unsigned.
       */
      signedHeaders?: SignedHeaderSelection;
      connectedAddress: string;
    }
  | { ok: false; error: UcpFetchError; sent: boolean };

let installed: PolicySocket | null = null;

export function setUcpPolicySocket(socket: PolicySocket | null): void {
  installed = socket;
}

/**
 * The header fields any signature in `signatureInput` covers (RFC 9421
 * covered components that are not derived ones). Null when the header is not
 * a Dictionary: a verifier refuses such a signature anyway.
 */
export function coveredHeaderFields(signatureInput: string): string[] | null {
  let dict: ReturnType<typeof parseDictionary>;
  try {
    dict = parseDictionary(signatureInput);
  } catch (err) {
    if (err instanceof SfParseError) return null;
    throw err;
  }
  const names = new Set<string>();
  for (const [, member] of dict) {
    if (member.kind !== 'inner-list') continue;
    for (const item of member.items) {
      if (item.value.type === 'string' && !item.value.value.startsWith('@'))
        names.add(item.value.value);
    }
  }
  return [...names];
}

export async function ucpFetch(request: PolicySocketRequest): Promise<UcpFetchResult> {
  const check = checkOutboundUrl(request.url);
  if (!check.ok) return { ok: false, error: 'url_refused', sent: false };
  const socket = installed;
  if (socket === null) return { ok: false, error: 'unavailable', sent: false };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), request.timeoutMs);
  });
  let result: Awaited<ReturnType<PolicySocket>> | 'deadline';
  try {
    result = await Promise.race([
      socket(request).catch(
        // A socket that throws vouches for nothing: assume bytes left.
        (): Awaited<ReturnType<PolicySocket>> => ({ ok: false, error: 'io_error', sent: true }),
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
  // Core holds the deadline itself: a socket that overruns it counts as possibly sent.
  if (result === 'deadline') return { ok: false, error: 'timeout', sent: true };
  if (!result.ok) return result;

  const headers = narrowHeaders(result.rawHeaders);
  const out: UcpFetchResult = {
    ok: true,
    status: result.status,
    bodyBytes: result.bodyBytes,
    headers,
    connectedAddress: result.connectedAddress,
  };
  // Signed or not is read from what arrived: a signature header too large to keep is still a
  // signature, and one that cannot be checked fails; it never passes as an unsigned answer.
  const carriesSignature = result.rawHeaders.some(
    ([name]) => name === 'signature' || name === 'signature-input',
  );
  if (carriesSignature) {
    const signatureInput = headers['signature-input'];
    const fields = signatureInput === undefined ? null : coveredHeaderFields(signatureInput);
    out.signedHeaders =
      headers['signature'] === undefined || signatureInput === undefined
        ? { ok: false, reason: 'too_large' }
        : fields === null
          ? { ok: false, reason: 'missing' }
          : selectSignedHeaders(result.rawHeaders, fields);
  }
  return out;
}
