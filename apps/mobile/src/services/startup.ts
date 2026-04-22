/**
 * App-layer runtime entrypoint.
 *
 * `startDinaNode(opts)` is the thin wrapper an Expo screen (or the
 * root layout) calls once the user has unlocked their persona. It
 * composes a `DinaNode` from the app's dependency bundle (identity,
 * clients, storage) and kicks off `.start()`.
 *
 * This is NOT a full boot sequence — identity loading, PDS login,
 * SQLite bootstrap, MsgBox wiring all happen in the layers above.
 * `startDinaNode` just binds those pieces to `createNode()` so the
 * package has a callable runtime entrypoint instead of a placeholder
 * (issue #1).
 *
 * Once wired, cache the returned `DinaNode` in app state — pass it
 * into screens via context, and invoke `dispose()` on logout.
 */

import { createNode, type CreateNodeOptions, type DinaNode } from './bootstrap';

export type StartDinaNodeOptions = CreateNodeOptions;

/**
 * Compose + start a DinaNode. Returns the live handle once `start()`
 * resolves (which in turn awaits MsgBox authentication if a URL was
 * supplied). Caller owns `dispose()` at tear-down.
 */
export async function startDinaNode(options: StartDinaNodeOptions): Promise<DinaNode> {
  const node = await createNode(options);
  await node.start();
  return node;
}
