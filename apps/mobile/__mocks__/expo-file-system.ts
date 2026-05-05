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

// In-memory file-system for the `File` API. Keyed by the same name the
// production code passes (e.g. `.dina_install`). Tests can pre-populate
// or assert on contents through the `__set*` helpers below.
const fileContents: Map<string, string> = new Map();
let throwOnFileExists = false;
let throwOnFileWrite: Set<string> = new Set();

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

export class File {
  private name: string;
  constructor(_dir: { uri: string }, name: string) {
    this.name = name;
  }
  get exists(): boolean {
    if (throwOnFileExists) throw new Error('mock fs: exists check failed');
    return fileContents.has(this.name);
  }
  create(): void {
    if (!fileContents.has(this.name)) fileContents.set(this.name, '');
  }
  write(body: string): void {
    if (throwOnFileWrite.has(this.name)) {
      throw new Error(`mock fs: write failed for ${this.name}`);
    }
    fileContents.set(this.name, body);
  }
  text(): Promise<string> {
    return Promise.resolve(fileContents.get(this.name) ?? '');
  }
  textSync(): string {
    return fileContents.get(this.name) ?? '';
  }
}
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

export function __setFileContents(name: string, body: string): void {
  fileContents.set(name, body);
}

export function __getFileContents(name: string): string | undefined {
  return fileContents.get(name);
}

export function __hasFile(name: string): boolean {
  return fileContents.has(name);
}

export function __throwOnFileExists(value: boolean): void {
  throwOnFileExists = value;
}

export function __throwOnFileWrite(name: string): void {
  throwOnFileWrite.add(name);
}

export function __resetFileSystemMock(): void {
  entries = [];
  deleted = [];
  exists = true;
  throwOnList = false;
  throwOnDelete = new Set();
  fileContents.clear();
  throwOnFileExists = false;
  throwOnFileWrite = new Set();
}
