/**
 * Wire the native file IO for backup export + restore (issues.txt §3).
 *
 * Lazy `require` (not static import) so this module compiles + the jest
 * suite runs WITHOUT `expo-document-picker` installed — the picker is a
 * native module that only resolves on a rebuilt dev client. The export
 * side uses `expo-sharing` + `expo-file-system`, both already deps.
 *
 * Call `wireNativeBackup()` once at app boot. Idempotent.
 */

import { configureSharing } from '../hooks/useShareExport';

import { configureRestore } from './restore_import';

let wired = false;

export function wireNativeBackup(): void {
  if (wired) return;
  wired = true;

  // ── Export: create → temp file → share sheet → cleanup ──
  configureSharing({
    share: async (fileUri: string, mimeType: string): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Sharing = require('expo-sharing');
      await Sharing.shareAsync(fileUri, { mimeType });
    },
    writeFile: async (data: Uint8Array, filename: string): Promise<string> => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { File, Paths } = require('expo-file-system');
      const f = new File(Paths.cache, filename);
      f.create({ overwrite: true });
      f.write(data);
      return f.uri;
    },
    deleteFile: async (fileUri: string): Promise<void> => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { File } = require('expo-file-system');
        new File(fileUri).delete();
      } catch {
        /* best-effort temp cleanup */
      }
    },
  });

  // ── Restore: OS document picker → read bytes ──
  // Only wire restore if the native picker is actually present in this
  // build — otherwise `isRestoreConfigured()` stays false and the Admin
  // screen shows an honest "rebuild the dev client" note instead of a
  // button that throws when tapped.
  let DocumentPicker: { getDocumentAsync: (o: unknown) => Promise<unknown> } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    DocumentPicker = require('expo-document-picker');
  } catch {
    DocumentPicker = null;
  }
  if (DocumentPicker === null) return;
  const picker = DocumentPicker;
  configureRestore({
    pickFile: async () => {
      const res = (await picker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      })) as { canceled?: boolean; assets?: { uri: string; name?: string }[] };
      const asset = res.canceled === true ? undefined : res.assets?.[0];
      if (asset === undefined) return null;
      return { uri: asset.uri, name: asset.name ?? 'backup.dina' };
    },
    readFile: async (uri: string): Promise<Uint8Array> => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { File } = require('expo-file-system');
      return new File(uri).bytes();
    },
  });
}
