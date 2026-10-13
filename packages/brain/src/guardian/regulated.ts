/**
 * No verdicts about the owner from the model's own knowledge
 * (REAL_LIFE_FIXES_2 §6.2).
 *
 * On a health, legal or money turn, two deterministic tests run on Dina's
 * reply against the evidence the model was given (the owner's turns, the
 * tool and retrieval results, today's date). Dina's own earlier replies are
 * never evidence, so an earlier mistake cannot back a later one.
 *
 * - Verdict words about the owner ("normal range", "pre-diabetic",
 *   "entitled to", …) are never judged by whether their words appear
 *   somewhere: that cannot tell whose result it is or whether it was
 *   negated. A sentence with one is replaced by the one evidence item that
 *   says it, quoted, or removed.
 * - A figure (a dose, a threshold, a period, an amount) in a regulated
 *   sentence that the evidence neither states nor lets one compute is
 *   removed.
 *
 * A removal adds one line naming who decides. Brain-side and deterministic;
 * it starts in `report` mode (REAL_LIFE_FIXES_2 §0).
 */

import { splitSentences } from './guard_scan';

const REGULATED_TERMS =
  /\b(diagnos\w*|diabet\w*|dr|blood|sugar|glucose|hba1c|cholesterol|ldl|hdl|pressure|vaccin\w*|booster|dose|dosage|medicin\w*|tablet|pill|prescri\w*|symptom\w*|doctor|paediatric\w*|pediatric\w*|clinic|hospital|disease|condition|thyroid|kidney|creatinine|compensation|claim|liab\w*|refund|contract|lawyer|legal|law|statut\w*|convention|airline|luggage|baggage|insurance|policy|tax|loan|interest rate|invest\w*|pension)\b/i;

const VERDICTS =
  /\b(normal range|within (the )?normal|pre-?diabet\w*|diabetic|hypertensive|anaemic|anemic|entitled to|eligible for|liable|due for (a |an |the |your )?(vaccine|vaccination|booster|dose|shot|test|check|screening)|compensation of)\b/i;

/** A number with a unit that makes it a threshold, dose, period or amount. */
const FIGURE =
  /(?:[₹$€£]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|mg|mcg|µg|g\b|ml|mmol\/l|mg\/dl|units?|days?|weeks?|months?|years?|hours?|sdr|rupees|dollars|euros|pounds))/gi;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface RegulatedResult {
  text: string;
  removed: number;
  quoted: number;
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter((n) => Number.isFinite(n));
}

/** Dates written like "3 March 2026", "12 January", "2026-03-03". */
function datesIn(text: string, year: number): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:,?\s+(\d{4}))?/g)) {
    const mon = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (mon < 0) continue;
    out.push(Date.UTC(m[3] !== undefined ? Number(m[3]) : year, mon, Number(m[1])));
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return out;
}

/** True when `n` is stated in, or computable from, the evidence. */
function supported(n: number, evidenceNumbers: readonly number[], dayGaps: readonly number[]): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9 || Math.abs(a - b) <= Math.abs(b) * 1e-6;
  if (evidenceNumbers.some((e) => close(e, n))) return true;
  if (dayGaps.some((g) => close(g, n) || close(Math.round(g / 7), n) || close(Math.round(g / 30), n))) return true;
  // A date gap against a stated period: "promised in 5 days, 9 days ago" → 4 overdue.
  if (dayGaps.some((g) => evidenceNumbers.some((e) => close(Math.abs(g - e), n)))) return true;
  for (let i = 0; i < evidenceNumbers.length; i++)
    for (let j = 0; j < evidenceNumbers.length; j++) {
      if (i === j) continue;
      const a = evidenceNumbers[i]!;
      const b = evidenceNumbers[j]!;
      if (close(a + b, n) || close(Math.abs(a - b), n)) return true;
    }
  return false;
}

/**
 * Check `reply` on a regulated turn. `evidence` is a list of separate items
 * (each stored fact or tool value on its own) plus the owner's own words;
 * `nowMs` is today, for date gaps.
 */
export function checkRegulated(
  reply: string,
  input: { question: string; evidence: readonly string[]; nowMs: number; whoDecides?: string },
): RegulatedResult {
  const allEvidence = [input.question, ...input.evidence];
  const regulatedTurn =
    VERDICTS.test(reply) || REGULATED_TERMS.test(input.question) || input.evidence.some((e) => REGULATED_TERMS.test(e));
  if (!regulatedTurn) return { text: reply, removed: 0, quoted: 0 };
  const evidenceNumbers = allEvidence.flatMap(numbersIn);
  const year = new Date(input.nowMs).getUTCFullYear();
  const today = Date.UTC(year, new Date(input.nowMs).getUTCMonth(), new Date(input.nowMs).getUTCDate());
  const dayGaps = allEvidence.flatMap((e) => datesIn(e, year)).map((d) => Math.abs(today - d) / 86_400_000);

  let text = reply;
  let removed = 0;
  let quoted = 0;
  const replace = (sentence: string, line: string) => {
    const at = text.indexOf(sentence);
    if (at < 0) return;
    const before = text.slice(0, at).replace(/[ \t]+$/, '');
    const after = text.slice(at + sentence.length).replace(/^[ \t]+/, '');
    const join = line === '' && (before === '' || after === '' || /\n$/.test(before) || /^\n/.test(after)) ? '' : ' ';
    text = line === '' ? before + join + after : `${before}${before === '' || /\n$/.test(before) ? '' : ' '}${line}${after === '' || /^\n/.test(after) ? '' : ' '}${after}`;
  };

  for (const sentence of splitSentences(reply)) {
    if (VERDICTS.test(sentence)) {
      const verdict = VERDICTS.exec(sentence)![0];
      const holders = input.evidence.filter((e) => new RegExp(verdict.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(e));
      if (holders.length === 1) {
        replace(sentence, `Your notes say: "${holders[0]!.trim().replace(/\s+/g, ' ').slice(0, 300)}"`);
        quoted++;
      } else {
        replace(sentence, '');
        removed++;
      }
      continue;
    }
    if (!REGULATED_TERMS.test(sentence)) continue;
    const figures = [...sentence.matchAll(FIGURE)].map((m) => m[0]);
    const unsupported = figures.some((f) => numbersIn(f).some((n) => !supported(n, evidenceNumbers, dayGaps)));
    if (unsupported) {
      replace(sentence, '');
      removed++;
    }
  }
  if (removed > 0) {
    const who = input.whoDecides !== undefined && input.whoDecides !== '' ? input.whoDecides : 'the person who decides (your doctor, the airline, your insurer or adviser)';
    text = `${text.trim()}\n\nFor what this means for you, ask ${who}.`;
  }
  return { text: text.trim(), removed, quoted };
}

/** Separate evidence items from tool results: every string value on its own. */
export function evidenceFromToolResults(results: readonly unknown[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === 'string') {
      if (v.trim() !== '') out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  for (const r of results) walk(r, 0);
  return out;
}
