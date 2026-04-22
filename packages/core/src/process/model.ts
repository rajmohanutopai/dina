/**
 * Platform process model — Android vs iOS separation.
 *
 * Android: real OS-level process separation.
 *   - Core runs as a Foreground Service in the `:core` process
 *   - Separate memory space (no shared closures, no shared JS context)
 *   - Survives app backgrounding via persistent notification
 *
 * iOS: logical separation within the same OS process.
 *   - Core and Brain run in separate JavaScriptCore contexts
 *   - Shared OS-level memory (but no shared JS variables)
 *   - Background survival limited by iOS platform constraints
 *
 * Both platforms:
 *   - Core ↔ Brain communication via localhost HTTP with Ed25519 auth
 *   - Core and Brain have separate JS contexts (no shared closures)
 *
 * Source: ARCHITECTURE.md Section 23.1
 */

export type Platform = 'android' | 'ios';

/**
 * Check if Core runs in a separate OS process.
 * Android: true (Foreground Service in :core process)
 * iOS: false (same OS process, separate JS context only)
 */
export function isOSProcessSeparated(platform: Platform): boolean {
  return platform === 'android';
}

/**
 * Check if Core and Brain share OS-level memory.
 * Android: false (separate processes have separate memory)
 * iOS: true (same process — but separated by JS context boundary)
 */
export function sharesMemory(platform: Platform): boolean {
  return platform === 'ios';
}

/**
 * Check if Core survives app backgrounding.
 * Android: true (Foreground Service persists)
 * iOS: false (platform kills background processes eventually)
 */
export function survivesBackground(platform: Platform): boolean {
  return platform === 'android';
}

/**
 * Check if Core communicates with Brain via localhost HTTP.
 * Always true on mobile — this is the architecture's process boundary.
 */
export function usesLocalhostHTTP(): boolean {
  return true;
}

/**
 * Check if Core and Brain have separate JS contexts.
 * Always true on both platforms.
 */
export function hasSeparateJSContexts(platform: Platform): boolean {
  return true;
}
