/**
 * The app also runs in a browser, where React Native Web's `Alert.alert`
 * does nothing: no message shows, no button's `onPress` runs. A confirm
 * written with it never confirms on the web, and an error written with it is
 * never seen (the live web run found Save, validation errors and Delete on
 * the listing screens silently doing nothing).
 *
 * Screens say things through `showMessage`, ask yes/no through
 * `confirmDecision`, and offer a choice through `chooseAction`; each has a
 * `.web.ts` variant that uses the browser's own dialogs. Only those native
 * variants call `Alert.alert` directly.
 *
 * `NOT_YET_WEB_SAFE` lists the files that still do, with why. It may only
 * shrink: a new direct call fails this test, and so does converting a listed
 * file without removing it from the list.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import ts from 'typescript';

/** The native halves of the web-safe helpers: the one place Alert belongs. */
const HELPERS = new Set([
  'src/services/show_message.ts',
  'src/services/confirm_decision.ts',
  'src/services/choose_action.ts',
  'src/services/contact_action.ts',
]);

/**
 * Files still calling `Alert.alert`. Each needs more than a message or a
 * yes/no: a list of options (an in-page picker is the fix), or a screen that
 * does not run in a browser.
 */
const NOT_YET_WEB_SAFE = new Set([
  // Device sign-out, erase, backup export/restore: native file and keychain
  // flows the browser build does not offer.
  'app/admin.tsx',
  // Risk level per action: a pick among four levels.
  'app/policy.tsx',
  // Auto-lock timeout: a pick among several durations.
  'app/settings.tsx',
  // The guided demo's publish prompt (demo builds only).
  'src/guided_demo/providers.ts',
]);

/** Does the file call `Alert.alert(...)`? Comments are not code. */
function callsAlert(fileName: string, source: string): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Alert' &&
      node.expression.name.text === 'alert'
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
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

describe('dialogs work in the browser', () => {
  it('no screen calls Alert.alert outside the listed files and the helpers', async () => {
    const root = join(__dirname, '..', '..');
    const files = [
      ...(await listTsFiles(join(root, 'src'))),
      ...(await listTsFiles(join(root, 'app'))),
    ];
    const calling = new Set<string>();
    for (const file of files) {
      const rel = relative(root, file);
      if (callsAlert(rel, await readFile(file, 'utf8'))) calling.add(rel);
    }
    const unexpected = [...calling].filter((f) => !HELPERS.has(f) && !NOT_YET_WEB_SAFE.has(f));
    expect(unexpected).toEqual([]);
    // A listed file that no longer calls Alert must leave the list.
    const stale = [...NOT_YET_WEB_SAFE].filter((f) => !calling.has(f));
    expect(stale).toEqual([]);
  });

  it('the scan sees a call and ignores a comment', () => {
    expect(callsAlert('x.ts', "Alert.alert('Saved');")).toBe(true);
    expect(
      callsAlert('x.ts', "// Alert.alert('Saved') is a no-op on the web\nshowMessage('Saved');"),
    ).toBe(false);
  });
});
