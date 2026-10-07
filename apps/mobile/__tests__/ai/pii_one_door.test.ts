/**
 * One door (docs/PII_ARCHITECTURE_V2.md §2.1, §3): on the phone a raw model
 * adapter is built only as the router's backend. Features get
 * `createScrubbedLLMProvider`; two PeerLens features once took the raw one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

function uses(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'app'))]) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*\*/.test(code)) return;
      if (pattern.test(code)) hits.push(path.relative(ROOT, file));
    });
  }
  return [...new Set(hits)].sort();
}

describe('the raw model adapter is built only as the router backend', () => {
  it('createLLMProvider is called only where the router backend is built', () => {
    expect(uses(/\bcreateLLMProvider\(/)).toEqual([
      'src/ai/agentic_swap.ts',
      'src/ai/provider.ts',
      'src/services/boot_capabilities.ts',
    ]);
  });

  it('nothing calls a model directly except the fixed "OK" probe (dual review F1)', () => {
    // brain_wiring once sent chat text through generateText with its own scrub.
    expect(uses(/\b(generateText|generateObject|streamText)\(/)).toEqual([
      'src/components/ModelPickerSheet.tsx',
    ]);
    expect(uses(/\bcreateModel\(/)).toEqual([
      'src/ai/provider.ts',
      'src/components/ModelPickerSheet.tsx',
    ]);
  });

  it('adapters are constructed only in provider.ts', () => {
    expect(uses(/new (AISDKAdapter|GeminiGenaiAdapter)\(/)).toEqual(['src/ai/provider.ts']);
  });
});
