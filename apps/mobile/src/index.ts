// App package — runtime entrypoint for the React Native home node.
//
// Screens call `startDinaNode(opts)` once the user has unlocked their
// persona. Before this file existed, the app had no non-test caller of
// `createNode()` — the whole stack sat inert at launch (issue #1). The
// dependency bundle (identity, clients, storage adapters) is assembled
// in higher layers (not in this module) and passed to `startDinaNode`.

export { startDinaNode } from './services/startup';
export type { StartDinaNodeOptions } from './services/startup';
export { createNode } from './services/bootstrap';
export type { CreateNodeOptions, DinaNode, NodeRole } from './services/bootstrap';

export * from './notifications/local';
