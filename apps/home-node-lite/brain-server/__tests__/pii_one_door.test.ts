/**
 * One door (docs/PII_ARCHITECTURE_V2.md §2.1, §3): on the server the raw
 * model adapter goes only behind the router. A consumer handed
 * `configuredLLMRuntime.llm` would send text unscrubbed — the remember loop,
 * capability runtime and internal-Brain worker all once did.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('the raw model adapter goes only behind the router', () => {
  it('every `<runtime>.llm` read feeds routedProvider', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/\b(configuredLLMRuntime|askRuntime|llmRuntime)[?!]?\.llm\b/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
        if (!window.includes('routedProvider('))
          offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the remember loop, capability runtime and internal-Brain worker take the routed provider', () => {
    const boot = fs.readFileSync(path.join(SRC, 'boot.ts'), 'utf8');
    expect(boot).toMatch(/buildRememberRuntime\(\{\s*llm: scrubbedLLM,/);
    expect(boot).toMatch(/getLLM: \(\) => scrubbedLLM \?\? null/);
    expect(boot).toMatch(/createProviderReasoningLLM\(scrubbedLLM\)/);
  });
});
