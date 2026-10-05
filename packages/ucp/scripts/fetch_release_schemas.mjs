#!/usr/bin/env node
/**
 * Fetch the published schemas of the pinned UCP release into a test fixture.
 *
 *   node scripts/fetch_release_schemas.mjs <path-to-ucp-spec-checkout>
 *
 * The spec's source schemas carry unversioned `$id`s; what a merchant's profile
 * points at, and what Dina fetches, are the published files under
 * `https://ucp.dev/<release>/schemas/`, with versioned `$id`s and absolute
 * versioned `$ref`s. This takes the list of files from the checkout's
 * `source/schemas`, fetches each published file, and writes it byte for byte to
 * __tests__/fixtures/schemas/<release>/<path>. Every file must answer 200 and
 * carry the `$id` of its own published URL.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: fetch_release_schemas.mjs <ucp-spec-checkout>');
  process.exit(2);
}
const release = execFileSync('git', ['-C', root, 'describe', '--tags', '--exact-match'], {
  encoding: 'utf8',
})
  .trim()
  .replace(/^v/, '');
const source = join(root, 'source', 'schemas');
const out = join(import.meta.dirname, '..', '__tests__', 'fixtures', 'schemas', release);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.json')) files.push(relative(source, path));
  }
};
walk(source);

for (const file of files) {
  const url = `https://ucp.dev/${release}/schemas/${file}`;
  const res = await fetch(url, { redirect: 'error' });
  if (res.status !== 200) throw new Error(`${url}: ${res.status}`);
  const text = await res.text();
  if (JSON.parse(text).$id !== url) throw new Error(`${url}: $id is not its own URL`);
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), text);
}
console.log(`${files.length} schemas of ${release} written to ${relative(process.cwd(), out)}`);
