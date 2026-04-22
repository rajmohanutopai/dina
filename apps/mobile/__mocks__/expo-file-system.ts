/**
 * Mock `expo-file-system` for Jest tests.
 *
 * The real module is an Expo native-bridge export that ships as ESM
 * (`export * from './FileSystem'`) and depends on `ExpoFileSystem`, a
 * native module we don't ship in the Node test env. Production code
 * only reads `Paths.document.uri` — a stable file URL string — so the
 * mock provides a plausible default. Tests that need a specific path
 * can override by writing to `Paths.document.__uri`.
 */

export const Paths = {
  document: {
    uri: 'file:///tmp/dina-test/',
  },
};

export const File = class {};
export const Directory = class {};
