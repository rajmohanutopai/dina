/**
 * dina-names — JS surface of the native name finder
 * (docs/PII_ARCHITECTURE_V2.md §7). iPhone only; on Android the module is
 * absent and no stranger detection runs.
 *
 *   mode(): 'model' | 'tagger'
 *     Apple's on-device model where Apple Intelligence is on (iOS 26+),
 *     NLTagger otherwise.
 *
 *   prewarm(): Promise<void>
 *     Loads the model so the first answer is not slow.
 *
 *   findNames(text, budgetMs): Promise<{ value, score, source }[]>
 *     Candidate people's names, as written in the text, in about `budgetMs`:
 *     the model reads while time is left, the tagger reads the rest.
 *     Candidates only: Brain filters them and decides what to hide.
 */

export interface DinaNamesNative {
  mode(): 'model' | 'tagger';
  prewarm(): Promise<void>;
  findNames(
    text: string,
    budgetMs: number,
  ): Promise<{ value: string; score: number; source: string }[]>;
}
