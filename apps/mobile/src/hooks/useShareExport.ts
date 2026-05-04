/**
 * Share export hook — share .dina archive files via platform share sheet.
 *
 * Flow:
 *   1. Create encrypted .dina archive (calls Core export/archive)
 *   2. Write archive to temporary file in app cache directory
 *   3. Present platform share sheet (AirDrop, Files, email, etc.)
 *   4. Clean up temp file after sharing
 *
 * The native sharing is behind an injectable function so the hook
 * is fully testable without expo-sharing at runtime.
 *
 * Source: ARCHITECTURE.md Task 9.7
 */

import { createArchive } from '@dina/core';

export type ShareStatus = 'idle' | 'creating_archive' | 'sharing' | 'shared' | 'failed';

export interface ShareState {
  status: ShareStatus;
  error: string | null;
  archiveSizeBytes: number | null;
  sharedAt: number | null;
}

/** Injectable sharing function — in production, calls expo-sharing. */
let shareFn: ((fileUri: string, mimeType: string) => Promise<void>) | null = null;

/** Injectable temp file writer — in production, writes to FileSystem.cacheDirectory. */
let writeFileFn: ((data: Uint8Array, filename: string) => Promise<string>) | null = null;

/** Injectable temp file cleanup. */
let deleteFileFn: ((fileUri: string) => Promise<void>) | null = null;

let state: ShareState = createInitialState();

function createInitialState(): ShareState {
  return { status: 'idle', error: null, archiveSizeBytes: null, sharedAt: null };
}

/** Configure the native sharing functions. */
export function configureSharing(config: {
  share: (fileUri: string, mimeType: string) => Promise<void>;
  writeFile: (data: Uint8Array, filename: string) => Promise<string>;
  deleteFile: (fileUri: string) => Promise<void>;
}): void {
  shareFn = config.share;
  writeFileFn = config.writeFile;
  deleteFileFn = config.deleteFile;
}

/**
 * Create and share a .dina archive.
 *
 * @param passphrase — passphrase to encrypt the archive
 * @returns The share state after completion
 */
export async function shareArchive(passphrase: string): Promise<ShareState> {
  state = createInitialState();

  if (!passphrase) {
    state.status = 'failed';
    state.error = 'Passphrase is required to encrypt the archive';
    return { ...state };
  }

  if (!shareFn || !writeFileFn) {
    state.status = 'failed';
    state.error = 'Sharing not configured — native modules required';
    return { ...state };
  }

  // Step 1: Create encrypted archive
  state.status = 'creating_archive';
  let archive: Uint8Array;
  try {
    archive = await createArchive(passphrase);
    state.archiveSizeBytes = archive.length;
  } catch (err) {
    state.status = 'failed';
    state.error = `Archive creation failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ...state };
  }

  // Step 2: Write to temp file
  let fileUri: string;
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fileUri = await writeFileFn(archive, `dina-export-${timestamp}.dina`);
  } catch (err) {
    state.status = 'failed';
    state.error = `File write failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ...state };
  }

  // Step 3: Share via platform sheet
  state.status = 'sharing';
  try {
    await shareFn(fileUri, 'application/octet-stream');
    state.status = 'shared';
    state.sharedAt = Date.now();
  } catch (err) {
    state.status = 'failed';
    state.error = `Sharing failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Step 4: Clean up temp file (best-effort)
  if (deleteFileFn) {
    try {
      await deleteFileFn(fileUri);
    } catch {
      /* best-effort */
    }
  }

  return { ...state };
}

/** Get current share state. */
export function getShareState(): ShareState {
  return { ...state };
}

/** Reset (for testing). */
export function resetShareExport(): void {
  state = createInitialState();
  shareFn = null;
  writeFileFn = null;
  deleteFileFn = null;
}
