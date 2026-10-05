/**
 * The server host's A2A transport (design §6.6, plan §3.10): A2A's rules over
 * the shared Node policy socket (`@dina/net-socket-node`, UCP plan §3.3), so
 * UCP and A2A run on one socket implementation and one classifier. Core's
 * Lane 1 calls go through it, and so do the A2A gateway's webhook pushes; both
 * processes install the same function, so a webhook cannot reach what a Lane 1
 * call could not.
 *
 * The socket resolves the name once and refuses if any answer is special-use,
 * pins the connection to a vetted address with TLS checked against the name,
 * follows no redirect, and caps the answer; the adapter
 * (`a2aTransportFromPolicySocket`, in Core) adds A2A's own rules: the URL
 * check, JSON answers or the status only, 401/403 bodies discarded, UTF-8.
 * A forbidden destination receives no connection at all.
 */

import { a2aTransportFromPolicySocket, type A2AHostTransport } from '@dina/core';
import { createNodePolicySocket, type NodePolicySocketOptions } from '@dina/net-socket-node';

export type A2AHostTransportOptions = NodePolicySocketOptions;

export function createA2AHostTransport(options: A2AHostTransportOptions = {}): A2AHostTransport {
  return a2aTransportFromPolicySocket(createNodePolicySocket(options));
}
