/**
 * Dead-drop spool port + message type. The portable contract that
 * non-Node consumers (drain logic, tests using fakes) depend on. The
 * concrete file-backed implementation lives in `./spool_node.ts` and
 * is reachable through the `@dina/core/node` package subpath.
 */

export interface SpoolMessage {
  id: string;
  blob: Uint8Array;
}

/** What the drain needs from a spool — narrow on purpose. */
export interface DeadDropSpoolPort {
  drainSpool(): SpoolMessage[];
}
