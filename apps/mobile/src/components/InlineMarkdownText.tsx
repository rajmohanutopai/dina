/**
 * `InlineMarkdownText` — render `**bold**`, `*italic*`, `` `code` ``
 * inside a chat bubble's body `<Text>`.
 *
 * Why a zero-dep parser instead of `react-native-markdown-display`?
 *   - The LLM-emitted markdown in Dina answers is overwhelmingly the
 *     three inline spans handled here, plus plain `\n\n` paragraphs
 *     (which RN `<Text>` already renders correctly). Adding a full
 *     CommonMark engine for that surface is a 100KB bundle hit for
 *     two regex replaces.
 *   - Block-level constructs (lists, headings, code blocks) would
 *     require breaking the message bubble into multiple `<View>`s,
 *     which fights the bubble layout (sender label, body, timestamp
 *     all in one flow). Inline-only keeps the bubble shape stable.
 *
 * If the LLM later starts emitting links or block constructs that
 * matter, swap this for `react-native-markdown-display` — call site
 * is one component, this stays the seam.
 *
 * Edge cases:
 *   - Empty markers (`**`, ``` `` ```) require at least one non-marker
 *     non-newline char inside; the regex excludes empties.
 *   - Nested markers (`**bold *italic* bold**`) only render the
 *     outer span; inner markers stay literal. Real markdown engines
 *     handle this; not worth it for current LLM output.
 *   - Unmatched markers (`Acme** Inc`) pass through as literal text.
 */

import React from 'react';
import { StyleSheet, Text, type TextStyle, type StyleProp } from 'react-native';

import { fonts } from '../theme';

interface Props {
  children: string;
  style?: StyleProp<TextStyle>;
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string };

/**
 * Single regex with three alternations. Order matters — `**...**`
 * must be tested before `*...*` so the bold marker isn't eaten by the
 * italic branch. Inner classes exclude the marker char and newlines so
 * spans don't span paragraph breaks (matches how Slack / iMessage parse).
 */
const TOKEN_RE = /\*\*([^*\n](?:[^*\n]|\*(?!\*))*?)\*\*|\*([^*\n][^*\n]*?)\*|`([^`\n]+?)`/g;

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  // `matchAll` requires the `g` flag — TOKEN_RE has it.
  for (const m of s.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', value: s.slice(last, idx) });
    if (m[1] !== undefined) out.push({ kind: 'bold', value: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'italic', value: m[2] });
    else if (m[3] !== undefined) out.push({ kind: 'code', value: m[3] });
    last = idx + m[0].length;
  }
  if (last < s.length) out.push({ kind: 'text', value: s.slice(last) });
  return out;
}

export function InlineMarkdownText({ children, style }: Props): React.JSX.Element {
  const tokens = tokenize(children);
  return (
    <Text style={style}>
      {tokens.map((t, i) => {
        if (t.kind === 'bold') {
          return (
            <Text key={i} style={styles.bold}>
              {t.value}
            </Text>
          );
        }
        if (t.kind === 'italic') {
          return (
            <Text key={i} style={styles.italic}>
              {t.value}
            </Text>
          );
        }
        if (t.kind === 'code') {
          return (
            <Text key={i} style={styles.code}>
              {t.value}
            </Text>
          );
        }
        return t.value;
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  // iOS-RN gotcha: setting `fontWeight: '700'` on a nested `<Text>`
  // does NOT bold when the parent `fontFamily` is `Figtree_400Regular`
  // and no 700-weight face is registered. (The app's `useFonts` loads
  // 400/500/600 — no 700 — so RN falls back silently to the same
  // regular face.) Resolve by setting `fontFamily` to the next-loaded
  // heavier face explicitly, which iOS picks up directly.
  //
  // SemiBold (600) is visually distinct enough from Regular for the
  // single-token entity emphasis the LLM uses (`**Acme Inc**`,
  // `**138/88**`). If product later wants true 700-weight bold,
  // register `Figtree_700Bold` in `_layout.tsx` useFonts() and swap
  // `fonts.sansSemibold` → `fonts.sansBold` here.
  bold: {
    fontFamily: fonts.sansSemibold,
  },
  italic: {
    // No Figtree italic face is registered. `fontStyle` on iOS RN
    // requires an italic face on the family, so this is effectively a
    // no-op today — italic spans render the same as plain text. Kept
    // so the tokenizer's italic token has a sink; render-time becomes
    // visible the moment an italic face is registered.
    fontStyle: 'italic',
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: 14,
  },
});

// Exported for unit tests.
export const __tokenizeForTest = tokenize;
