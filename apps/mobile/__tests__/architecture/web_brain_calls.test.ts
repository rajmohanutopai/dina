/**
 * WEB_OWNER_SURFACE_PLAN §3.4 — the Core-served page reaches Brain
 * cross-origin, at the address the runtime config names.
 *
 * A module that calls Brain's `/api/...` with a bare `fetch` or
 * `new EventSource` sends it to the page's own origin, which is Core: it
 * 404s there (the first live run showed six of them). Every Brain call goes
 * through `brainFetch` / `brainEventStream` (`services/web_runtime.ts`), so
 * this scan fails on any production file that names an `/api/` path and
 * also calls `fetch(` or `new EventSource(` itself.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import ts from 'typescript';

interface Findings {
  namesApiPath: boolean;
  callsRaw: boolean;
}

/** Parse the file (comments are not code) and note `/api/` literals and raw calls. */
function scan(fileName: string, source: string): Findings {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: Findings = { namesApiPath: false, callsRaw: false };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node)) &&
      node.text.startsWith('/api/')
    ) {
      found.namesApiPath = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetch'
    ) {
      found.callsRaw = true;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'EventSource'
    ) {
      found.callsRaw = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('the web page reaches Brain only through the runtime-config helpers', () => {
  it('no production file names an /api/ path and calls fetch or EventSource itself', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      ...(await listTsFiles(join(root, 'app'))),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const found = scan(file, await readFile(file, 'utf8'));
      if (found.namesApiPath && found.callsRaw) offenders.push(relative(root, file));
    }
    expect(offenders).toEqual([]);
  });

  it('the scan sees what it must (self-check on known shapes)', () => {
    const flagged = (code: string): boolean => {
      const found = scan('x.ts', code);
      return found.namesApiPath && found.callsRaw;
    };
    expect(flagged("const BASE = '/api/v1/x';\nawait fetch(`${BASE}/y`);")).toBe(true);
    expect(flagged('await fetch(`/api/v1/x/${id}`);')).toBe(true);
    expect(flagged("new EventSource('/api/v1/stream');")).toBe(true);
    expect(
      flagged("if (web) return '/api/peerlens';\n// see `/api/peerlens/xrpc/*`\nawait fetch(url);"),
    ).toBe(true);
    expect(flagged("const BASE = '/api/v1/x';\nawait brainFetch(`${BASE}/y`);")).toBe(false);
    expect(
      flagged("// fetch('/api/v1/x') is how it used to work\nawait brainFetch('/api/v1/x');"),
    ).toBe(false);
    expect(flagged("await fetch('/v1/owner/setup/status');")).toBe(false);
  });
});
