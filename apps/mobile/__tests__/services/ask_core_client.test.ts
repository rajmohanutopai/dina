/**
 * An agent's `dina ask` reads through Core, which decides every persona and
 * raises the owner's card. The phone hands the ask loop a hand-listed client, so
 * a method missing from that list drops the agent to the deny-all guard: no data
 * leaks, but no card appears and the agent can never read anything. Found on the
 * simulator by MRS-07.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { lazyCoreClient } from '../../src/services/boot_capabilities';

// What `asAgentReadClient` in @dina/brain's agentic_ask requires.
const AGENT_READ = [
  'agentPersonaAccessCheck',
  'agentPersonaAccessRequest',
  'vaultQuery',
  'vaultGet',
  'vaultList',
  'vaultItemsForPerson',
  'memoryToC',
] as const;

describe('the ask loop’s Core client on the phone', () => {
  it.each(AGENT_READ)('has %s, or agents fall to the deny-all guard', (method) => {
    expect(typeof (lazyCoreClient() as unknown as Record<string, unknown>)[method]).toBe(
      'function',
    );
  });

  it.each(AGENT_READ)('%s fails closed before boot', async (method) => {
    const call = (lazyCoreClient() as unknown as Record<string, () => Promise<unknown>>)[method];
    await expect(call?.()).rejects.toThrow(/not booted/);
  });
});

describe('every Core method the ask loop checks for is on the phone', () => {
  // agentic_ask registers a tool only when `typeof core.<method> === 'function'`.
  // A method this hand-listed client lacks silently drops the tool on the
  // phone while Jest and the web bed (full clients) still pass: "tell Sancho
  // …" answered "I can't send messages" on the simulator, 2026-11-08. Read the
  // checks from the source so a new tool cannot miss the phone again.
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'packages',
      'brain',
      'src',
      'composition',
      'agentic_ask.ts',
    ),
    'utf8',
  );
  const checked = [
    ...new Set([...source.matchAll(/typeof \w+\.(\w+) === 'function'/g)].map((m) => m[1] ?? '')),
  ];

  it('finds the checks', () => {
    expect(checked).toEqual(expect.arrayContaining(['talkSend', 'promisesList', 'vaultQuery']));
  });

  it.each(checked)('has %s', (method) => {
    expect(typeof (lazyCoreClient() as unknown as Record<string, unknown>)[method]).toBe(
      'function',
    );
  });

  it.each(checked)('%s fails closed before boot', async (method) => {
    const call = (lazyCoreClient() as unknown as Record<string, () => Promise<unknown>>)[method];
    await expect(call?.()).rejects.toThrow(/not booted/);
  });
});
