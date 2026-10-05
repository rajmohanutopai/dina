#!/usr/bin/env node
/**
 * Harvest the UCP spec's own JSON examples into a test fixture.
 *
 *   node scripts/harvest_spec_examples.mjs <path-to-ucp-spec-checkout>
 *
 * Reads every ```json and ```http block under docs/specification (rendering the
 * `{{ ucp_version }}` macro as the site build does), keeps the
 * bodies that parse as JSON objects and carry a `ucp` member (directly, or as
 * an MCP `result.structuredContent`), and writes them with their source file,
 * line and the spec commit to __tests__/fixtures/spec_examples.json, followed by
 * the spec's complete response scaffolds (scripts/scaffolds/*_response.json).
 * Blocks that do not parse are counted by reason (the spec's `...` placeholders,
 * or other), not kept. Examples unwrapped from an MCP JSON-RPC answer are marked
 * `binding: "mcp"`.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: harvest_spec_examples.mjs <ucp-spec-checkout>');
  process.exit(2);
}
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tag = execFileSync('git', ['-C', root, 'describe', '--tags', '--exact-match'], {
  encoding: 'utf8',
}).trim();
const docs = join(root, 'docs', 'specification');
// The docs are mkdocs templates: `{{ ucp_version }}` is filled in from
// mkdocs.yml `extra.ucp_version` when the site is built; render it the same way.
const ucpVersion = /^\s*ucp_version:\s*"([^"]+)"/m.exec(
  readFileSync(join(root, 'mkdocs.yml'), 'utf8'),
)?.[1];
if (!ucpVersion) throw new Error('mkdocs.yml has no extra.ucp_version');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.md') ? [p] : [];
  });
}

const examples = [];
// Blocks that mention `ucp` but do not parse, by reason: the spec's `...`
// placeholders, or anything else. At v2026-08-25 "other" is the payment
// handler templates (`{handler_name}` holes) and embedded-checkout examples
// with comments; Dina reads neither.
const unparsed = { placeholder: 0, other: 0 };
for (const file of walk(docs).sort()) {
  const text = readFileSync(file, 'utf8');
  // Fences may be indented (inside mkdocs `=== "Request"` tabs); the closing
  // fence carries the same indentation as the opening one.
  const re = /^([ \t]*)```(json|http)\n([\s\S]*?)\n\1```/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const indent = m[1];
    let body = m[3]
      .split('\n')
      .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
      .join('\n')
      .replaceAll(/\{\{\s*ucp_version\s*\}\}/g, ucpVersion);
    // An HTTP message (in an `http` block, or a `json` block that starts with a
    // request or status line): the JSON is the body after the blank line.
    if (m[2] === 'http' || /^(HTTP\/1\.1 \d{3}|[A-Z]+ \S+ HTTP\/1\.1)/.test(body)) {
      const split = body.indexOf('\n\n');
      if (split < 0) continue;
      body = body.slice(split + 2);
    }
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      if (body.includes('"ucp"')) unparsed[body.includes('...') ? 'placeholder' : 'other']++;
      continue;
    }
    const mcp = value?.result?.structuredContent;
    const inner = mcp ?? value;
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner) || !('ucp' in inner))
      continue;
    const line = text.slice(0, m.index).split('\n').length;
    // The spec marks each example with `<!-- ucp:example schema=… def=… extract=… -->`;
    // `extract` names the part that is meant (the rest is surrounding fragment).
    const before = text.slice(0, m.index).trimEnd().split('\n').pop() ?? '';
    const tag = /^<!--\s*ucp:example\s+(.*?)\s*-->$/.exec(before.trim());
    const annotation = tag
      ? Object.fromEntries([...tag[1].matchAll(/(\w+)=(\S+)/g)].map((a) => [a[1], a[2]]))
      : undefined;
    examples.push({
      source: `${relative(docs, file)}:${line}`,
      ...(mcp !== undefined ? { binding: 'mcp' } : {}),
      ...(annotation ? { annotation } : {}),
      value: inner,
    });
  }
}
const scaffolds = join(root, 'scripts', 'scaffolds');
for (const name of readdirSync(scaffolds).sort()) {
  // Response scaffolds, including suffixed ones (`…_response_get_product.json`).
  if (!/_response(_[a-z_]+)?\.json$/.test(name)) continue;
  const value = JSON.parse(readFileSync(join(scaffolds, name), 'utf8'));
  // A type scaffold (an order line item, say) is not a response body.
  if (value !== null && typeof value === 'object' && 'ucp' in value)
    examples.push({ source: `scaffolds/${name}`, value });
}
const out = {
  spec: { tag, commit, ucp_version: ucpVersion },
  unparsed_with_ucp: unparsed,
  examples,
};
writeFileSync(
  new URL('../__tests__/fixtures/spec_examples.json', import.meta.url),
  JSON.stringify(out, null, 1) + '\n',
);
console.log(`${examples.length} examples; unparsed: ${unparsed.placeholder} with placeholders, ${unparsed.other} other`);
