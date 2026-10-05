/**
 * dina-net — JS surface of the native pinned-HTTP module (UCP plan §3.4, U6).
 *
 * The policy lives in TypeScript (`@dina/net-expo/policy_socket`, over
 * `@dina/net-policy`); this module only does what React Native `fetch` cannot:
 *
 *   resolveHost(host): Promise<string[]>
 *     Every A and AAAA answer from the system resolver, as address text. On
 *     an IPv6-only network iOS synthesises NAT64 answers (64:ff9b::/96).
 *
 *   fetchPinned(request): Promise<NativePinnedResult>
 *     One HTTP/1.1 exchange over TLS (at least `minTls`) to exactly
 *     `request.address`, with SNI and certificate validation against the
 *     URL's host, no proxy, no redirect followed, `Connection: close`, and the
 *     byte, header and time caps enforced while reading. `sent` is false only
 *     when the failure came before the TLS handshake finished.
 *
 * The request and result shapes are `NativePinnedRequest` /
 * `NativePinnedResult` in `@dina/net-expo/policy_socket`.
 */

export type { DinaNetNative as DinaNetNativeModule } from '@dina/net-expo/policy_socket';
