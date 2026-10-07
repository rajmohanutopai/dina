/**
 * Stranger-name detection on the phone (docs/PII_ARCHITECTURE_V2.md §7): the
 * `DinaNames` native module (Apple's on-device model where Apple Intelligence
 * is on, NLTagger otherwise) installed as Brain's detector. Android has no
 * module, so no stranger detection runs there; known names still do.
 */

import { requireOptionalNativeModule } from 'expo';

import { installStrangerNames, StrangerNames, type NameDetector } from '@dina/brain';

import type { DinaNamesNative } from '../../modules/dina-names';

function nativeModule(): DinaNamesNative | null {
  try {
    return requireOptionalNativeModule<DinaNamesNative>('DinaNames');
  } catch {
    return null;
  }
}

/** A detector over the native module, or null where there is none. */
export function nativeNameDetector(
  native: DinaNamesNative | null = nativeModule(),
): NameDetector | null {
  if (native === null) return null;
  return {
    async detect(text: string, budgetMs: number) {
      const found = await native.findNames(text, Math.max(0, Math.floor(budgetMs)));
      return found.map((f) => ({ value: String(f.value), score: Number(f.score) }));
    },
  };
}

/**
 * Install stranger detection for Brain's model calls; returns which finder
 * runs ('model', 'tagger'), or null where none does. Loads the model in the
 * background so the first chat is not slow.
 */
export function wireNameDetector(
  native: DinaNamesNative | null = nativeModule(),
): 'model' | 'tagger' | null {
  const detector = nativeNameDetector(native);
  if (detector === null || native === null) {
    installStrangerNames(null);
    return null;
  }
  installStrangerNames(
    new StrangerNames({
      detector,
      onDegraded: (skipped) =>
        console.warn(
          '[pii] stranger detection ran out of time; paragraphs left to known names:',
          skipped,
        ),
    }),
  );
  void native.prewarm().catch(() => undefined);
  return native.mode();
}
