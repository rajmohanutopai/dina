import { AsyncLocalStorage } from 'node:async_hooks';

import {
  setTraceScopeStorage,
  type TraceContext,
  type TraceScopeStorage,
} from './src/diagnostics/trace_correlation';

export class NodeTraceScopeStorage implements TraceScopeStorage {
  private readonly storage = new AsyncLocalStorage<TraceContext>();

  run<T>(trace: TraceContext, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(trace, fn);
  }

  getStore(): TraceContext | null {
    return this.storage.getStore() ?? null;
  }
}

let installedStorage: NodeTraceScopeStorage | null = null;

export function installNodeTraceScopeStorage(): NodeTraceScopeStorage {
  installedStorage ??= new NodeTraceScopeStorage();
  setTraceScopeStorage(installedStorage);
  return installedStorage;
}
