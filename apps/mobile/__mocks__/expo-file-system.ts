/**
 * Mock `expo-file-system` for Jest tests.
 *
 * The real module is an Expo native-bridge export that ships as ESM
 * and depends on `ExpoFileSystem`, a native module we don't ship in
 * the Node test env. The mock simulates a tiny in-memory document
 * directory:
 *   - `Paths.document.exists` — boolean toggleable via `__setExists`.
 *   - `Paths.document.list()` — returns `MockEntry[]` seeded by
 *     `__setEntries(['identity.sqlite', ...])`.
 *   - Each entry has `.name`, `.delete()`. `delete()` removes the
 *     entry from the in-memory list AND records it in
 *     `__getDeletedEntries()` so tests can assert on what was wiped.
 *
 * `__resetFileSystemMock()` clears state between tests.
 */

interface MockEntry {
  name: string;
  delete: () => void;
}

let entries: MockEntry[] = [];
let deleted: string[] = [];
let exists = true;
let throwOnList = false;
let throwOnDelete: Set<string> = new Set();

function makeEntry(name: string): MockEntry {
  return {
    name,
    delete(): void {
      if (throwOnDelete.has(name)) {
        throw new Error(`mock fs: delete failed for ${name}`);
      }
      deleted.push(name);
      entries = entries.filter((e) => e.name !== name);
    },
  };
}

export const Paths = {
  document: {
    get uri(): string {
      return 'file:///tmp/dina-test/';
    },
    get exists(): boolean {
      return exists;
    },
    list(): MockEntry[] {
      if (throwOnList) {
        throw new Error('mock fs: list failed');
      }
      return [...entries];
    },
  },
};

export const File = class {};
export const Directory = class {};

// ── Test helpers (prefixed `__` so production code can't reach them) ──

export function __setEntries(names: string[]): void {
  entries = names.map((n) => makeEntry(n));
}

export function __getEntries(): string[] {
  return entries.map((e) => e.name);
}

export function __getDeletedEntries(): string[] {
  return [...deleted];
}

export function __setExists(value: boolean): void {
  exists = value;
}

export function __throwOnList(value: boolean): void {
  throwOnList = value;
}

export function __throwOnDelete(name: string): void {
  throwOnDelete.add(name);
}

export function __resetFileSystemMock(): void {
  entries = [];
  deleted = [];
  exists = true;
  throwOnList = false;
  throwOnDelete = new Set();
}
