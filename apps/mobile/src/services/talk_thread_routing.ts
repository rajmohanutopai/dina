/**
 * Talk inbound thread routing — the seam-4 `threadResolver` boot wires into
 * `createNode`, extracted so the suite pins the REAL function (not a copy).
 *
 * Contact Services seam 5 (`sendServiceQuery`) stamps `origin_channel = peerDID`
 * onto the service_query workflow task. When the peer's `service.response`
 * lands, the `WorkflowEventConsumer` → `createServiceQueryDeliverer` calls this
 * resolver with `extractOriginChannel(task.payload)`; returning the peer DID
 * patches the pending card in THAT peer thread. The main-chat `query_service`
 * tool stamps a NON-DID origin (`'ask'` / `'chat'` / `''`), so we divert to a
 * peer thread ONLY when the origin is a DID — every other case returns null and
 * the deliverer falls back to its default `chatThreadId` ('main'), preserving
 * the main-tab behaviour exactly.
 *
 * Security note (§10 confused-deputy): `origin_channel` is stamped by THIS
 * node's own requester pipeline at dispatch (it is the thread we launched the
 * query from), not lifted from the peer's wire reply — so routing on it does
 * not let a peer steer which thread its response lands in. The deliverer
 * additionally matches the workflow `task.id` (the correlation key) before
 * patching, so a response can only ever touch the card our own dispatch
 * created.
 */

export interface TalkThreadResolverCtx {
  originChannel: string;
  eventKind: string;
  task: { id: string; kind: string };
}

/**
 * Resolve a workflow-event delivery to a Talk thread. Returns the peer DID for
 * a `did:`-shaped origin, else null (→ deliverer default thread).
 */
export function talkThreadResolver({ originChannel }: TalkThreadResolverCtx): string | null {
  return originChannel.startsWith('did:') ? originChannel : null;
}
